/**
 * Meta Webhooks — Instagram object (story/post @mentions of the brand).
 *
 * GET  → subscription verification handshake (hub.mode / hub.verify_token / hub.challenge)
 * POST → signed notifications. We only act on the `mentions` field: Meta
 *        sends { media_id } (plus comment_id for comment mentions). We fetch the
 *        mentioned media through the brand's own IG id (mentioned_media), store
 *        it as MetaMedia/MetaStoryMention with the creator as igUsername and the
 *        brand handle in mentions, and materialize it into every campaign whose
 *        rules it satisfies. This is how a creator's STORY mentioning @vileda.es
 *        reaches the campaign in real time and for free (no Apify).
 *
 * Env: META_APP_SECRET (signature), META_WEBHOOK_VERIFY_TOKEN (handshake).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
import { getMentionedMedia } from '@/lib/meta-api'
import { materializeMetaContent, listCampaignsForMaterialize } from '@/lib/meta-materialize'

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
}

interface WebhookChange {
  field?: string
  value?: { media_id?: string; comment_id?: string; [k: string]: unknown }
}
interface WebhookEntry {
  id?: string
  time?: number
  changes?: WebhookChange[]
}

function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const received = Buffer.from(header.slice(7), 'hex')
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest()
  if (received.length !== expected.length) return false
  try { return timingSafeEqual(received, expected) } catch { return false }
}

export async function POST(request: NextRequest) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) return NextResponse.json({ error: 'META_APP_SECRET not configured' }, { status: 500 })

  const rawBody = await request.text()
  if (!verifySignature(rawBody, request.headers.get('x-hub-signature-256'), appSecret)) {
    console.warn('[Meta/Webhook] invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: { object?: string; entry?: WebhookEntry[] }
  try { payload = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }
  if (payload.object !== 'instagram') return NextResponse.json({ ok: true, ignored: payload.object })

  let handled = 0
  const touchedTokenUsers = new Set<string>()
  for (const entry of payload.entry ?? []) {
    const igId = entry.id
    if (!igId) continue
    for (const change of entry.changes ?? []) {
      if (change.field !== 'mentions') continue
      const mediaId = change.value?.media_id
      if (!mediaId) continue
      try {
        const token = await prisma.socialToken.findFirst({
          where: { platform: 'INSTAGRAM', tokenType: 'brand', isValid: true, platformUserId: igId },
        })
        if (!token) { console.warn(`[Meta/Webhook] mention for unknown IG id ${igId}`); continue }
        const snap = await prisma.metaAccountSnapshot.findFirst({
          where: { socialTokenId: token.id }, orderBy: { capturedAt: 'desc' }, select: { igUsername: true },
        })
        const brandHandle = (snap?.igUsername || '').toLowerCase().replace(/^@/, '')
        const pageToken = decrypt(token.accessToken)
        const media = await getMentionedMedia(igId, pageToken, mediaId)
        if (!media) { console.warn(`[Meta/Webhook] mentioned_media ${mediaId} not readable`); continue }
        const creator = (media.username || '').toLowerCase().replace(/^@/, '')
        if (!creator) continue
        const postedAt = media.timestamp ? new Date(media.timestamp) : new Date()
        const mediaType = (media.media_type || 'STORY').toUpperCase()

        await prisma.metaMedia.upsert({
          where: { socialTokenId_igMediaId: { socialTokenId: token.id, igMediaId: media.id } },
          create: {
            socialTokenId: token.id,
            igMediaId: media.id,
            mediaType,
            igUsername: creator,
            caption: media.caption ?? null,
            mediaUrl: media.media_url ?? null,
            thumbnailUrl: media.media_url ?? null,
            permalink: mediaType === 'STORY' ? `https://www.instagram.com/stories/${creator}/` : null,
            postedAt,
            likeCount: media.like_count ?? 0,
            commentsCount: media.comments_count ?? 0,
            lastSyncedAt: new Date(),
          },
          update: {
            igUsername: creator,
            caption: media.caption ?? null,
            mediaUrl: media.media_url ?? null,
            postedAt,
            lastSyncedAt: new Date(),
          },
        })
        await prisma.metaStoryMention.upsert({
          where: { socialTokenId_mentionMediaId: { socialTokenId: token.id, mentionMediaId: media.id } },
          create: { socialTokenId: token.id, mentionMediaId: media.id, mentionUsername: creator, mentionedAt: postedAt },
          update: { mentionUsername: creator, mentionedAt: postedAt },
        })
        handled++
        if (token.userId) touchedTokenUsers.add(token.userId)
        console.log(`[Meta/Webhook] @${creator} mentioned @${brandHandle} in ${mediaType} ${media.id}`)
      } catch (err) {
        console.error('[Meta/Webhook] mention handling failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  // Attribute right away: the mention only counts in campaigns where the
  // creator is a member, the date is inside the window and the brand is a target.
  if (handled > 0) {
    try {
      const campaignIds = await listCampaignsForMaterialize()
      for (const id of campaignIds) {
        await materializeMetaContent(id).catch(err => console.error(`[Meta/Webhook] materialize ${id} failed:`, err instanceof Error ? err.message : err))
      }
    } catch (err) {
      console.error('[Meta/Webhook] materialize pass failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ ok: true, handled })
}

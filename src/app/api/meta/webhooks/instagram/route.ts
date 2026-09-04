/**
 * Meta Webhooks — Instagram object.
 *
 * GET  → subscription verification handshake (hub.mode / hub.verify_token / hub.challenge)
 * POST → signed notifications. What we act on:
 *
 *   • `messaging[]` entries whose message carries a `story_mention` attachment
 *     (Instagram Messaging webhook, field `messages`): a creator @mentioned the
 *     brand in a STORY. Meta gives the story CDN url and the creator's IGSID;
 *     we resolve the username, store a STORY MetaMedia row (creator as
 *     igUsername, url only — Meta forbids caching the media itself) and
 *     attribute it to the campaigns where the creator is a member, the date is
 *     inside the window and the brand is a target. This is the ONLY real-time
 *     story path: `mentioned_media` says "Mentions on Stories are not supported".
 *
 *   • `changes[]` with field `mentions` (caption/comment @mentions on feed
 *     posts): IGNORED on purpose. Comment mentions are written by anyone (not
 *     the post owner) and would let any Instagram user inject a member's post
 *     into a campaign; caption mentions of members are already captured by the
 *     Apify profile pass and cannot be deduped here (mentioned_media has no
 *     permalink). Logged only.
 *
 * Meta wants a fast 2xx and retries otherwise, so the response is sent right
 * after signature verification and the work runs in `after()`.
 *
 * Env: META_APP_SECRET (signature), META_WEBHOOK_VERIFY_TOKEN (handshake).
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
import { getIgsidProfile } from '@/lib/meta-api'
import { materializeMetaContent } from '@/lib/meta-materialize'

export const dynamic = 'force-dynamic'

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

interface StoryMentionEvent {
  brandIgId: string
  senderIgsid: string
  messageId: string
  storyUrl: string
  timestamp: Date
}

interface WebhookEntry {
  id?: string
  time?: number
  changes?: Array<{ field?: string; value?: { media_id?: string; comment_id?: string } }>
  messaging?: Array<{
    sender?: { id?: string }
    recipient?: { id?: string }
    timestamp?: number
    message?: {
      mid?: string
      is_echo?: boolean
      attachments?: Array<{ type?: string; payload?: { url?: string } }>
    }
  }>
}

function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  let received: Buffer
  try { received = Buffer.from(header.slice(7), 'hex') } catch { return false }
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest()
  if (received.length !== expected.length) return false
  try { return timingSafeEqual(received, expected) } catch { return false }
}

function extractStoryMentions(entries: WebhookEntry[]): StoryMentionEvent[] {
  const out: StoryMentionEvent[] = []
  for (const entry of entries) {
    for (const m of entry.messaging ?? []) {
      if (m.message?.is_echo) continue // our own outgoing messages
      const brandIgId = m.recipient?.id || entry.id
      const senderIgsid = m.sender?.id
      const mid = m.message?.mid
      if (!brandIgId || !senderIgsid || !mid) continue
      for (const a of m.message?.attachments ?? []) {
        if (a.type !== 'story_mention' || !a.payload?.url) continue
        out.push({
          brandIgId,
          senderIgsid,
          messageId: mid,
          storyUrl: a.payload.url,
          timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
        })
      }
    }
  }
  return out
}

async function handleStoryMention(ev: StoryMentionEvent): Promise<void> {
  const token = await prisma.socialToken.findFirst({
    where: { platform: 'INSTAGRAM', tokenType: 'brand', isValid: true, platformUserId: ev.brandIgId },
  })
  if (!token) { console.warn(`[Meta/Webhook] story mention for unknown brand IG id ${ev.brandIgId}`); return }
  const pageToken = decrypt(token.accessToken)

  // Resolving the sender needs instagram_manage_messages. Connections made
  // before that scope existed cannot do it: keep the raw event as a PENDING
  // mention (resolved by meta-sync once the brand reconnects) and flag the
  // connection so Integrations shows "reconnect required" instead of silently
  // dropping the story.
  const hasMessagesScope = token.scopes.includes('instagram_manage_messages')
  const profile = hasMessagesScope ? await getIgsidProfile(ev.senderIgsid, pageToken) : null
  const creator = (profile?.username || '').toLowerCase().replace(/^@/, '')
  if (!creator) {
    const reason = hasMessagesScope ? 'sender profile not readable (private account?)' : 'connection lacks instagram_manage_messages — reconnect the brand account'
    console.warn(`[Meta/Webhook] could not resolve username for IGSID ${ev.senderIgsid}: ${reason}`)
    await prisma.metaStoryMention.upsert({
      where: { socialTokenId_mentionMediaId: { socialTokenId: token.id, mentionMediaId: `story_mention_${ev.messageId}` } },
      create: { socialTokenId: token.id, mentionMediaId: `story_mention_${ev.messageId}`, mentionUsername: `igsid:${ev.senderIgsid}`, mentionedAt: ev.timestamp },
      update: { mentionedAt: ev.timestamp },
    }).catch(() => {})
    if (!hasMessagesScope) {
      await prisma.socialToken.update({
        where: { id: token.id },
        data: { lastError: 'Story mentions received but instagram_manage_messages is missing — reconnect this account (Ajustes → Integraciones → Volver a conectar)' },
      }).catch(() => {})
    }
    return
  }

  // Only creators we know (members of some campaign) are worth a row; the
  // attribution below re-checks membership per campaign anyway.
  const influencer = await prisma.influencer.findFirst({
    where: { platform: 'INSTAGRAM', username: { equals: creator, mode: 'insensitive' } },
    select: { id: true },
  })
  if (!influencer) { console.log(`[Meta/Webhook] @${creator} mentioned the brand in a story but is not in the database — ignored`); return }

  const igMediaId = `story_mention_${ev.messageId}`
  await prisma.metaMedia.upsert({
    where: { socialTokenId_igMediaId: { socialTokenId: token.id, igMediaId } },
    create: {
      socialTokenId: token.id,
      igMediaId,
      mediaType: 'STORY',
      igUsername: creator,
      caption: null,
      mediaUrl: ev.storyUrl,
      thumbnailUrl: ev.storyUrl,
      permalink: `https://www.instagram.com/stories/${creator}/`,
      postedAt: ev.timestamp,
      likeCount: 0,
      commentsCount: 0,
      lastSyncedAt: new Date(),
    },
    update: { igUsername: creator, mediaUrl: ev.storyUrl, thumbnailUrl: ev.storyUrl, postedAt: ev.timestamp, lastSyncedAt: new Date() },
  })
  await prisma.metaStoryMention.upsert({
    where: { socialTokenId_mentionMediaId: { socialTokenId: token.id, mentionMediaId: igMediaId } },
    create: { socialTokenId: token.id, mentionMediaId: igMediaId, mentionUsername: creator, mentionedAt: ev.timestamp, matchedCreatorId: influencer.id },
    update: { mentionUsername: creator, mentionedAt: ev.timestamp, matchedCreatorId: influencer.id },
  })

  // Attribute only in the campaigns this creator belongs to (rules re-checked inside).
  const memberships = await prisma.campaignInfluencer.findMany({
    where: { influencerId: influencer.id, campaign: { status: 'ACTIVE' } },
    select: { campaignId: true },
  })
  let created = 0
  for (const { campaignId } of memberships) {
    try {
      const r = await materializeMetaContent(campaignId)
      created += r.created
    } catch (err) {
      console.error(`[Meta/Webhook] materialize ${campaignId} failed:`, err instanceof Error ? err.message : err)
    }
  }
  console.log(`[Meta/Webhook] story mention by @${creator} → ${memberships.length} campaign(s) checked, ${created} row(s) created`)
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

  const entries = payload.entry ?? []
  const storyMentions = extractStoryMentions(entries)
  const ignoredMentionChanges = entries.reduce((n, e) => n + (e.changes ?? []).filter(c => c.field === 'mentions').length, 0)
  if (ignoredMentionChanges > 0) {
    console.log(`[Meta/Webhook] ${ignoredMentionChanges} feed/comment mention change(s) ignored (not attributed by design)`)
  }

  if (storyMentions.length > 0) {
    after(async () => {
      for (const ev of storyMentions) {
        try { await handleStoryMention(ev) } catch (err) {
          console.error('[Meta/Webhook] story mention failed:', err instanceof Error ? err.message : err)
        }
      }
    })
  }

  return NextResponse.json({ ok: true, storyMentions: storyMentions.length, ignored: ignoredMentionChanges })
}

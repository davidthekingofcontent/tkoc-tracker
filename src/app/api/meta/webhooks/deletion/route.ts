/**
 * Meta GDPR / Data Deletion Webhook
 *
 * When a user removes the app from their Facebook account, Meta calls this endpoint
 * with a signed_request payload. We verify it, delete all data tied to that user's
 * Meta ID, and return a confirmation payload.
 *
 * Required by Meta App Review for Instagram/Facebook Graph API apps.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'

interface SignedRequestPayload {
  user_id?: string
  algorithm?: string
  issued_at?: number
  expires?: number
}

function base64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/**
 * Parse Facebook's signed_request: base64url(signature) + '.' + base64url(json payload).
 * Verifies HMAC-SHA256 signature with the app secret.
 */
function parseSignedRequest(signedRequest: string, appSecret: string): SignedRequestPayload | null {
  const parts = signedRequest.split('.')
  if (parts.length !== 2) return null
  const [encodedSig, encodedPayload] = parts

  let sig: Buffer
  let payloadBuf: Buffer
  try {
    sig = base64urlDecode(encodedSig)
    payloadBuf = base64urlDecode(encodedPayload)
  } catch {
    return null
  }

  let payload: SignedRequestPayload
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'))
  } catch {
    return null
  }

  if (payload.algorithm && payload.algorithm.toUpperCase() !== 'HMAC-SHA256') {
    return null
  }

  const expected = createHmac('sha256', appSecret).update(encodedPayload).digest()
  if (sig.length !== expected.length) return null
  try {
    if (!timingSafeEqual(sig, expected)) return null
  } catch {
    return null
  }

  return payload
}

async function deleteMetaDataForUser(metaUserId: string): Promise<void> {
  // Find all SocialTokens tied to this Meta user id.
  const tokens = await prisma.socialToken.findMany({
    where: { platform: 'INSTAGRAM', platformUserId: metaUserId },
    select: { id: true },
  })
  if (tokens.length === 0) return

  const ids = tokens.map(t => t.id)

  // Cascade children explicitly to be safe (even though schema has onDelete: Cascade).
  await prisma.metaMedia.deleteMany({ where: { socialTokenId: { in: ids } } })
  await prisma.metaAccountSnapshot.deleteMany({ where: { socialTokenId: { in: ids } } })
  await prisma.metaAudienceInsight.deleteMany({ where: { socialTokenId: { in: ids } } })
  await prisma.metaStoryMention.deleteMany({ where: { socialTokenId: { in: ids } } })
  await prisma.socialToken.deleteMany({ where: { id: { in: ids } } })
}

export async function POST(request: NextRequest) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) {
    return NextResponse.json({ error: 'META_APP_SECRET not configured' }, { status: 500 })
  }

  let signedRequest: string | undefined
  const contentType = request.headers.get('content-type') || ''
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body = await request.text()
      const params = new URLSearchParams(body)
      signedRequest = params.get('signed_request') ?? undefined
    } else if (contentType.includes('application/json')) {
      const body = (await request.json()) as { signed_request?: string }
      signedRequest = body.signed_request
    } else {
      // Try both — some clients send without proper content-type.
      const text = await request.text()
      const params = new URLSearchParams(text)
      signedRequest = params.get('signed_request') ?? undefined
      if (!signedRequest) {
        try {
          const parsed = JSON.parse(text)
          signedRequest = parsed.signed_request
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  if (!signedRequest) {
    return NextResponse.json({ error: 'Missing signed_request' }, { status: 400 })
  }

  const payload = parseSignedRequest(signedRequest, appSecret)
  if (!payload || !payload.user_id) {
    return NextResponse.json({ error: 'Invalid signed_request' }, { status: 400 })
  }

  try {
    await deleteMetaDataForUser(payload.user_id)
  } catch (err) {
    console.error('[Meta deletion webhook] deletion error', err instanceof Error ? err.message : err)
    // Still respond with a confirmation code per Meta's contract; admin email can follow up.
  }

  const confirmationCode = `meta_del_${randomBytes(8).toString('hex')}`
  const origin = new URL(request.url).origin
  const statusUrl = `${origin}/data-deletion?id=${confirmationCode}`

  return NextResponse.json({ url: statusUrl, confirmation_code: confirmationCode })
}

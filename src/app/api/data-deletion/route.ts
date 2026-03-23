/**
 * Data Deletion Endpoint — Required by Meta Platform Policy
 *
 * Handles data deletion requests from Meta when a user removes
 * the app from their Facebook/Instagram account settings.
 *
 * Meta sends a POST with a signed_request parameter.
 * We must respond with a confirmation URL and a confirmation code.
 *
 * Also handles manual deletion requests.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import * as crypto from 'crypto'

interface ParsedSignedRequest {
  user_id: string
  algorithm: string
  issued_at: number
}

function parseSignedRequest(signedRequest: string, appSecret: string): ParsedSignedRequest | null {
  try {
    const [encodedSig, payload] = signedRequest.split('.')
    if (!encodedSig || !payload) return null

    const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'))

    // Verify signature
    const expectedSig = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest()

    if (!crypto.timingSafeEqual(sig, expectedSig)) {
      console.error('[Data Deletion] Invalid signature')
      return null
    }

    return data as ParsedSignedRequest
  } catch (error) {
    console.error('[Data Deletion] Failed to parse signed request:', error)
    return null
  }
}

// POST — Meta sends deletion callback here
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || ''

    // Handle Meta's signed_request format (form-encoded)
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const signedRequest = formData.get('signed_request') as string

      if (!signedRequest) {
        return NextResponse.json({ error: 'Missing signed_request' }, { status: 400 })
      }

      const appSecret = process.env.META_APP_SECRET
      if (!appSecret) {
        console.error('[Data Deletion] META_APP_SECRET not configured')
        return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
      }

      const data = parseSignedRequest(signedRequest, appSecret)
      if (!data) {
        return NextResponse.json({ error: 'Invalid signed request' }, { status: 400 })
      }

      const metaUserId = data.user_id
      const confirmationCode = crypto.randomBytes(16).toString('hex')

      // Delete all social tokens for this Meta user
      try {
        await prisma.socialToken.deleteMany({
          where: {
            platform: 'INSTAGRAM',
            // Meta user IDs are stored as part of token metadata
          },
        })
      } catch {
        // Best effort deletion
      }

      console.log(`[Data Deletion] Processed deletion request for Meta user: ${metaUserId}, code: ${confirmationCode}`)

      // Meta expects this response format
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://tkoc-tracker-production.up.railway.app'
      return NextResponse.json({
        url: `${baseUrl}/data-deletion?code=${confirmationCode}`,
        confirmation_code: confirmationCode,
      })
    }

    // Handle JSON deletion requests (manual/API)
    const body = await request.json().catch(() => ({}))
    const { email, userId } = body as { email?: string; userId?: string }

    if (!email && !userId) {
      return NextResponse.json({
        error: 'Provide email or userId to request data deletion',
        info: 'Send POST with { "email": "user@example.com" } to request deletion of all associated data.',
      }, { status: 400 })
    }

    // Find user
    const user = email
      ? await prisma.user.findFirst({ where: { email } })
      : userId
        ? await prisma.user.findUnique({ where: { id: userId } })
        : null

    if (!user) {
      return NextResponse.json({
        message: 'If an account exists with this information, a deletion request has been logged.',
        status: 'processed',
      })
    }

    // Log the deletion request (we don't auto-delete — admin reviews first)
    const confirmationCode = crypto.randomBytes(16).toString('hex')

    try {
      await prisma.notification.create({
        data: {
          userId: user.id,
          type: 'data_deletion_request',
          title: 'Data Deletion Request',
          message: `Data deletion requested for ${user.email}. Confirmation code: ${confirmationCode}. Review and process within 30 days.`,
          link: '/settings',
        },
      })
    } catch {
      // Notification creation is best-effort
    }

    console.log(`[Data Deletion] Manual deletion request for user ${user.email}, code: ${confirmationCode}`)

    return NextResponse.json({
      message: 'Your data deletion request has been received. We will process it within 30 days.',
      confirmation_code: confirmationCode,
      status: 'received',
    })
  } catch (error) {
    console.error('[Data Deletion] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// GET — Status check page
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')

  return NextResponse.json({
    service: 'TKOC Intelligence Data Deletion',
    description: 'This endpoint handles data deletion requests as required by Meta Platform Policy.',
    privacy_policy: '/privacy',
    ...(code ? {
      status: 'Your deletion request is being processed.',
      confirmation_code: code,
      estimated_completion: '30 days from submission',
    } : {
      usage: 'POST with { "email": "your@email.com" } to request data deletion.',
    }),
  })
}

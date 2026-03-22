/**
 * YouTube Analytics OAuth Initiation
 * Redirects to Google OAuth dialog to connect a YouTube channel.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getGoogleAuthUrl } from '@/lib/youtube-analytics'
import { verifyToken } from '@/lib/auth'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('auth-token')?.value
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const payload = verifyToken(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const clientId = process.env.GOOGLE_CLIENT_ID
    if (!clientId) {
      return NextResponse.json({ error: 'GOOGLE_CLIENT_ID not configured' }, { status: 500 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const redirectUri = `${baseUrl}/api/auth/youtube/callback`

    // Get influencer ID from query if provided
    const influencerId = request.nextUrl.searchParams.get('influencer_id') || ''

    const state = JSON.stringify({ userId: payload.userId, influencerId })
    const encodedState = Buffer.from(state).toString('base64')

    const authUrl = getGoogleAuthUrl(clientId, redirectUri, encodedState)

    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('[YouTube OAuth] Initiation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

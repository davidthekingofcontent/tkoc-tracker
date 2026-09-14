/**
 * YouTube Analytics OAuth Initiation
 * Redirects to Google OAuth dialog to connect a YouTube channel.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getGoogleAuthUrl } from '@/lib/youtube-analytics'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    // Session from the 'token' cookie / Authorization header (the app never
    // issued an 'auth-token' cookie, so this route always answered 401).
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // /api/auth is on the BRAND edge whitelist: connecting a Meta/YouTube
    // account (and the SocialToken the callback persists) is agency-only.
    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const clientId = process.env.GOOGLE_CLIENT_ID
    if (!clientId) {
      return NextResponse.json({ error: 'GOOGLE_CLIENT_ID not configured' }, { status: 500 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const redirectUri = `${baseUrl}/api/auth/youtube/callback`

    // Get influencer ID from query if provided
    const influencerId = request.nextUrl.searchParams.get('influencer_id') || ''

    const state = JSON.stringify({ userId: session.id, influencerId })
    const encodedState = Buffer.from(state).toString('base64')

    const authUrl = getGoogleAuthUrl(clientId, redirectUri, encodedState)

    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('[YouTube OAuth] Initiation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

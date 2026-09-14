/**
 * Meta OAuth Initiation
 * Redirects user to Facebook OAuth dialog to connect their IG Business Account.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthorizationUrl } from '@/lib/instagram-api'
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

    const appId = process.env.META_APP_ID
    if (!appId) {
      return NextResponse.json({ error: 'META_APP_ID not configured' }, { status: 500 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const redirectUri = `${baseUrl}/api/auth/meta/callback`

    // State contains the user ID for the callback
    const state = JSON.stringify({ userId: session.id })
    const encodedState = Buffer.from(state).toString('base64')

    const authUrl = getAuthorizationUrl(appId, redirectUri, encodedState)

    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('[Meta OAuth] Initiation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Meta OAuth Initiation
 * Redirects user to Facebook OAuth dialog to connect their IG Business Account.
 */

import { NextResponse } from 'next/server'
import { getAuthorizationUrl } from '@/lib/instagram-api'
import { verifyToken } from '@/lib/auth'
import { cookies } from 'next/headers'

export async function GET() {
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

    const appId = process.env.META_APP_ID
    if (!appId) {
      return NextResponse.json({ error: 'META_APP_ID not configured' }, { status: 500 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const redirectUri = `${baseUrl}/api/auth/meta/callback`

    // State contains the user ID for the callback
    const state = JSON.stringify({ userId: payload.userId })
    const encodedState = Buffer.from(state).toString('base64')

    const authUrl = getAuthorizationUrl(appId, redirectUri, encodedState)

    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('[Meta OAuth] Initiation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

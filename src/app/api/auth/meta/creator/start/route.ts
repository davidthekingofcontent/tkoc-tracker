/**
 * Meta OAuth — Creator flow start
 * Public endpoint (no session). Takes an invitation ?token=xxx and kicks off OAuth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  buildAuthorizeUrl,
  encodeMetaState,
  getBaseUrl,
  META_STATE_COOKIE,
  META_STATE_COOKIE_MAX_AGE,
} from '@/lib/meta-oauth'

const CREATOR_SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'pages_show_list',
]

export async function GET(request: NextRequest) {
  const invitationToken = request.nextUrl.searchParams.get('token')
  if (!invitationToken) {
    return NextResponse.json({ error: 'Missing invitation token' }, { status: 400 })
  }

  // Validate invitation exists & is not expired / already accepted.
  const invitation = await prisma.invitation.findUnique({
    where: { token: invitationToken },
  })
  if (!invitation) {
    return NextResponse.json({ error: 'Invalid invitation token' }, { status: 404 })
  }
  if (invitation.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invitation expired' }, { status: 410 })
  }

  const appId = process.env.META_APP_ID
  if (!appId) {
    return NextResponse.json({ error: 'META_APP_ID not configured' }, { status: 500 })
  }

  const base = getBaseUrl(request)
  const redirectUri = `${base}/api/auth/meta/creator/callback`

  const { cookieValue, nonce } = encodeMetaState({
    kind: 'creator',
    invitationToken,
    redirectUri,
  })

  const authUrl = buildAuthorizeUrl({
    appId,
    redirectUri,
    state: nonce,
    scopes: CREATOR_SCOPES,
  })

  const response = NextResponse.redirect(authUrl)
  response.cookies.set(META_STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: META_STATE_COOKIE_MAX_AGE,
  })
  return response
}

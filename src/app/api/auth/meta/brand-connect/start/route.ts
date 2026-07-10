/**
 * Meta OAuth — Brand Connect flow start (session-less)
 * Public endpoint: takes the signed invite JWT (?token=xxx), verifies it
 * (signature + purpose + expiry) and kicks off the Facebook OAuth dialog
 * with the same scopes as the authenticated brand flow.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyBrandConnectToken } from '@/lib/brand-connect'
import {
  buildAuthorizeUrl,
  encodeMetaState,
  getBaseUrl,
  META_STATE_COOKIE,
  META_STATE_COOKIE_MAX_AGE,
} from '@/lib/meta-oauth'

const BRAND_SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
]

export async function GET(request: NextRequest) {
  const inviteToken = request.nextUrl.searchParams.get('token')
  const base = getBaseUrl(request)

  if (!inviteToken) {
    return NextResponse.json({ error: 'Missing invite token' }, { status: 400 })
  }

  // Verify invite JWT: signature, expiry (jwt.verify) and purpose claim.
  const invite = verifyBrandConnectToken(inviteToken)
  if (!invite) {
    return NextResponse.redirect(
      `${base}/brand-connect/${encodeURIComponent(inviteToken)}?error=invalid_token`
    )
  }

  const appId = process.env.META_APP_ID
  if (!appId) {
    return NextResponse.redirect(
      `${base}/brand-connect/${encodeURIComponent(inviteToken)}?error=not_configured`
    )
  }

  const redirectUri = `${base}/api/auth/meta/brand-connect/callback`

  const { cookieValue, nonce } = encodeMetaState({
    kind: 'brand_connect',
    invitationToken: inviteToken,
    redirectUri,
  })

  const authUrl = buildAuthorizeUrl({
    appId,
    redirectUri,
    state: nonce,
    scopes: BRAND_SCOPES,
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

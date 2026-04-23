/**
 * Meta OAuth — Brand flow start
 * Auth required. Generates signed state cookie and redirects to Facebook OAuth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
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
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const appId = process.env.META_APP_ID
  if (!appId) {
    return NextResponse.json({ error: 'META_APP_ID not configured' }, { status: 500 })
  }

  const base = getBaseUrl(request)
  const redirectUri = `${base}/api/auth/meta/brand/callback`

  const { cookieValue, nonce } = encodeMetaState({
    kind: 'brand',
    userId: session.id,
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

import { NextResponse } from 'next/server'

/**
 * POST /api/auth/logout — ends the session on this device.
 *
 * The session cookie is HttpOnly, so the old client-side
 * `document.cookie = 'token=; max-age=0'` never removed it: after "logging
 * out" the next visit was still signed in for up to 7 days. Only the server
 * can clear an HttpOnly cookie. Public on purpose: clearing a cookie needs
 * no session and must work with an expired one.
 */
export async function POST() {
  const response = NextResponse.json({ success: true })
  response.cookies.set('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  })
  return response
}

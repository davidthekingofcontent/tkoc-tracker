import { NextRequest, NextResponse } from 'next/server'

const publicPaths = [
  '/login',
  '/privacy',
  '/privacy/es',
  '/terms',
  '/terms/es',
  '/data-deletion',
  '/api/auth/login',
  '/api/auth/register',
  '/api/seed',
  '/api/data-deletion',
]

function isPublicPath(pathname: string): boolean {
  // Exact matches for public paths
  if (publicPaths.includes(pathname)) return true

  // Invitation accept pages and creator registration
  if (pathname.startsWith('/invite/')) return true
  if (pathname.startsWith('/creators/register')) return true
  if (pathname.startsWith('/creators/connect')) return true

  // Brand connect landing (public 1-click IG connect for brands)
  if (pathname.startsWith('/brand-connect')) return true

  // Static assets, Next.js internals, and ALL API routes
  // (API routes handle their own authentication via getSession)
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/images') ||
    pathname.startsWith('/api/') ||
    pathname.endsWith('.txt') ||
    pathname.endsWith('.json') ||
    pathname.endsWith('.js') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.ico') ||
    pathname === '/capture.js' ||
    pathname.startsWith('/sw.js')
  ) {
    return true
  }

  return false
}

// API prefixes a BRAND user may call. Everything else under /api/ is 403 for
// BRAND at the edge (and again enforced per-route via getSession).
// '/api/proxy' is required: every portal avatar/thumbnail/logo is rewritten
// through /api/proxy/image (unauthenticated, read-only, CDN-allowlisted).
const brandApiWhitelist = [
  '/api/auth',
  '/api/portal',
  '/api/notifications',
  '/api/proxy',
  // Public-purpose invitation endpoint: an already-logged-in BRAND user
  // opening an invite link must not get a Forbidden instead of the page.
  '/api/invite',
]

// API prefixes a CREATOR user may call. Everything else under /api/ is 403
// for CREATOR at the edge. Until 12 Nov 2026 a creator session was not
// confined at all: the internal routes only special-case EMPLOYEE and BRAND,
// so a creator (and creators can self-register) could read every campaign
// with its fees, every creator's e-mail and phone, and change or delete
// them. Exact sub-paths only where the parent lists other people's data
// (/api/influencers/invite returns every pending invitation and its token).
const creatorApiWhitelist = [
  // Only the auth routes a creator needs: the rest of /api/auth holds the
  // agency's own Meta and YouTube connection flows
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/me',
  '/api/auth/password',
  '/api/auth/logout',
  '/api/auth/meta/creator',
  '/api/dashboard/creator',
  '/api/notifications',
  '/api/proxy',
  '/api/invite',
  '/api/influencers/invite/validate',
  '/api/influencers/invite/accept',
]

// Pages a CREATOR may open besides the public ones. The creator view lives
// inside /dashboard (the page swaps to the creator dashboard by role).
const creatorPages = ['/', '/dashboard']

/**
 * Base64-decode the JWT payload WITHOUT signature verification.
 * jsonwebtoken does not run on the edge; an unverified decode is safe here
 * because it is only used for DENY-ONLY decisions (a forged role claim still
 * fails real verification at route level via getSession). Never use this to
 * GRANT elevated access.
 */
function decodeRoleUnverified(token: string): string | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded))
    return typeof payload?.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Mirror getSession's token precedence (src/lib/auth.ts): the Authorization
  // header is read FIRST, the cookie is only a fallback. Reading only the
  // cookie here would let a BRAND user bypass the edge confinement by
  // replaying their JWT via `Authorization: Bearer` with no cookie.
  const authHeader = request.headers.get('Authorization')
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined
  const cookieToken = request.cookies.get('token')?.value
  const token = headerToken || cookieToken

  // Deny-only: confine the request if ANY presented token claims BRAND,
  // regardless of which one getSession would end up verifying.
  const headerRole = headerToken ? decodeRoleUnverified(headerToken) : null
  const cookieRole = cookieToken ? decodeRoleUnverified(cookieToken) : null
  const isBrand = headerRole === 'BRAND' || cookieRole === 'BRAND'
  const isCreator = headerRole === 'CREATOR' || cookieRole === 'CREATOR'

  // BRAND users are confined to the portal + a small API whitelist
  // (defense in depth — real enforcement lives in the route handlers).
  if (isBrand) {
    if (pathname.startsWith('/api/')) {
      const allowed = brandApiWhitelist.some(
        (prefix) => pathname === prefix || pathname.startsWith(prefix + '/')
      )
      if (!allowed) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      return NextResponse.next()
    }

    // Non-API navigation: allow public pages/assets and the portal itself,
    // send everything else to /portal.
    if (isPublicPath(pathname)) {
      return NextResponse.next()
    }
    if (pathname === '/portal' || pathname.startsWith('/portal/')) {
      return NextResponse.next()
    }
    return NextResponse.redirect(new URL('/portal', request.url))
  }

  // CREATOR users are confined to their own dashboard + a small API whitelist
  // (deny-only, same reasoning as BRAND above).
  if (isCreator) {
    if (pathname.startsWith('/api/')) {
      const allowed =
        creatorApiWhitelist.some(
          (prefix) => pathname === prefix || pathname.startsWith(prefix + '/')
        ) ||
        // Profile pictures are public by design (session-less route)
        /^\/api\/influencers\/[a-z0-9]{10,40}\/avatar$/i.test(pathname)
      if (!allowed) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      return NextResponse.next()
    }
    if (isPublicPath(pathname) || creatorPages.includes(pathname)) {
      return NextResponse.next()
    }
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  if (!token) {
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}

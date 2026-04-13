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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  const token = request.cookies.get('token')?.value

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

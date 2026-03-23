import { NextRequest, NextResponse } from 'next/server'

const publicPaths = [
  '/login',
  '/privacy',
  '/terms',
  '/data-deletion',
  '/api/auth/login',
  '/api/auth/register',
  '/api/seed',
  '/api/data-deletion',
]

function isPublicPath(pathname: string): boolean {
  // Exact matches for public paths
  if (publicPaths.includes(pathname)) return true

  // Invitation accept pages
  if (pathname.startsWith('/invite/')) return true

  // Static assets, Next.js internals, and ALL API routes
  // (API routes handle their own authentication via getSession)
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/images') ||
    pathname.startsWith('/api/')
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

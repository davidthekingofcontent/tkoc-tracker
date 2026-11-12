import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyPassword, generateToken } from '@/lib/auth'
import { canProceed, clientIp } from '@/lib/rate-limiter'

/** Brute-force brake: attempts per address and per account in a 15-minute window. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_PER_IP = 40
const LOGIN_MAX_PER_PAIR = 12

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password } = body

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    if (email.length > 254 || password.length > 200) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    // The tight limit is per address AND account: a third party hammering
    // someone's e-mail from elsewhere cannot lock that person out
    const ip = clientIp(request.headers)
    if (
      !canProceed(`login:ip:${ip}`, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS) ||
      !canProceed(`login:pair:${ip}:${email.trim().toLowerCase()}`, LOGIN_MAX_PER_PAIR, LOGIN_WINDOW_MS)
    ) {
      return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 })
    }

    // Exact match first (invited accounts keep the address as it was typed);
    // then ignoring case, because self-registered accounts are stored in
    // lowercase and nobody remembers which capitals they used
    const typed = email.trim()
    let user = await prisma.user.findUnique({ where: { email: typed } })
    if (!user) {
      // "insensitive" is ILIKE in PostgreSQL, where _ and % are wildcards:
      // the candidates are compared again in code, exactly
      const candidates = await prisma.user.findMany({
        where: { email: { equals: typed, mode: 'insensitive' } },
        orderBy: { createdAt: 'asc' },
      })
      user = candidates.find(u => u.email.toLowerCase() === typed.toLowerCase()) ?? null
    }
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    if (!user.isActive) {
      return NextResponse.json(
        { error: 'Account is deactivated' },
        { status: 403 }
      )
    }

    const valid = await verifyPassword(password, user.password)
    if (!valid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    const token = generateToken(user.id, user.role)

    const { password: _pw, ...userData } = user

    const response = NextResponse.json({ user: userData, token })
    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

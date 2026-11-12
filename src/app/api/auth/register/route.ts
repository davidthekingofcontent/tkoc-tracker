import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashPassword, generateToken } from '@/lib/auth'
import { UserRole } from '@/generated/prisma/client'
import { canProceed, clientIp } from '@/lib/rate-limiter'

/**
 * PUBLIC self-registration. It can ONLY create CREATOR accounts.
 *
 * Until 12 Nov 2026 the role came from the request body (default EMPLOYEE),
 * so anyone on the internet could POST { role: 'ADMIN' } and receive an
 * administrator session. Staff and brand accounts are created by invitation
 * only (/api/invite/[token]); the body's `role` is now ignored.
 */
const REGISTER_MAX_PER_HOUR = 5

export async function POST(request: NextRequest) {
  try {
    // Public endpoint: at most a handful of accounts per address and hour
    if (!canProceed(`register:${clientIp(request.headers)}`, REGISTER_MAX_PER_HOUR, 60 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
    }

    const body = await request.json()
    const { password, name,
      creatorUsername, creatorPlatform, creatorBio, creatorCategory,
      portfolioUrl, creatorFollowers, creatorCountry, creatorCity,
      creatorType, creatorLanguages,
    } = body

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''

    if (!email || !password || !name || typeof password !== 'string' || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Email, password, and name are required' },
        { status: 400 }
      )
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 6 || password.length > 200 || name.trim().length > 120) {
      return NextResponse.json({ error: 'Invalid email, name or password' }, { status: 400 })
    }

    // Case-insensitive: Ana@x.com and ana@x.com are the same person
    // ("insensitive" is ILIKE, where _ and % are wildcards: compare again in code)
    const sameAddress = await prisma.user.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, select: { email: true } })
    const existing = sameAddress.some(u => u.email.toLowerCase() === email)
    if (existing) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 }
      )
    }

    const hashedPassword = await hashPassword(password)

    // Always a creator: this endpoint creates nothing else
    const creatorData = {
      creatorUsername: creatorUsername || null,
      creatorPlatform: creatorPlatform || null,
      creatorBio: creatorBio || null,
      creatorCategory: creatorCategory || null,
      portfolioUrl: portfolioUrl || null,
      creatorFollowers: creatorFollowers ? parseInt(creatorFollowers) : null,
      creatorCountry: creatorCountry || null,
      creatorCity: creatorCity || null,
      creatorType: creatorType || null,
      creatorLanguages: Array.isArray(creatorLanguages) ? creatorLanguages.filter((l: unknown) => typeof l === 'string').slice(0, 20) : [],
      isVerified: false,
    }

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name.trim(),
        role: UserRole.CREATOR,
        ...creatorData,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar: true,
        brandName: true,
        isActive: true,
        createdAt: true,
      },
    })

    const token = generateToken(user.id, user.role)

    const response = NextResponse.json({ user, token }, { status: 201 })
    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Register error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

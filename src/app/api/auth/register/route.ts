import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashPassword, generateToken } from '@/lib/auth'
import { UserRole } from '@/generated/prisma/client'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password, name, role,
      creatorUsername, creatorPlatform, creatorBio, creatorCategory,
      portfolioUrl, creatorFollowers, creatorCountry, creatorCity,
      creatorType, creatorLanguages,
    } = body

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: 'Email, password, and name are required' },
        { status: 400 }
      )
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 }
      )
    }

    const hashedPassword = await hashPassword(password)

    // Build creator fields if role is CREATOR
    const isCreator = role === 'CREATOR'
    const creatorData = isCreator ? {
      creatorUsername: creatorUsername || null,
      creatorPlatform: creatorPlatform || null,
      creatorBio: creatorBio || null,
      creatorCategory: creatorCategory || null,
      portfolioUrl: portfolioUrl || null,
      creatorFollowers: creatorFollowers ? parseInt(creatorFollowers) : null,
      creatorCountry: creatorCountry || null,
      creatorCity: creatorCity || null,
      creatorType: creatorType || null,
      creatorLanguages: creatorLanguages || [],
      isVerified: false,
    } : {}

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: role && Object.values(UserRole).includes(role) ? role : UserRole.EMPLOYEE,
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

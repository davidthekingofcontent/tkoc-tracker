import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { generateToken } from '@/lib/auth'

// GET - Validate token and return invitation info
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { user: { select: { name: true } } },
  })

  if (!invitation) {
    return NextResponse.json({ error: 'Invalid invitation' }, { status: 404 })
  }

  if (invitation.accepted) {
    return NextResponse.json({ error: 'Invitation already accepted' }, { status: 410 })
  }

  if (new Date() > invitation.expiresAt) {
    return NextResponse.json({ error: 'Invitation has expired' }, { status: 410 })
  }

  return NextResponse.json({
    email: invitation.email,
    role: invitation.role,
    invitedBy: invitation.user.name,
    expiresAt: invitation.expiresAt,
  })
}

// POST - Accept invitation and create account
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const { name, password } = await request.json()

  if (!name || !password) {
    return NextResponse.json({ error: 'Name and password are required' }, { status: 400 })
  }

  if (password.length < 6) {
    return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
  }

  const invitation = await prisma.invitation.findUnique({ where: { token } })

  if (!invitation) {
    return NextResponse.json({ error: 'Invalid invitation' }, { status: 404 })
  }

  if (invitation.accepted) {
    return NextResponse.json({ error: 'Invitation already accepted' }, { status: 410 })
  }

  if (new Date() > invitation.expiresAt) {
    return NextResponse.json({ error: 'Invitation has expired' }, { status: 410 })
  }

  // Check if email already taken
  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } })
  if (existingUser) {
    return NextResponse.json({ error: 'Account already exists for this email' }, { status: 409 })
  }

  // Create user
  const hashedPassword = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({
    data: {
      email: invitation.email,
      password: hashedPassword,
      name,
      role: invitation.role,
    },
  })

  // Mark invitation as accepted
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { accepted: true },
  })

  // Generate auth token
  const authToken = generateToken(user.id, user.role)

  return NextResponse.json({
    message: 'Account created successfully',
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    token: authToken,
  })
}

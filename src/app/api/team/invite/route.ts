import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { sendInvitationEmail } from '@/lib/email'
import crypto from 'crypto'

// GET - List all team members + pending invitations
export async function GET(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only admins can see team
  const currentUser = await prisma.user.findUnique({ where: { id: session.id } })
  if (!currentUser || currentUser.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [users, invitations] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, avatar: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.invitation.findMany({
      where: { accepted: false, expiresAt: { gt: new Date() } },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return NextResponse.json({ users, invitations })
}

// POST - Send invitation
export async function POST(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const currentUser = await prisma.user.findUnique({ where: { id: session.id } })
  if (!currentUser || currentUser.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { email, role, locale } = await request.json()

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({ where: { email } })
  if (existingUser) {
    return NextResponse.json({ error: 'User with this email already exists' }, { status: 409 })
  }

  // Check if there's already a pending invitation
  const existingInvitation = await prisma.invitation.findFirst({
    where: { email, accepted: false, expiresAt: { gt: new Date() } },
  })
  if (existingInvitation) {
    return NextResponse.json({ error: 'Invitation already sent to this email' }, { status: 409 })
  }

  // Create invitation
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

  const invitation = await prisma.invitation.create({
    data: {
      email,
      role: role || 'EMPLOYEE',
      token,
      expiresAt,
      invitedBy: session.id,
    },
  })

  // Send email
  try {
    await sendInvitationEmail({
      to: email,
      inviterName: currentUser.name,
      role: role || 'EMPLOYEE',
      token,
      locale: locale || 'es',
    })
  } catch (err) {
    // Delete invitation if email fails
    await prisma.invitation.delete({ where: { id: invitation.id } })
    console.error('Email send error:', err)
    return NextResponse.json({ error: 'Failed to send invitation email' }, { status: 500 })
  }

  return NextResponse.json({ invitation, message: 'Invitation sent successfully' })
}

// DELETE - Revoke invitation
export async function DELETE(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const currentUser = await prisma.user.findUnique({ where: { id: session.id } })
  if (!currentUser || currentUser.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const invitationId = searchParams.get('id')

  if (!invitationId) {
    return NextResponse.json({ error: 'Invitation ID is required' }, { status: 400 })
  }

  await prisma.invitation.delete({ where: { id: invitationId } })

  return NextResponse.json({ message: 'Invitation revoked' })
}

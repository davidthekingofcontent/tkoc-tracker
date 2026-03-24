import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// POST - Mark an influencer invitation as accepted
export async function POST(request: NextRequest) {
  const { token } = await request.json()

  if (!token) {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 })
  }

  const invitation = await prisma.invitation.findUnique({
    where: { token },
  })

  if (!invitation) {
    return NextResponse.json({ error: 'Invalid invitation' }, { status: 404 })
  }

  if (invitation.accepted) {
    return NextResponse.json({ message: 'Already accepted' })
  }

  if (invitation.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invitation expired' }, { status: 410 })
  }

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { accepted: true },
  })

  return NextResponse.json({ message: 'Invitation accepted' })
}

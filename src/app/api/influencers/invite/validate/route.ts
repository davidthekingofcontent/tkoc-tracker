import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// GET - Validate an influencer invitation token
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')

  if (!token) {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 })
  }

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

  if (invitation.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invitation expired' }, { status: 410 })
  }

  // No campaignName stored on the Invitation model, but we return what we can
  return NextResponse.json({
    email: invitation.email,
    campaignName: null,
    inviterName: invitation.user?.name || null,
  })
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { sendInfluencerInviteEmail } from '@/lib/email'
import crypto from 'crypto'

// GET - List pending influencer invitations for a campaign
export async function GET(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const campaignId = searchParams.get('campaignId')

  if (!campaignId) {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })
  }

  const invitations = await prisma.invitation.findMany({
    where: {
      role: 'CREATOR',
      accepted: false,
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ invitations })
}

// POST - Send invitation to an influencer
export async function POST(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const currentUser = await prisma.user.findUnique({ where: { id: session.id } })
  if (!currentUser) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Only ADMIN and EMPLOYEE can invite (not BRAND)
  if (currentUser.role !== 'ADMIN' && currentUser.role !== 'EMPLOYEE') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { email, influencerId, campaignId, locale } = await request.json()

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  // Get campaign name if campaignId provided
  let campaignName = 'TKOC Intelligence'
  if (campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { name: true },
    })
    if (campaign) {
      campaignName = campaign.name
    }
  }

  // Check if there's already a pending CREATOR invitation for this email
  const existingInvitation = await prisma.invitation.findFirst({
    where: { email, role: 'CREATOR', accepted: false, expiresAt: { gt: new Date() } },
  })
  if (existingInvitation) {
    return NextResponse.json({ error: 'Invitation already sent to this email' }, { status: 409 })
  }

  // Create invitation with CREATOR role
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

  const invitation = await prisma.invitation.create({
    data: {
      email,
      role: 'CREATOR',
      token,
      expiresAt,
      invitedBy: session.id,
    },
  })

  // Send email
  try {
    await sendInfluencerInviteEmail({
      to: email,
      inviterName: currentUser.name,
      campaignName,
      token,
      locale: locale || 'es',
    })
  } catch (err) {
    // Delete invitation if email fails
    await prisma.invitation.delete({ where: { id: invitation.id } })
    console.error('Influencer invite email send error:', err)
    return NextResponse.json({ error: 'Failed to send invitation email' }, { status: 500 })
  }

  return NextResponse.json({ invitation, message: 'Invitation sent successfully' })
}

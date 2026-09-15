import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { createNotification } from '@/lib/notifications'

/**
 * Campaign team (who has access).
 *
 * The team of a campaign = its creator (Campaign.userId) + the users with a
 * campaign_assignments row. Being on the team makes the campaign appear in
 * the PM's list (GET /api/campaigns) AND subscribes them to its notifications
 * (David, 2026-09-15). Roles do not define the team: several PMs are ADMIN.
 *
 * Who can change it: an ADMIN or the campaign creator. Read: any staff.
 */

const STAFF_ROLES = ['ADMIN', 'EMPLOYEE'] as const

const userSelect = { id: true, name: true, email: true, role: true } as const

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSession>>>

function isStaff(session: SessionUser | null): session is SessionUser {
  return !!session && (STAFF_ROLES as readonly string[]).includes(session.role)
}

function canManage(session: SessionUser, campaign: { userId: string }): boolean {
  return session.role === 'ADMIN' || session.id === campaign.userId
}

async function loadCampaign(id: string) {
  return prisma.campaign.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      userId: true,
      user: { select: { id: true, name: true } },
    },
  })
}

// GET - The campaign team (owner + assigned users) and the staff that can be added
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isStaff(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const campaign = await loadCampaign(id)
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  const [assignments, staff] = await Promise.all([
    prisma.campaignAssignment.findMany({
      where: { campaignId: id },
      select: { id: true, userId: true, user: { select: userSelect } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findMany({
      where: { role: { in: [...STAFF_ROLES] }, isActive: true },
      select: userSelect,
      orderBy: { name: 'asc' },
    }),
  ])

  // Owner always first, even without an assignment row (access comes from Campaign.userId)
  const ownerRow = assignments.find(a => a.userId === campaign.userId)
  const owner = ownerRow?.user ?? (await prisma.user.findUnique({ where: { id: campaign.userId }, select: userSelect }))

  const members: Array<{
    id: string
    name: string
    email: string
    role: string
    isOwner: boolean
    assignmentId: string | null
  }> = []
  const seen = new Set<string>()

  if (owner) {
    members.push({ ...owner, isOwner: true, assignmentId: ownerRow?.id ?? null })
    seen.add(owner.id)
  }
  for (const a of assignments) {
    if (seen.has(a.userId)) continue
    seen.add(a.userId)
    members.push({ ...a.user, isOwner: false, assignmentId: a.id })
  }

  return NextResponse.json({
    ownerId: campaign.userId,
    owner: campaign.user ? { id: campaign.user.id, name: campaign.user.name } : null,
    canManage: canManage(session, campaign),
    members,
    staff,
  })
}

// POST { userId } - Give a staff user access to this campaign (ADMIN or creator)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isStaff(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const campaign = await loadCampaign(id)
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }
  if (!canManage(session, campaign)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let userId: unknown
  try {
    ;({ userId } = await request.json())
  } catch {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }
  if (typeof userId !== 'string' || !userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...userSelect, isActive: true },
  })
  if (!target || !target.isActive || !(STAFF_ROLES as readonly string[]).includes(target.role)) {
    return NextResponse.json({ error: 'userId must be an active ADMIN or EMPLOYEE' }, { status: 400 })
  }

  // Idempotent: an existing row is returned as-is (no duplicate notification)
  const existing = await prisma.campaignAssignment.findUnique({
    where: { campaignId_userId: { campaignId: id, userId } },
    include: { user: { select: userSelect } },
  })
  if (existing) {
    return NextResponse.json({ assignment: existing, created: false }, { status: 200 })
  }

  const assignment = await prisma.campaignAssignment.create({
    data: { campaignId: id, userId },
    include: { user: { select: userSelect } },
  })

  // The grant itself tells the PM (not when someone adds themselves)
  if (userId !== session.id) {
    await createNotification({
      userId,
      type: 'campaign_access',
      title: 'Acceso a campaña',
      message: `${session.name} te ha dado acceso a la campaña "${campaign.name}"`,
      link: `/campaigns/${id}`,
    })
  }

  return NextResponse.json({ assignment, created: true }, { status: 201 })
}

// DELETE ?userId= - Remove a user's access to this campaign (ADMIN or creator)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isStaff(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const campaign = await loadCampaign(id)
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }
  if (!canManage(session, campaign)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const userId = searchParams.get('userId')
  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  // Deleting the owner's own row is allowed but harmless: the creator keeps
  // access (list + notifications) through Campaign.userId, not through this table.
  const result = await prisma.campaignAssignment.deleteMany({
    where: { campaignId: id, userId },
  })

  return NextResponse.json({ message: 'Unassigned successfully', removed: result.count })
}

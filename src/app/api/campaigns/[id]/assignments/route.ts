import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// GET - List users assigned to this campaign
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const assignments = await prisma.campaignAssignment.findMany({
    where: { campaignId: id },
    include: {
      user: { select: { id: true, name: true, email: true, role: true, avatar: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Also get all employees for the assign dropdown
  const employees = await prisma.user.findMany({
    where: { role: 'EMPLOYEE', isActive: true },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({ assignments, employees })
}

// POST - Assign a user to this campaign (ADMIN only)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session || session.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const { userId } = await request.json()

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  // Check if already assigned
  const existing = await prisma.campaignAssignment.findUnique({
    where: { campaignId_userId: { campaignId: id, userId } },
  })
  if (existing) {
    return NextResponse.json({ error: 'Already assigned' }, { status: 409 })
  }

  const assignment = await prisma.campaignAssignment.create({
    data: { campaignId: id, userId },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
    },
  })

  return NextResponse.json({ assignment }, { status: 201 })
}

// DELETE - Unassign a user from this campaign (ADMIN only)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session || session.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const { searchParams } = new URL(request.url)
  const userId = searchParams.get('userId')

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  await prisma.campaignAssignment.deleteMany({
    where: { campaignId: id, userId },
  })

  return NextResponse.json({ message: 'Unassigned successfully' })
}

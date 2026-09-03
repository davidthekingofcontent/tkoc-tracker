import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * POST /api/admin/backfill-contacts — ADMIN only.
 *
 * For the session user, creates a Contact (status 'new') for every Influencer
 * that is a member of any of their campaigns or lists and has no Contact yet.
 * Idempotent: running it twice creates nothing the second time.
 *
 * Returns { created, scanned, alreadyHad }.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const userId = session.id

    const [campaignMembers, listMembers, existingContacts] = await Promise.all([
      prisma.campaignInfluencer.findMany({
        where: { campaign: { userId } },
        select: { influencerId: true },
        distinct: ['influencerId'],
      }),
      prisma.listItem.findMany({
        where: { list: { userId } },
        select: { influencerId: true },
        distinct: ['influencerId'],
      }),
      prisma.contact.findMany({
        where: { userId },
        select: { influencerId: true },
      }),
    ])

    const memberIds = new Set<string>()
    for (const m of campaignMembers) memberIds.add(m.influencerId)
    for (const m of listMembers) memberIds.add(m.influencerId)

    const haveContact = new Set(existingContacts.map((c) => c.influencerId))
    const missing = [...memberIds].filter((id) => !haveContact.has(id))

    let created = 0
    if (missing.length > 0) {
      const result = await prisma.contact.createMany({
        data: missing.map((influencerId) => ({ influencerId, userId, status: 'new' })),
        skipDuplicates: true,
      })
      created = result.count
    }

    return NextResponse.json({
      created,
      scanned: memberIds.size,
      alreadyHad: memberIds.size - missing.length,
    })
  } catch (error) {
    console.error('Backfill contacts error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

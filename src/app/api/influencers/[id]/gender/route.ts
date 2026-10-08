/**
 * Staff (ADMIN/EMPLOYEE): set or clear the gender of a creator by hand.
 *
 * PATCH /api/influencers/[id]/gender  body { gender: 'F' | 'M' | 'X' | null }
 *   - 'F' | 'M' | 'X' → Influencer.gender = value, genderSource = 'manual'
 *   - null            → both cleared (the next backfill may infer it again)
 *   Mirrored onto every CreatorProfile linked through
 *   creator_platform_profiles.influencerId (a manual value always wins).
 *   Returns { id, gender, genderSource }. 400 on any other value, 404 when
 *   the influencer does not exist.
 *
 * Values contract: src/lib/gender.ts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { isValidGender, type Gender, type GenderSource } from '@/lib/gender'

const STAFF_ROLES = new Set(['ADMIN', 'EMPLOYEE'])

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!STAFF_ROLES.has(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { id } = await params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (typeof body !== 'object' || body === null || !('gender' in body)) {
      return NextResponse.json({ error: "Body must be { gender: 'F' | 'M' | 'X' | null }" }, { status: 400 })
    }
    const raw = (body as { gender: unknown }).gender
    if (raw !== null && !isValidGender(raw)) {
      return NextResponse.json({ error: "gender must be 'F', 'M', 'X' or null" }, { status: 400 })
    }

    const gender: Gender | null = raw
    const genderSource: GenderSource | null = gender ? 'manual' : null

    const existing = await prisma.influencer.findUnique({ where: { id }, select: { id: true } })
    if (!existing) return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })

    const links = await prisma.creatorPlatformProfile.findMany({
      where: { influencerId: id },
      select: { creatorId: true },
    })
    const creatorIds = Array.from(new Set(links.map(l => l.creatorId)))

    await prisma.$transaction([
      prisma.influencer.update({ where: { id }, data: { gender, genderSource } }),
      ...(creatorIds.length
        ? [prisma.creatorProfile.updateMany({ where: { id: { in: creatorIds } }, data: { gender, genderSource } })]
        : []),
    ])

    return NextResponse.json({ id, gender, genderSource })
  } catch (error) {
    console.error('Update influencer gender error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

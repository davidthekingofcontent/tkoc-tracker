import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { saveContactAddress } from '@/lib/contacts'

/**
 * POST /api/admin/backfill-contact-addresses — ADMIN only.
 *
 * One-off helper for the addresses typed before Contacts could store them
 * (David 2026-09-08). For every influencer with a shipping address on some
 * campaign member, takes the one from the most recent campaign (startDate,
 * then the member row's updatedAt as tiebreaker — the member has no address
 * timestamp of its own) and copies it into the Contact of the campaign owner
 * (campaign.userId) — but
 * only when that Contact has no address yet. Existing addresses are never
 * overwritten, so running it twice writes nothing the second time.
 *
 * Returns { scanned, influencers, copied, alreadyHad, failed }.
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

    const members = await prisma.campaignInfluencer.findMany({
      where: { shippingAddress1: { not: null } },
      orderBy: [{ campaign: { startDate: 'desc' } }, { updatedAt: 'desc' }],
      select: {
        influencerId: true,
        updatedAt: true,
        shippingName: true,
        shippingAddress1: true,
        shippingAddress2: true,
        shippingCity: true,
        shippingPostCode: true,
        shippingCountry: true,
        shippingPhone: true,
        shippingEmail: true,
        campaign: { select: { userId: true, startDate: true } },
      },
    })

    // Most recent non-empty address per influencer (the list is already ordered
    // by campaign startDate desc, then member updatedAt desc).
    const latest = new Map<string, (typeof members)[number]>()
    for (const m of members) {
      if (!m.shippingAddress1 || !m.shippingAddress1.trim()) continue
      if (!latest.has(m.influencerId)) latest.set(m.influencerId, m)
    }

    let copied = 0
    let alreadyHad = 0
    let failed = 0

    for (const [influencerId, m] of latest) {
      const userId = m.campaign.userId
      const existing = await prisma.contact.findUnique({
        where: { influencerId_userId: { influencerId, userId } },
        select: { address1: true },
      })
      if (existing?.address1 && existing.address1.trim()) {
        alreadyHad++
        continue
      }
      const ok = await saveContactAddress(
        influencerId,
        userId,
        {
          name: m.shippingName,
          address1: m.shippingAddress1 as string,
          address2: m.shippingAddress2,
          city: m.shippingCity,
          postCode: m.shippingPostCode,
          country: m.shippingCountry,
          phone: m.shippingPhone,
          email: m.shippingEmail,
        },
        'shipping'
      )
      if (ok) {
        // Best available approximation of when the address was typed: the member
        // row has no address timestamp, and updatedAt moves with ANY member edit
        // (status, fee, notes…), so this date may be later than the typing itself.
        // Still closer to the truth than "now".
        await prisma.contact.update({
          where: { influencerId_userId: { influencerId, userId } },
          data: { addressUpdatedAt: m.updatedAt },
        }).catch(() => {})
        copied++
      } else {
        failed++
      }
    }

    return NextResponse.json({
      scanned: members.length,
      influencers: latest.size,
      copied,
      alreadyHad,
      failed,
    })
  } catch (error) {
    console.error('Backfill contact addresses error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

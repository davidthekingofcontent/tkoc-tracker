import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { latestContactAddress } from '@/lib/contacts'

/**
 * GET /api/contacts/address?influencerId=… — staff only (ADMIN/EMPLOYEE).
 *
 * Returns the most recently saved postal address for a creator across the
 * whole agency's Contacts, so the shipping modal of a new campaign can be
 * prefilled. Brand users never see creators' postal data.
 *
 * Response: { address: {...} | null, updatedAt: ISO | null, source: 'shipping' | 'manual' | null }
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const influencerId = request.nextUrl.searchParams.get('influencerId')?.trim()
    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    const latest = await latestContactAddress(influencerId)
    if (!latest) {
      return NextResponse.json({ address: null, updatedAt: null, source: null })
    }

    return NextResponse.json({
      address: latest.address,
      updatedAt: latest.updatedAt.toISOString(),
      source: latest.source,
    })
  } catch (error) {
    console.error('Contact address error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

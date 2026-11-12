import { NextRequest, NextResponse } from 'next/server'
import { getSession, isStaffRole } from '@/lib/auth'
import { isApifyConfigured } from '@/lib/apify'

// GET - check current configuration status
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!isStaffRole(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // No part of the key itself is returned (it used to send its first 8 characters)
    return NextResponse.json({
      apifyConfigured: isApifyConfigured(),
      apifyKeyHint: null,
    })
  } catch (error) {
    console.error('Settings error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

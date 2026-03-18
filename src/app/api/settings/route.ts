import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { isApifyConfigured } from '@/lib/apify'

// GET - check current configuration status
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    return NextResponse.json({
      apifyConfigured: isApifyConfigured(),
      apifyKeyHint: process.env.APIFY_API_KEY
        ? `${process.env.APIFY_API_KEY.slice(0, 8)}...`
        : null,
    })
  } catch (error) {
    console.error('Settings error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { findLookalikes, LookalikeInputError } from '@/lib/lookalikes'

// ---------------------------------------------------------------------------
// POST /api/creators/lookalikes — the "Similares" page.
// Body: { handle?: string; platform?: string; creatorId?: string }
// The engine lives in src/lib/lookalikes.ts; this handler only does auth,
// parsing and error mapping.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as {
      handle?: string
      platform?: string
      creatorId?: string
    }

    const result = await findLookalikes({
      handle: typeof body.handle === 'string' ? body.handle : undefined,
      platform: typeof body.platform === 'string' ? body.platform : undefined,
      creatorId: typeof body.creatorId === 'string' ? body.creatorId : undefined,
    })

    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof LookalikeInputError) {
      return NextResponse.json(
        {
          error: error.message,
          detectedPlatform: error.detectedPlatform,
          platformSource: error.platformSource,
        },
        { status: 400 }
      )
    }
    console.error('[Lookalikes] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

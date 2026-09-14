import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { findLookalikes, LookalikeInputError } from '@/lib/lookalikes'

// ---------------------------------------------------------------------------
// GET /api/influencers/[id]/lookalikes — "Similares" from Analizar Perfil.
// Same engine as /api/creators/lookalikes (src/lib/lookalikes.ts); the
// influencer is materialized into the creator pool on the way, so no Apify
// call happens for an existing influencer.
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const result = await findLookalikes({ influencerId: id })

    if (!result.source) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    return NextResponse.json({
      source: {
        id,
        username: result.source.username,
        platform: result.source.platform,
        followers: result.source.followers,
        engagementRate: result.source.engagementRate,
      },
      lookalikes: result.lookalikes.map((item) => ({
        id: item.influencerId ?? item.id,
        influencerId: item.influencerId,
        creatorId: item.id,
        username: item.username,
        displayName: item.displayName,
        avatarUrl: item.avatarUrl,
        platform: item.platform,
        followers: item.followers,
        engagementRate: item.engagementRate,
        avgLikes: item.avgLikes,
        avgComments: item.avgComments,
        avgViews: item.avgViews,
        email: item.email,
        matchScore: item.matchScore,
        matchReasons: item.matchReasons,
        topical: item.topical,
      })),
    })
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

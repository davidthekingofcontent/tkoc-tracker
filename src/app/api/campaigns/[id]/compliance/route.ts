import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

/** Ad disclosure markers to search for in captions */
const AD_MARKERS = [
  '#ad',
  '#publi',
  '#publicidad',
  '#sponsored',
  '#colaboración',
  '#colaboracion',
  '#collab',
  'partnership',
  'paid partnership',
  'colaboración pagada',
  'colaboracion pagada',
]

/**
 * Check if a caption contains ad disclosure markers.
 */
function hasAdDisclosure(caption: string | null): boolean {
  if (!caption) return false
  const lower = caption.toLowerCase()
  return AD_MARKERS.some(marker => lower.includes(marker))
}

/**
 * GET /api/campaigns/[id]/compliance
 * Returns compliance information for a campaign.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        paymentType: true,
        media: {
          include: {
            influencer: {
              select: { id: true, username: true, displayName: true, platform: true },
            },
          },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // BRAND users can only view their own campaigns
    if (session.role === 'BRAND') {
      const fullCampaign = await prisma.campaign.findUnique({
        where: { id },
        select: { userId: true },
      })
      if (fullCampaign && fullCampaign.userId !== session.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const allPosts = campaign.media
    const totalPosts = allPosts.length

    // Deleted posts
    const deletedPosts = allPosts.filter(p => p.isDeleted)

    // Undisclosed ads: if campaign is PAID, all posts should have ad disclosure
    const undisclosedAds = campaign.paymentType === 'PAID'
      ? allPosts.filter(p => !p.isDeleted && !hasAdDisclosure(p.caption))
      : []

    // Calculate compliance score
    let score = 100
    if (totalPosts > 0) {
      const issueCount = deletedPosts.length + undisclosedAds.length
      score = Math.max(0, Math.round(((totalPosts - issueCount) / totalPosts) * 100))
    }

    const compliant = deletedPosts.length === 0 && undisclosedAds.length === 0

    return NextResponse.json({
      totalPosts,
      deletedPosts: {
        count: deletedPosts.length,
        posts: deletedPosts,
      },
      undisclosedAds: {
        count: undisclosedAds.length,
        posts: undisclosedAds,
      },
      compliant,
      score,
    })
  } catch (error) {
    console.error('[Compliance] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

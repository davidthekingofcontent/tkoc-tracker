import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

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

    // Get all media for this campaign
    const campaignMedia = await prisma.media.findMany({
      where: { campaignId: id },
      select: {
        id: true,
        externalId: true,
        platform: true,
        permalink: true,
        caption: true,
        mediaUrl: true,
        thumbnailUrl: true,
        postedAt: true,
        likes: true,
        comments: true,
        views: true,
        influencer: {
          select: { id: true, username: true, displayName: true },
        },
      },
    })

    if (campaignMedia.length === 0) {
      return NextResponse.json({ duplicates: [], stats: { total: 0, duplicateCount: 0, uniqueCount: 0 } })
    }

    // Strategy 1: Find media with same externalId+platform in OTHER campaigns
    const externalIds = campaignMedia
      .filter(m => m.externalId)
      .map(m => m.externalId!)

    const crossCampaignDuplicates = externalIds.length > 0
      ? await prisma.media.findMany({
          where: {
            externalId: { in: externalIds },
            campaignId: { not: id },
          },
          select: {
            id: true,
            externalId: true,
            platform: true,
            permalink: true,
            caption: true,
            likes: true,
            comments: true,
            views: true,
            campaign: { select: { id: true, name: true } },
            influencer: { select: { id: true, username: true, displayName: true } },
          },
        })
      : []

    // Strategy 2: Find same-caption duplicates within this campaign (different influencers posting identical content)
    const captionMap = new Map<string, typeof campaignMedia>()
    for (const m of campaignMedia) {
      if (!m.caption || m.caption.length < 30) continue
      const key = m.caption.trim().toLowerCase().slice(0, 200)
      if (!captionMap.has(key)) captionMap.set(key, [])
      captionMap.get(key)!.push(m)
    }

    const captionDuplicates: Array<{
      caption: string
      media: typeof campaignMedia
    }> = []

    for (const [caption, media] of captionMap) {
      if (media.length > 1) {
        captionDuplicates.push({ caption: caption.slice(0, 100) + '...', media })
      }
    }

    // Build cross-campaign duplicate groups
    const crossGroups = new Map<string, {
      original: (typeof campaignMedia)[0]
      duplicateIn: Array<{ campaignId: string; campaignName: string; mediaId: string }>
    }>()

    for (const dup of crossCampaignDuplicates) {
      const original = campaignMedia.find(m => m.externalId === dup.externalId)
      if (!original) continue

      if (!crossGroups.has(dup.externalId!)) {
        crossGroups.set(dup.externalId!, {
          original,
          duplicateIn: [],
        })
      }
      crossGroups.get(dup.externalId!)!.duplicateIn.push({
        campaignId: dup.campaign!.id,
        campaignName: dup.campaign!.name,
        mediaId: dup.id,
      })
    }

    const duplicates = {
      crossCampaign: Array.from(crossGroups.values()),
      sameCaption: captionDuplicates,
    }

    const duplicateCount = crossGroups.size + captionDuplicates.reduce((sum, g) => sum + g.media.length - 1, 0)

    return NextResponse.json({
      duplicates,
      stats: {
        total: campaignMedia.length,
        duplicateCount,
        uniqueCount: campaignMedia.length - duplicateCount,
      },
    })
  } catch (error) {
    console.error('Duplicate detection error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { calculateCampaignEMV } from '@/lib/emv'
import { instagramShortcode } from '@/lib/campaign-capture'

interface BrandData {
  brandName: string
  campaignCount: number
  totalInfluencers: number
  totalMedia: number
  totalReach: number
  totalEngagements: number
  totalViews: number
  totalCost: number
  totalEMV: number
  avgEngagementRate: number
  roi: number
  topPlatforms: string[]
  campaigns: Array<{
    id: string
    name: string
    status: string
    type: string
    influencerCount: number
    mediaCount: number
    platforms: string[]
    startDate: string
    endDate: string | null
  }>
}

function deriveBrandName(campaign: {
  name: string
  targetAccounts: string[]
  targetHashtags: string[]
}): string {
  // Use first target account as the brand name (e.g. "@vileda.es" -> "Vileda")
  if (campaign.targetAccounts.length > 0) {
    const account = campaign.targetAccounts[0]
    const cleaned = account.replace(/^@/, '').replace(/\.\w{2,3}$/, '')
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  }

  // Fallback: use the first hashtag (e.g. "#vileda" -> "Vileda")
  if (campaign.targetHashtags.length > 0) {
    const tag = campaign.targetHashtags[0]
    const cleaned = tag.replace(/^#/, '')
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  }

  // Last fallback: extract from campaign name (first word)
  const firstWord = campaign.name.split(/[\s\-_]/)[0]
  return firstWord.charAt(0).toUpperCase() + firstWord.slice(1)
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Build where clause based on user role
    let campaignWhere: Record<string, unknown> = {}
    if (session.role === 'EMPLOYEE') {
      campaignWhere = {
        OR: [
          { userId: session.id },
          { assignments: { some: { userId: session.id } } },
        ],
      }
    } else if (session.role === 'BRAND') {
      campaignWhere = { userId: session.id }
    }

    // Fetch all campaigns with their related data
    const campaigns = await prisma.campaign.findMany({
      where: campaignWhere,
      include: {
        influencers: {
          include: {
            influencer: {
              select: {
                followers: true,
                engagementRate: true,
              },
            },
          },
        },
        media: {
          select: {
            id: true,
            externalId: true,
            permalink: true,
            platform: true,
            likes: true,
            comments: true,
            shares: true,
            saves: true,
            views: true,
            reach: true,
            impressions: true,
            engagementRate: true,
            mediaValue: true,
          },
        },
        _count: {
          select: { influencers: true, media: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Group campaigns by derived brand name
    const brandMap = new Map<string, BrandData>()
    const brandSeenPosts = new Map<string, Set<string>>()

    for (const campaign of campaigns) {
      const brandName = deriveBrandName(campaign)

      if (!brandMap.has(brandName)) {
        brandMap.set(brandName, {
          brandName,
          campaignCount: 0,
          totalInfluencers: 0,
          totalMedia: 0,
          totalReach: 0,
          totalEngagements: 0,
          totalViews: 0,
          totalCost: 0,
          totalEMV: 0,
          avgEngagementRate: 0,
          roi: 0,
          topPlatforms: [],
          campaigns: [],
        })
      }

      const brand = brandMap.get(brandName)!
      brand.campaignCount += 1

      // Influencer metrics
      const uniqueInfluencerIds = new Set<string>()
      let campaignCost = campaign.budget || 0

      for (const ci of campaign.influencers) {
        uniqueInfluencerIds.add(ci.influencerId)
        brand.totalReach += ci.influencer.followers || 0
        campaignCost += ci.cost || 0
      }

      brand.totalInfluencers += uniqueInfluencerIds.size
      brand.totalCost += campaignCost

      // Media metrics — per DISTINCT post across the brand's campaigns (a post
      // that lives in the annual and the monthly campaign counts once here).
      const seenPosts = brandSeenPosts.get(brandName) ?? new Set<string>()
      brandSeenPosts.set(brandName, seenPosts)
      const distinct = campaign.media.filter(m => {
        const sc = m.platform === 'INSTAGRAM' ? instagramShortcode(m.permalink) : null
        const key = sc ? `${m.platform}|sc:${sc}` : m.externalId ? `${m.platform}|${m.externalId}` : `id|${m.id}`
        if (seenPosts.has(key)) return false
        seenPosts.add(key)
        return true
      })
      brand.totalMedia += distinct.length

      let campaignEngagements = 0
      let campaignViews = 0
      for (const m of distinct) {
        const engagements = (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0)
        campaignEngagements += engagements
        campaignViews += m.views || 0
      }
      brand.totalEngagements += campaignEngagements
      brand.totalViews += campaignViews

      // EMV calculation (distinct posts only)
      const emv = calculateCampaignEMV(distinct)
      brand.totalEMV += emv.extended

      // Track platforms
      for (const p of campaign.platforms) {
        if (!brand.topPlatforms.includes(p)) {
          brand.topPlatforms.push(p)
        }
      }

      // Add campaign summary
      brand.campaigns.push({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        type: campaign.type,
        influencerCount: campaign._count.influencers,
        mediaCount: campaign._count.media,
        platforms: campaign.platforms,
        startDate: campaign.startDate.toISOString(),
        endDate: campaign.endDate?.toISOString() || null,
      })
    }

    // Calculate derived metrics for each brand
    const brands: BrandData[] = []
    for (const brand of brandMap.values()) {
      // Average engagement rate across all media
      if (brand.totalMedia > 0 && brand.totalReach > 0) {
        brand.avgEngagementRate =
          Math.round(((brand.totalEngagements / brand.totalReach) * 100) * 10) / 10
      }

      // ROI = (EMV - Cost) / Cost * 100
      if (brand.totalCost > 0) {
        brand.roi = Math.round(((brand.totalEMV - brand.totalCost) / brand.totalCost) * 100)
      }

      brand.totalEMV = Math.round(brand.totalEMV * 100) / 100

      brands.push(brand)
    }

    // Sort brands by total EMV descending
    brands.sort((a, b) => b.totalEMV - a.totalEMV)

    // Aggregate totals
    const totals = {
      totalBrands: brands.length,
      totalCampaigns: campaigns.length,
      totalSpend: brands.reduce((sum, b) => sum + b.totalCost, 0),
      totalEMV: brands.reduce((sum, b) => sum + b.totalEMV, 0),
    }

    return NextResponse.json({ brands, totals })
  } catch (error) {
    console.error('Brand dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

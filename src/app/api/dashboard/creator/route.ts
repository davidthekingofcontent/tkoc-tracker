import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'CREATOR') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Find the Influencer record matching this user's email
    const influencer = await prisma.influencer.findFirst({
      where: { email: session.email },
    })

    // Fetch campaigns separately if influencer exists
    const campaignInfluencers = influencer
      ? await prisma.campaignInfluencer.findMany({
          where: { influencerId: influencer.id },
          include: {
            campaign: {
              select: {
                id: true,
                name: true,
                status: true,
                type: true,
                user: {
                  select: { brandName: true },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        })
      : []

    // Also fetch the user record for creator profile fields
    const user = await prisma.user.findUnique({
      where: { id: session.id },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        creatorUsername: true,
        creatorPlatform: true,
        creatorBio: true,
        creatorCategory: true,
        creatorFollowers: true,
        creatorCountry: true,
        creatorCity: true,
      },
    })

    // Build profile data (prefer Influencer data, fallback to User creator fields)
    const profile = influencer
      ? {
          id: influencer.id,
          username: influencer.username,
          platform: influencer.platform,
          displayName: influencer.displayName,
          avatarUrl: influencer.avatarUrl,
          followers: influencer.followers,
          engagementRate: influencer.engagementRate,
          avgLikes: influencer.avgLikes,
          avgComments: influencer.avgComments,
          avgViews: influencer.avgViews,
          postsCount: influencer.postsCount,
          standardFee: influencer.standardFee,
          country: influencer.country,
          city: influencer.city,
          isLinked: true,
        }
      : {
          id: null,
          username: user?.creatorUsername || null,
          platform: user?.creatorPlatform || null,
          displayName: user?.name || null,
          avatarUrl: user?.avatar || null,
          followers: user?.creatorFollowers || 0,
          engagementRate: 0,
          avgLikes: 0,
          avgComments: 0,
          avgViews: 0,
          postsCount: 0,
          standardFee: null,
          country: user?.creatorCountry || null,
          city: user?.creatorCity || null,
          isLinked: false,
        }

    // Build campaigns list
    const campaigns = campaignInfluencers.map((ci) => ({
      id: ci.campaign.id,
      name: ci.campaign.name,
      brandName: ci.campaign.user?.brandName || null,
      campaignStatus: ci.campaign.status,
      influencerStatus: ci.status,
      agreedFee: ci.agreedFee,
      contentDelivered: ci.contentDelivered,
      // Shipping info
      hasShipping: Boolean(ci.shippingAddress1),
      shippingProduct: ci.shippingProduct,
      shippingCity: ci.shippingCity,
      shippingCountry: ci.shippingCountry,
    }))

    // Determine shipping status from campaigns
    const shippingItems = campaignInfluencers
      .filter((ci) => ci.shippingAddress1)
      .map((ci) => ({
        campaignName: ci.campaign.name,
        product: ci.shippingProduct,
        status: ci.status,
        city: ci.shippingCity,
        country: ci.shippingCountry,
      }))

    // Creator Score input data (for client-side calculation)
    const totalCampaigns = campaignInfluencers.length
    const completedCampaigns = campaignInfluencers.filter(
      (ci) => ci.status === 'COMPLETED' || ci.status === 'POSTED'
    ).length

    const scoreInput = profile.isLinked
      ? {
          followers: profile.followers,
          engagementRate: profile.engagementRate,
          avgLikes: profile.avgLikes,
          avgComments: profile.avgComments,
          avgViews: profile.avgViews,
          postsCount: profile.postsCount,
          platform: profile.platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
          standardFee: profile.standardFee,
          totalCampaigns,
          completedCampaigns,
        }
      : null

    return NextResponse.json({
      user: {
        name: user?.name || session.name,
        email: session.email,
        avatar: user?.avatar || null,
      },
      profile,
      campaigns,
      shippingItems,
      scoreInput,
    })
  } catch (error) {
    console.error('Creator dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

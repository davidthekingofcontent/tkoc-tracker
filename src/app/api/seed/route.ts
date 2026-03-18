import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { UserRole, CampaignType, CampaignStatus, Platform } from '@/generated/prisma/client'

export async function POST(request: NextRequest) {
  try {
    const { secret } = await request.json()

    if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Hash passwords
    const adminPassword = await bcrypt.hash('Tkoc2024!', 12)
    const employeePassword = await bcrypt.hash('Employee2024!', 12)
    const brandPassword = await bcrypt.hash('Brand2024!', 12)

    // Create users
    const adminUser = await prisma.user.upsert({
      where: { email: 'admin@thekingofcontent.agency' },
      update: {},
      create: {
        email: 'admin@thekingofcontent.agency',
        password: adminPassword,
        name: 'David Calamardo',
        role: UserRole.ADMIN,
      },
    })

    await prisma.user.upsert({
      where: { email: 'employee@thekingofcontent.agency' },
      update: {},
      create: {
        email: 'employee@thekingofcontent.agency',
        password: employeePassword,
        name: 'Team TKOC',
        role: UserRole.EMPLOYEE,
      },
    })

    await prisma.user.upsert({
      where: { email: 'brand@vileda.es' },
      update: {},
      create: {
        email: 'brand@vileda.es',
        password: brandPassword,
        name: 'Vileda España',
        role: UserRole.BRAND,
        brandName: 'Vileda',
      },
    })

    // Create sample influencers
    const influencerData = [
      { username: 'maria_lifestyle', platform: Platform.INSTAGRAM, displayName: 'Maria Lopez', followers: 125000, engagementRate: 4.2, country: 'Spain', city: 'Madrid', avgLikes: 5250, avgComments: 180 },
      { username: 'carlos_fit', platform: Platform.INSTAGRAM, displayName: 'Carlos Fitness', followers: 89000, engagementRate: 5.1, country: 'Spain', city: 'Barcelona', avgLikes: 4539, avgComments: 210 },
      { username: 'ana_beauty', platform: Platform.INSTAGRAM, displayName: 'Ana Beauty', followers: 210000, engagementRate: 3.8, country: 'Spain', city: 'Valencia', avgLikes: 7980, avgComments: 320 },
      { username: 'pablo_foodie', platform: Platform.INSTAGRAM, displayName: 'Pablo Gastro', followers: 67000, engagementRate: 6.3, country: 'Spain', city: 'Sevilla', avgLikes: 4221, avgComments: 150 },
      { username: 'laura_travel', platform: Platform.INSTAGRAM, displayName: 'Laura Travels', followers: 340000, engagementRate: 3.2, country: 'Spain', city: 'Madrid', avgLikes: 10880, avgComments: 420 },
      { username: 'diego_tech', platform: Platform.TIKTOK, displayName: 'Diego Tech', followers: 520000, engagementRate: 7.5, country: 'Spain', city: 'Madrid', avgLikes: 39000, avgComments: 1200 },
      { username: 'sofia_dance', platform: Platform.TIKTOK, displayName: 'Sofia Dance', followers: 890000, engagementRate: 8.1, country: 'Mexico', city: 'CDMX', avgLikes: 72090, avgComments: 3400 },
      { username: 'marta_clean', platform: Platform.INSTAGRAM, displayName: 'Marta Home', followers: 45000, engagementRate: 5.8, country: 'Spain', city: 'Bilbao', avgLikes: 2610, avgComments: 95 },
      { username: 'javi_gaming', platform: Platform.YOUTUBE, displayName: 'Javi Gaming', followers: 1200000, engagementRate: 4.5, country: 'Spain', city: 'Madrid', avgViews: 54000, avgLikes: 8500 },
      { username: 'elena_moda', platform: Platform.INSTAGRAM, displayName: 'Elena Moda', followers: 175000, engagementRate: 4.0, country: 'Spain', city: 'Madrid', avgLikes: 7000, avgComments: 280 },
    ]

    const influencers = []
    for (const data of influencerData) {
      const inf = await prisma.influencer.upsert({
        where: { username_platform: { username: data.username, platform: data.platform } },
        update: { followers: data.followers, engagementRate: data.engagementRate },
        create: data,
      })
      influencers.push(inf)
    }

    // Create sample campaigns
    const campaignData = [
      {
        name: 'Vileda Spring Campaign',
        type: CampaignType.INFLUENCER_TRACKING,
        status: CampaignStatus.ACTIVE,
        platforms: [Platform.INSTAGRAM, Platform.TIKTOK],
        targetAccounts: ['@vileda_es', '@vileda_official'],
        targetHashtags: ['#vileda', '#viledaclean', '#fregonvileda'],
        isPinned: true,
        influencerIds: [influencers[7].id, influencers[0].id, influencers[3].id],
      },
      {
        name: 'Black Limba Launch',
        type: CampaignType.SOCIAL_LISTENING,
        status: CampaignStatus.ACTIVE,
        platforms: [Platform.INSTAGRAM, Platform.TIKTOK, Platform.YOUTUBE],
        targetAccounts: ['@blacklimba'],
        targetHashtags: ['#blacklimba', '#blacklimbamusic'],
        isPinned: false,
        influencerIds: [influencers[1].id, influencers[5].id],
      },
      {
        name: 'Mahou Summer',
        type: CampaignType.INFLUENCER_TRACKING,
        status: CampaignStatus.PAUSED,
        platforms: [Platform.INSTAGRAM],
        targetAccounts: ['@mahoucervezas'],
        targetHashtags: ['#mahou', '#cincoestrellas'],
        isPinned: false,
        influencerIds: [influencers[0].id, influencers[4].id, influencers[9].id, influencers[3].id],
      },
      {
        name: 'Freshly Cosmetics Navidad',
        type: CampaignType.INFLUENCER_TRACKING,
        status: CampaignStatus.ARCHIVED,
        platforms: [Platform.INSTAGRAM, Platform.TIKTOK],
        targetAccounts: ['@freshlycosmetics'],
        targetHashtags: ['#freshlycosmetics', '#freshlynavidad'],
        isPinned: false,
        influencerIds: [influencers[2].id, influencers[9].id, influencers[6].id],
      },
      {
        name: 'Heura Brand Monitoring',
        type: CampaignType.SOCIAL_LISTENING,
        status: CampaignStatus.ACTIVE,
        platforms: [Platform.INSTAGRAM, Platform.YOUTUBE],
        targetAccounts: ['@heaboratory'],
        targetHashtags: ['#heura', '#heurafoods'],
        isPinned: false,
        influencerIds: [influencers[3].id],
      },
    ]

    const campaigns = []
    for (const data of campaignData) {
      const { influencerIds, ...campaignFields } = data
      const existing = await prisma.campaign.findFirst({
        where: { name: data.name, userId: adminUser.id },
      })
      if (!existing) {
        const campaign = await prisma.campaign.create({
          data: {
            ...campaignFields,
            userId: adminUser.id,
            influencers: {
              create: influencerIds.map((id) => ({ influencerId: id })),
            },
          },
        })
        campaigns.push(campaign)
      } else {
        campaigns.push(existing)
      }
    }

    // Create lists with influencers
    const listData = [
      { name: 'Black Limba UGC', influencerIds: [influencers[1].id, influencers[5].id, influencers[6].id] },
      { name: 'Vileda Micros', influencerIds: [influencers[7].id, influencers[3].id, influencers[0].id] },
      { name: 'HC Madrid', influencerIds: [influencers[0].id, influencers[4].id, influencers[9].id, influencers[8].id] },
    ]

    const lists = []
    for (const data of listData) {
      const existing = await prisma.list.findFirst({
        where: { name: data.name, userId: adminUser.id },
      })
      if (existing) {
        // Delete existing items and re-add them
        await prisma.listItem.deleteMany({ where: { listId: existing.id } })
        await prisma.listItem.createMany({
          data: data.influencerIds.map((id) => ({ listId: existing.id, influencerId: id })),
        })
        lists.push(existing)
      } else {
        const list = await prisma.list.create({
          data: {
            name: data.name,
            userId: adminUser.id,
            items: {
              create: data.influencerIds.map((id) => ({ influencerId: id })),
            },
          },
        })
        lists.push(list)
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Seed completed successfully',
      data: { users: 3, influencers: influencers.length, campaigns: campaigns.length, lists: lists.length },
    })
  } catch (error) {
    console.error('Seed error:', error)
    return NextResponse.json(
      { error: 'Seed failed', details: String(error) },
      { status: 500 }
    )
  }
}

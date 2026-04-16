import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { detectCategories, type CategoryDetectionInput } from '@/lib/category-detector'

// POST /api/admin/backfill-categories — backfill category signals for creators missing them
export async function POST(req: NextRequest) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true'

  // Find creators with 0 categorySignals
  const creators = await prisma.creatorProfile.findMany({
    where: {
      categorySignals: { none: {} },
    },
    include: {
      platformProfiles: {
        select: { bio: true },
      },
      posts: {
        select: { hashtags: true, mentions: true, caption: true },
        orderBy: { postedAt: 'desc' },
        take: 50,
      },
    },
    take: 100,
  })

  let processed = 0
  let categorized = 0
  let skipped = 0

  for (const creator of creators) {
    processed++

    // Collect all bios
    const bios = creator.platformProfiles
      .map((pp) => pp.bio)
      .filter(Boolean)
      .join(' ')

    // Collect all hashtags, mentions, and captions from posts
    const allHashtags: string[] = []
    const allMentions: string[] = []
    const allCaptions: string[] = []

    for (const post of creator.posts) {
      if (post.hashtags) allHashtags.push(...post.hashtags)
      if (post.mentions) allMentions.push(...post.mentions)
      if (post.caption) allCaptions.push(post.caption)
    }

    // Combine bios and captions for the bio field
    const combinedBio = [bios, ...allCaptions].filter(Boolean).join(' ')

    const input: CategoryDetectionInput = {
      bio: combinedBio || undefined,
      hashtags: allHashtags.length > 0 ? allHashtags : undefined,
      mentions: allMentions.length > 0 ? allMentions : undefined,
    }

    const results = detectCategories(input)

    if (results.length === 0) {
      skipped++
      continue
    }

    categorized++

    if (!dryRun) {
      // Create CategorySignal rows
      await prisma.creatorCategorySignal.createMany({
        data: results.map((r) => ({
          creatorId: creator.id,
          category: r.category,
          confidence: r.confidence,
          source: r.source,
        })),
      })

      // Update creatorProfile.categories and primaryCategory
      await prisma.creatorProfile.update({
        where: { id: creator.id },
        data: {
          categories: results.map((r) => r.category),
          primaryCategory: results[0].category,
        },
      })
    }
  }

  return NextResponse.json({
    processed,
    categorized,
    skipped,
    dryRun,
    message: dryRun
      ? `Dry run complete. Would categorize ${categorized} of ${processed} creators.`
      : `Backfill complete. Categorized ${categorized} of ${processed} creators.`,
  })
}

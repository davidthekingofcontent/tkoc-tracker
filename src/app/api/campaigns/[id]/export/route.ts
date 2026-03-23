import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { calculateEMV, calculateCampaignEMV, EMV_METHODOLOGY } from '@/lib/emv'
import * as fs from 'fs'
import * as path from 'path'

// Load TKOC logo as base64 at module level for PDF embedding
let TKOC_LOGO_BASE64: string | null = null
try {
  const logoPath = path.join(process.cwd(), 'public', 'images', 'tkoc-logo-full.png')
  if (fs.existsSync(logoPath)) {
    TKOC_LOGO_BASE64 = fs.readFileSync(logoPath).toString('base64')
  }
} catch { /* logo optional */ }

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
    const format = request.nextUrl.searchParams.get('format') || 'csv'

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        influencers: {
          include: { influencer: true },
        },
        media: {
          orderBy: { postedAt: 'desc' },
          include: {
            influencer: {
              select: {
                username: true,
                displayName: true,
                platform: true,
                followers: true,
                engagementRate: true,
              },
            },
          },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    if (session.role === 'BRAND' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Custom report options from query params
    const customTitle = request.nextUrl.searchParams.get('title') || undefined
    const customSubtitle = request.nextUrl.searchParams.get('subtitle') || undefined
    const coverImageUrl = request.nextUrl.searchParams.get('coverImage') || undefined

    if (format === 'csv') return generateCSV(campaign)
    if (format === 'json') return generateJSON(campaign)
    if (format === 'pdf') return generatePDF(campaign, { customTitle, customSubtitle, coverImageUrl })

    return NextResponse.json({ error: 'Unsupported format. Use csv, json, or pdf.' }, { status: 400 })
  } catch (error) {
    console.error('Export campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============ TYPES ============

interface CampaignData {
  name: string
  status: string
  type: string
  startDate: Date | null
  endDate: Date | null
  country: string | null
  platforms: string[]
  targetHashtags: string[]
  targetAccounts: string[]
  influencers: {
    cost: number | null
    agreedFee: number | null
    status: string
    influencer: {
      username: string
      displayName: string | null
      platform: string
      followers: number
      following: number
      engagementRate: number
      avgLikes: number
      avgComments: number
      avgViews: number
      email: string | null
      website: string | null
      country: string | null
      city: string | null
    }
  }[]
  media: {
    mediaType: string
    caption: string | null
    permalink: string | null
    thumbnailUrl: string | null
    likes: number
    comments: number
    shares: number
    saves: number
    views: number
    reach: number
    impressions: number
    mediaValue: number
    postedAt: Date | null
    influencerId: string
    influencer: {
      username: string
      displayName: string | null
      platform: string
      followers: number
      engagementRate: number
    } | null
  }[]
}

// ============ INFLUENCER MEDIA AGGREGATION ============

interface InfluencerMediaMetrics {
  totalLikes: number
  totalComments: number
  totalShares: number
  totalSaves: number
  totalViews: number
  totalReach: number
  totalImpressions: number
  totalEMV: number
  mediaCount: number
}

function aggregateInfluencerMedia(campaign: CampaignData): Map<string, InfluencerMediaMetrics> {
  const map = new Map<string, InfluencerMediaMetrics>()

  for (const m of campaign.media) {
    const username = m.influencer?.username || 'unknown'
    const existing = map.get(username) || {
      totalLikes: 0, totalComments: 0, totalShares: 0, totalSaves: 0,
      totalViews: 0, totalReach: 0, totalImpressions: 0, totalEMV: 0, mediaCount: 0,
    }

    existing.totalLikes += m.likes || 0
    existing.totalComments += m.comments || 0
    existing.totalShares += m.shares || 0
    existing.totalSaves += m.saves || 0
    existing.totalViews += m.views || 0
    existing.totalReach += m.reach || 0
    existing.totalImpressions += m.impressions || 0
    existing.mediaCount++

    const mediaEMV = calculateEMV({
      platform: m.influencer?.platform || 'INSTAGRAM',
      impressions: m.impressions, reach: m.reach, views: m.views,
      clicks: 0, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
    })
    existing.totalEMV += mediaEMV.extended

    map.set(username, existing)
  }

  return map
}

// ============ HELPERS ============

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

async function fetchImageBase64(url: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    const buffer = await res.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    return `data:${contentType};base64,${base64}`
  } catch {
    return null
  }
}

// ============ CSV ============

function generateCSV(campaign: CampaignData): NextResponse {
  const lines: string[] = []
  const influencerMetrics = aggregateInfluencerMedia(campaign)

  lines.push('CAMPAIGN REPORT')
  lines.push(`Campaign Name,${escapeCSV(campaign.name)}`)
  lines.push(`Type,${escapeCSV(campaign.type)}`)
  lines.push(`Status,${escapeCSV(campaign.status)}`)
  lines.push(`Start Date,${campaign.startDate ? new Date(campaign.startDate).toLocaleDateString() : 'N/A'}`)
  lines.push(`End Date,${campaign.endDate ? new Date(campaign.endDate).toLocaleDateString() : 'N/A'}`)
  lines.push(`Country,${escapeCSV(campaign.country || 'N/A')}`)
  lines.push(`Platforms,${escapeCSV(campaign.platforms.join(', '))}`)
  lines.push(`Hashtags,${escapeCSV(campaign.targetHashtags.join(', '))}`)
  lines.push(`Tracked Accounts,${escapeCSV(campaign.targetAccounts.join(', '))}`)
  lines.push('')

  let totalReach = 0, totalLikes = 0, totalComments = 0, totalShares = 0, totalViews = 0, totalSaves = 0, totalImpressions = 0

  for (const m of campaign.media) {
    totalReach += m.reach || 0
    totalLikes += m.likes || 0
    totalComments += m.comments || 0
    totalShares += m.shares || 0
    totalViews += m.views || 0
    totalSaves += m.saves || 0
    totalImpressions += m.impressions || 0
  }

  const totalEngagements = totalLikes + totalComments + totalShares
  const engRate = totalReach > 0 ? ((totalEngagements / totalReach) * 100).toFixed(2) : '0'
  const emv = calculateCampaignEMV(campaign.media.map(m => ({
    platform: m.influencer?.platform || 'INSTAGRAM',
    impressions: m.impressions, reach: m.reach, views: m.views,
    likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
  })))

  const totalCost = campaign.influencers.reduce((sum, ci) => sum + (ci.agreedFee || ci.cost || 0), 0)

  lines.push('OVERVIEW')
  lines.push(`Total Influencers,${campaign.influencers.length}`)
  lines.push(`Total Media,${campaign.media.length}`)
  lines.push(`Total Reach,${totalReach}`)
  lines.push(`Total Impressions,${totalImpressions}`)
  lines.push(`Total Engagements,${totalEngagements}`)
  lines.push(`Engagement Rate,${engRate}%`)
  lines.push(`Total Likes,${totalLikes}`)
  lines.push(`Total Comments,${totalComments}`)
  lines.push(`Total Shares,${totalShares}`)
  lines.push(`Total Saves,${totalSaves}`)
  lines.push(`Total Views,${totalViews}`)
  lines.push(`Total Cost,$${totalCost.toFixed(2)}`)
  lines.push(`EMV Basic,$${emv.basic.toFixed(2)}`)
  lines.push(`EMV Extended,$${emv.extended.toFixed(2)}`)
  lines.push('')

  // Per-influencer rows with aggregated media metrics
  lines.push('INFLUENCER PERFORMANCE')
  lines.push('Username,Display Name,Platform,Followers,Status,Agreed Fee,Cost,Likes,Comments,Shares,Saves,Views,Reach,Impressions,EMV,Media Count')

  let totInfLikes = 0, totInfComments = 0, totInfShares = 0, totInfSaves = 0
  let totInfViews = 0, totInfReach = 0, totInfImpressions = 0, totInfEMV = 0, totInfMedia = 0
  let totAgreedFee = 0, totCostVal = 0

  for (const ci of campaign.influencers) {
    const inf = ci.influencer
    const metrics = influencerMetrics.get(inf.username) || {
      totalLikes: 0, totalComments: 0, totalShares: 0, totalSaves: 0,
      totalViews: 0, totalReach: 0, totalImpressions: 0, totalEMV: 0, mediaCount: 0,
    }

    const agreedFee = ci.agreedFee || 0
    const costVal = ci.cost || 0

    totInfLikes += metrics.totalLikes
    totInfComments += metrics.totalComments
    totInfShares += metrics.totalShares
    totInfSaves += metrics.totalSaves
    totInfViews += metrics.totalViews
    totInfReach += metrics.totalReach
    totInfImpressions += metrics.totalImpressions
    totInfEMV += metrics.totalEMV
    totInfMedia += metrics.mediaCount
    totAgreedFee += agreedFee
    totCostVal += costVal

    lines.push([
      escapeCSV(inf.username), escapeCSV(inf.displayName), escapeCSV(inf.platform),
      inf.followers, escapeCSV(ci.status), `$${agreedFee.toFixed(2)}`, `$${costVal.toFixed(2)}`,
      metrics.totalLikes, metrics.totalComments, metrics.totalShares, metrics.totalSaves,
      metrics.totalViews, metrics.totalReach, metrics.totalImpressions,
      `$${metrics.totalEMV.toFixed(2)}`, metrics.mediaCount,
    ].join(','))
  }

  // Totals row
  lines.push([
    'TOTALS', '', '', '', '', `$${totAgreedFee.toFixed(2)}`, `$${totCostVal.toFixed(2)}`,
    totInfLikes, totInfComments, totInfShares, totInfSaves,
    totInfViews, totInfReach, totInfImpressions,
    `$${totInfEMV.toFixed(2)}`, totInfMedia,
  ].join(','))

  lines.push('')
  lines.push('MEDIA')
  lines.push('Date,Influencer,Platform,Type,Likes,Comments,Shares,Saves,Views,Reach,Impressions,EMV,Link,Caption')

  for (const media of campaign.media) {
    const mediaEMV = calculateEMV({
      platform: media.influencer?.platform || 'INSTAGRAM',
      impressions: media.impressions, reach: media.reach, views: media.views,
      clicks: 0, likes: media.likes, comments: media.comments, shares: media.shares, saves: media.saves,
    })
    lines.push([
      media.postedAt ? new Date(media.postedAt).toLocaleDateString() : '',
      escapeCSV(media.influencer?.username || ''), escapeCSV(media.influencer?.platform || ''),
      escapeCSV(media.mediaType), media.likes, media.comments, media.shares, media.saves,
      media.views, media.reach, media.impressions, `$${mediaEMV.extended.toFixed(2)}`,
      escapeCSV(media.permalink), escapeCSV(media.caption?.substring(0, 200)),
    ].join(','))
  }

  const csvContent = lines.join('\n')
  const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_report.csv`

  return new NextResponse('\uFEFF' + csvContent, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

// ============ JSON ============

function generateJSON(campaign: CampaignData): NextResponse {
  const influencerMetrics = aggregateInfluencerMedia(campaign)

  let totalReach = 0, totalLikes = 0, totalComments = 0, totalShares = 0
  let totalViews = 0, totalSaves = 0, totalImpressions = 0

  for (const m of campaign.media) {
    totalReach += m.reach || 0
    totalLikes += m.likes || 0
    totalComments += m.comments || 0
    totalShares += m.shares || 0
    totalViews += m.views || 0
    totalSaves += m.saves || 0
    totalImpressions += m.impressions || 0
  }

  const totalEngagements = totalLikes + totalComments + totalShares
  const engRate = totalReach > 0 ? (totalEngagements / totalReach) * 100 : 0
  const emv = calculateCampaignEMV(campaign.media.map(m => ({
    platform: m.influencer?.platform || 'INSTAGRAM',
    impressions: m.impressions, reach: m.reach, views: m.views,
    likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
  })))

  const totalCost = campaign.influencers.reduce((sum, ci) => sum + (ci.agreedFee || ci.cost || 0), 0)

  const report = {
    campaign: {
      name: campaign.name,
      type: campaign.type,
      status: campaign.status,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      country: campaign.country,
      platforms: campaign.platforms,
      targetHashtags: campaign.targetHashtags,
      targetAccounts: campaign.targetAccounts,
    },
    overview: {
      totalInfluencers: campaign.influencers.length,
      totalMedia: campaign.media.length,
      totalReach,
      totalImpressions,
      totalEngagements,
      engagementRate: Math.round(engRate * 100) / 100,
      totalLikes,
      totalComments,
      totalShares,
      totalSaves,
      totalViews,
      totalCost,
      emvBasic: Math.round(emv.basic * 100) / 100,
      emvExtended: Math.round(emv.extended * 100) / 100,
    },
    influencers: campaign.influencers.map(ci => {
      const inf = ci.influencer
      const metrics = influencerMetrics.get(inf.username) || {
        totalLikes: 0, totalComments: 0, totalShares: 0, totalSaves: 0,
        totalViews: 0, totalReach: 0, totalImpressions: 0, totalEMV: 0, mediaCount: 0,
      }
      return {
        username: inf.username,
        displayName: inf.displayName,
        platform: inf.platform,
        followers: inf.followers,
        status: ci.status,
        agreedFee: ci.agreedFee || 0,
        cost: ci.cost || 0,
        metrics: {
          likes: metrics.totalLikes,
          comments: metrics.totalComments,
          shares: metrics.totalShares,
          saves: metrics.totalSaves,
          views: metrics.totalViews,
          reach: metrics.totalReach,
          impressions: metrics.totalImpressions,
          emv: Math.round(metrics.totalEMV * 100) / 100,
          mediaCount: metrics.mediaCount,
        },
      }
    }),
    media: campaign.media.map(m => {
      const mediaEMV = calculateEMV({
        platform: m.influencer?.platform || 'INSTAGRAM',
        impressions: m.impressions, reach: m.reach, views: m.views,
        clicks: 0, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
      })
      return {
        postedAt: m.postedAt,
        influencer: m.influencer?.username || null,
        platform: m.influencer?.platform || null,
        mediaType: m.mediaType,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        saves: m.saves,
        views: m.views,
        reach: m.reach,
        impressions: m.impressions,
        emv: Math.round(mediaEMV.extended * 100) / 100,
        permalink: m.permalink,
        caption: m.caption?.substring(0, 200) || null,
      }
    }),
    generatedAt: new Date().toISOString(),
  }

  const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_report.json`

  return new NextResponse(JSON.stringify(report, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

// ============ PDF GENERATION ============

async function generatePDF(campaign: CampaignData, options?: { customTitle?: string; customSubtitle?: string; coverImageUrl?: string }): Promise<NextResponse> {
  const doc = new jsPDF('p', 'mm', 'a4')
  const W = doc.internal.pageSize.getWidth()   // 210
  const H = doc.internal.pageSize.getHeight()  // 297
  const M = 15 // margin
  const CW = W - M * 2 // content width

  // Colors
  const purple: [number, number, number] = [124, 58, 237]
  const darkPurple: [number, number, number] = [91, 33, 182]
  const gray900: [number, number, number] = [17, 24, 39]
  const gray500: [number, number, number] = [107, 114, 128]
  const gray200: [number, number, number] = [229, 231, 235]
  const white: [number, number, number] = [255, 255, 255]
  const green600: [number, number, number] = [5, 150, 105]

  // Aggregate all metrics
  let totalReach = 0, totalLikes = 0, totalComments = 0, totalShares = 0, totalViews = 0, totalSaves = 0

  for (const m of campaign.media) {
    totalReach += m.reach || 0
    totalLikes += m.likes || 0
    totalComments += m.comments || 0
    totalShares += m.shares || 0
    totalViews += m.views || 0
    totalSaves += m.saves || 0
  }

  const totalEngagements = totalLikes + totalComments + totalShares
  const engRate = totalReach > 0 ? ((totalEngagements / totalReach) * 100).toFixed(2) : '0.00'

  const posts = campaign.media.filter(m => m.mediaType !== 'STORY')
  const stories = campaign.media.filter(m => m.mediaType === 'STORY')

  // EMV
  const emv = calculateCampaignEMV(campaign.media.map(m => ({
    platform: m.influencer?.platform || 'INSTAGRAM',
    impressions: m.impressions, reach: m.reach, views: m.views,
    likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
  })))

  // Pre-fetch thumbnail images for top posts (max 30)
  const topPosts = [...posts]
    .sort((a, b) => {
      const emvA = calculateEMV({ platform: a.influencer?.platform || 'INSTAGRAM', impressions: a.impressions, reach: a.reach, views: a.views, clicks: 0, likes: a.likes, comments: a.comments, shares: a.shares, saves: a.saves })
      const emvB = calculateEMV({ platform: b.influencer?.platform || 'INSTAGRAM', impressions: b.impressions, reach: b.reach, views: b.views, clicks: 0, likes: b.likes, comments: b.comments, shares: b.shares, saves: b.saves })
      return emvB.extended - emvA.extended
    })
    .slice(0, 30)

  const imagePromises = topPosts.map(p => p.thumbnailUrl ? fetchImageBase64(p.thumbnailUrl) : Promise.resolve(null))
  const images = await Promise.allSettled(imagePromises)
  const imageMap = new Map<string, string>()
  topPosts.forEach((p, i) => {
    const result = images[i]
    if (result.status === 'fulfilled' && result.value && p.thumbnailUrl) {
      imageMap.set(p.thumbnailUrl, result.value)
    }
  })

  // ==========================================
  // PAGE 1: COVER
  // ==========================================
  // Full purple background
  doc.setFillColor(...darkPurple)
  doc.rect(0, 0, W, H, 'F')

  // Gradient accent
  doc.setFillColor(...purple)
  doc.rect(0, 0, W, H * 0.4, 'F')

  // Brand logo + name
  if (TKOC_LOGO_BASE64) {
    try {
      doc.addImage(`data:image/png;base64,${TKOC_LOGO_BASE64}`, 'PNG', M, 25, 40, 15)
    } catch { /* logo optional */ }
  }
  doc.setTextColor(...white)
  doc.setFontSize(12)
  doc.setFont('helvetica', 'normal')
  doc.text('TKOC INTELLIGENCE', M, TKOC_LOGO_BASE64 ? 50 : 40)

  // Divider line
  doc.setDrawColor(255, 255, 255, 80)
  doc.setLineWidth(0.5)
  const dividerY = TKOC_LOGO_BASE64 ? 54 : 46
  doc.line(M, dividerY, M + 50, dividerY)

  // Cover image (if provided)
  if (options?.coverImageUrl) {
    try {
      const coverImg = await fetchImageBase64(options.coverImageUrl)
      if (coverImg) {
        // Semi-transparent overlay on cover image
        doc.addImage(`data:image/jpeg;base64,${coverImg}`, 'JPEG', 0, 0, W, H)
        // Dark overlay for text readability
        doc.setFillColor(0, 0, 0)
        doc.setGState(new (doc as unknown as { GState: new (opts: { opacity: number }) => unknown }).GState({ opacity: 0.55 }))
        doc.rect(0, 0, W, H, 'F')
        doc.setGState(new (doc as unknown as { GState: new (opts: { opacity: number }) => unknown }).GState({ opacity: 1 }))
      }
    } catch { /* cover image optional */ }
  }

  // Campaign name (or custom title)
  const coverTitle = options?.customTitle || campaign.name
  doc.setTextColor(...white)
  doc.setFontSize(32)
  doc.setFont('helvetica', 'bold')
  const nameLines = doc.splitTextToSize(coverTitle, CW)
  const nameY = TKOC_LOGO_BASE64 ? 75 : 70
  doc.text(nameLines, M, nameY)

  // Custom subtitle
  if (options?.customSubtitle) {
    doc.setFontSize(14)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(220, 220, 255)
    doc.text(options.customSubtitle, M, nameY + nameLines.length * 14 + 4)
  }

  // Campaign details
  let coverY = 70 + nameLines.length * 14
  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(200, 200, 255)

  if (campaign.startDate) {
    const start = new Date(campaign.startDate).toLocaleDateString()
    const end = campaign.endDate ? new Date(campaign.endDate).toLocaleDateString() : 'Ongoing'
    doc.text(`${start}  —  ${end}`, M, coverY)
    coverY += 8
  } else {
    doc.text('Always On Campaign', M, coverY)
    coverY += 8
  }

  if (campaign.platforms.length > 0) {
    doc.text(campaign.platforms.map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(' | '), M, coverY)
    coverY += 8
  }

  if (campaign.targetHashtags.length > 0) {
    doc.text(campaign.targetHashtags.slice(0, 8).join('  '), M, coverY)
    coverY += 8
  }

  // Summary stats at bottom of cover
  const statsY = H - 70
  doc.setDrawColor(255, 255, 255, 40)
  doc.line(M, statsY - 10, W - M, statsY - 10)

  const coverStats = [
    { label: 'Influencers', value: campaign.influencers.length.toString() },
    { label: 'Posts', value: posts.length.toString() },
    { label: 'Stories', value: stories.length.toString() },
    { label: 'Total Reach', value: fmt(totalReach) },
  ]

  const statWidth = CW / coverStats.length
  coverStats.forEach((s, i) => {
    const x = M + i * statWidth
    doc.setFontSize(28)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...white)
    doc.text(s.value, x, statsY + 4)

    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(200, 200, 255)
    doc.text(s.label.toUpperCase(), x, statsY + 12)
  })

  // Footer
  doc.setFontSize(7)
  doc.setTextColor(180, 180, 220)
  doc.text(`Report generated on ${new Date().toLocaleDateString()}`, M, H - 12)
  doc.text('TKOC Intelligence', W - M, H - 12, { align: 'right' })

  // ==========================================
  // PAGE 2: CAMPAIGN SUMMARY
  // ==========================================
  doc.addPage()
  let y = 20

  // Header bar
  doc.setFillColor(...purple)
  doc.rect(0, 0, W, 14, 'F')
  doc.setFontSize(9)
  doc.setTextColor(...white)
  doc.setFont('helvetica', 'bold')
  doc.text('CAMPAIGN SUMMARY', M, 9)
  doc.text(campaign.name, W - M, 9, { align: 'right' })

  y = 24

  // Metric cards - 4 per row, 2 rows
  const allMetrics = [
    { label: 'INFLUENCERS', value: campaign.influencers.length.toString(), color: purple },
    { label: 'POSTS', value: posts.length.toString(), color: purple },
    { label: 'STORIES', value: stories.length.toString(), color: purple },
    { label: 'TOTAL REACH', value: fmt(totalReach), color: purple },
    { label: 'ENGAGEMENTS', value: fmt(totalEngagements), color: gray900 },
    { label: 'ENG. RATE', value: engRate + '%', color: gray900 },
    { label: 'TOTAL VIEWS', value: fmt(totalViews), color: gray900 },
    { label: 'TOTAL LIKES', value: fmt(totalLikes), color: gray900 },
  ]

  const cardW = (CW - 9) / 4
  const cardH = 28

  allMetrics.forEach((m, i) => {
    const row = Math.floor(i / 4)
    const col = i % 4
    const x = M + col * (cardW + 3)
    const cy = y + row * (cardH + 4)

    doc.setFillColor(...white)
    doc.setDrawColor(...gray200)
    doc.roundedRect(x, cy, cardW, cardH, 2, 2, 'FD')

    doc.setFontSize(7)
    doc.setTextColor(...gray500)
    doc.setFont('helvetica', 'normal')
    doc.text(m.label, x + 4, cy + 9)

    doc.setFontSize(18)
    doc.setTextColor(...m.color)
    doc.setFont('helvetica', 'bold')
    doc.text(m.value, x + 4, cy + 22)
  })

  y += (cardH + 4) * 2 + 6

  // EMV cards
  doc.setFillColor(236, 253, 245)
  doc.setDrawColor(167, 243, 208)
  doc.roundedRect(M, y, CW / 2 - 2, 24, 2, 2, 'FD')

  doc.setFontSize(7)
  doc.setTextColor(...green600)
  doc.setFont('helvetica', 'normal')
  doc.text('EMV BASICO (Solo alcance)', M + 4, y + 8)
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text(`$${fmt(Math.round(emv.basic))}`, M + 4, y + 19)

  const emvX2 = M + CW / 2 + 2
  doc.setFillColor(243, 232, 255)
  doc.setDrawColor(196, 181, 253)
  doc.roundedRect(emvX2, y, CW / 2 - 2, 24, 2, 2, 'FD')

  doc.setFontSize(7)
  doc.setTextColor(...purple)
  doc.setFont('helvetica', 'normal')
  doc.text('EMV AMPLIADO (Alcance + engagement)', emvX2 + 4, y + 8)
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text(`$${fmt(Math.round(emv.extended))}`, emvX2 + 4, y + 19)

  y += 30

  // Methodology note
  doc.setFillColor(249, 250, 251)
  doc.roundedRect(M, y, CW, 14, 2, 2, 'F')
  doc.setFontSize(6)
  doc.setTextColor(...gray500)
  doc.setFont('helvetica', 'italic')
  doc.text(EMV_METHODOLOGY.es, M + 4, y + 6, { maxWidth: CW - 8 })

  y += 20

  // ==========================================
  // INFLUENCER OVERVIEW TABLE
  // ==========================================
  doc.setFillColor(...purple)
  doc.roundedRect(M, y, CW, 10, 2, 2, 'F')
  doc.setFontSize(10)
  doc.setTextColor(...white)
  doc.setFont('helvetica', 'bold')
  doc.text(`INFLUENCER OVERVIEW (${campaign.influencers.length})`, M + 5, y + 7)
  y += 14

  if (campaign.influencers.length > 0) {
    // Per-influencer media counts
    const influencerMediaCounts = new Map<string, { posts: number; stories: number; totalEng: number }>()
    for (const m of campaign.media) {
      const uname = m.influencer?.username || ''
      const existing = influencerMediaCounts.get(uname) || { posts: 0, stories: 0, totalEng: 0 }
      if (m.mediaType === 'STORY') existing.stories++
      else existing.posts++
      existing.totalEng += (m.likes || 0) + (m.comments || 0) + (m.shares || 0)
      influencerMediaCounts.set(uname, existing)
    }

    const rows = campaign.influencers.map(ci => {
      const inf = ci.influencer
      const counts = influencerMediaCounts.get(inf.username) || { posts: 0, stories: 0, totalEng: 0 }
      return [
        `@${inf.username}`,
        inf.platform.charAt(0) + inf.platform.slice(1).toLowerCase(),
        fmt(inf.followers),
        `${inf.engagementRate || 0}%`,
        fmt(counts.totalEng),
        (counts.posts + counts.stories).toString(),
        counts.posts.toString(),
        counts.stories.toString(),
      ]
    })

    autoTable(doc, {
      startY: y,
      head: [['Account', 'Platform', 'Followers', 'Eng. Rate', 'Total Eng.', 'Media', 'Posts', 'Stories']],
      body: rows,
      theme: 'grid',
      headStyles: {
        fillColor: [243, 232, 255] as [number, number, number],
        textColor: darkPurple,
        fontStyle: 'bold',
        fontSize: 7,
        cellPadding: 3,
      },
      bodyStyles: { fontSize: 7, cellPadding: 2.5, textColor: gray900 },
      alternateRowStyles: { fillColor: [249, 250, 251] as [number, number, number] },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 30 },
        2: { halign: 'right', cellWidth: 20 },
        3: { halign: 'right', cellWidth: 18 },
        4: { halign: 'right', cellWidth: 18 },
        5: { halign: 'center', cellWidth: 14 },
        6: { halign: 'center', cellWidth: 14 },
        7: { halign: 'center', cellWidth: 14 },
      },
      margin: { left: M, right: M },
      // Footer added in final loop across all pages
    })

    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY + 8
  }

  // ==========================================
  // POST CARDS (MightyScout-style)
  // ==========================================
  if (topPosts.length > 0) {
    doc.addPage()
    y = 20

    // Header bar
    doc.setFillColor(...purple)
    doc.rect(0, 0, W, 14, 'F')
    doc.setFontSize(9)
    doc.setTextColor(...white)
    doc.setFont('helvetica', 'bold')
    doc.text(`CONTENT PERFORMANCE (${posts.length} posts, sorted by EMV)`, M, 9)

    y = 22

    for (let i = 0; i < topPosts.length; i++) {
      const post = topPosts[i]
      const postEMV = calculateEMV({
        platform: post.influencer?.platform || 'INSTAGRAM',
        impressions: post.impressions, reach: post.reach, views: post.views,
        clicks: 0, likes: post.likes, comments: post.comments, shares: post.shares, saves: post.saves,
      })

      const cardHeight = 56
      if (y + cardHeight > H - 20) {
        doc.addPage()
        y = 20
        // Add header on new pages
        doc.setFillColor(...purple)
        doc.rect(0, 0, W, 14, 'F')
        doc.setFontSize(9)
        doc.setTextColor(...white)
        doc.setFont('helvetica', 'bold')
        doc.text('CONTENT PERFORMANCE (continued)', M, 9)
        y = 22
      }

      // Card border
      doc.setDrawColor(...gray200)
      doc.setFillColor(...white)
      doc.roundedRect(M, y, CW, cardHeight, 3, 3, 'FD')

      // Thumbnail (left side, 50x50mm)
      const imgSize = 50
      const imgData = post.thumbnailUrl ? imageMap.get(post.thumbnailUrl) : null
      if (imgData) {
        try {
          doc.addImage(imgData, 'JPEG', M + 2, y + 3, imgSize, imgSize)
        } catch {
          // Draw placeholder
          doc.setFillColor(243, 244, 246)
          doc.roundedRect(M + 2, y + 3, imgSize, imgSize, 2, 2, 'F')
          doc.setFontSize(7)
          doc.setTextColor(...gray500)
          doc.text(post.mediaType, M + 2 + imgSize / 2, y + 3 + imgSize / 2, { align: 'center' })
        }
      } else {
        doc.setFillColor(243, 244, 246)
        doc.roundedRect(M + 2, y + 3, imgSize, imgSize, 2, 2, 'F')
        doc.setFontSize(8)
        doc.setTextColor(...gray500)
        doc.text(post.mediaType, M + 2 + imgSize / 2, y + 3 + imgSize / 2, { align: 'center' })
      }

      // Content (right side)
      const textX = M + imgSize + 8
      const textW = CW - imgSize - 12

      // Influencer name + followers
      doc.setFontSize(9)
      doc.setTextColor(...gray900)
      doc.setFont('helvetica', 'bold')
      doc.text(`@${post.influencer?.username || 'unknown'}`, textX, y + 9)

      doc.setFontSize(7)
      doc.setTextColor(...gray500)
      doc.setFont('helvetica', 'normal')
      doc.text(`${fmt(post.influencer?.followers || 0)} followers`, textX + doc.getTextWidth(`@${post.influencer?.username || 'unknown'}  `), y + 9)

      // Engagement metrics row
      const metricsY = y + 17
      const engMetrics = [
        { icon: '♥', val: fmt(post.likes || 0), label: 'likes' },
        { icon: '💬', val: fmt(post.comments || 0), label: 'comments' },
        { icon: '👁', val: fmt(post.views || 0), label: 'views' },
      ]
      if (post.saves > 0) engMetrics.push({ icon: '🔖', val: fmt(post.saves), label: 'saves' })

      doc.setFontSize(7)
      let mx = textX
      for (const em of engMetrics) {
        doc.setTextColor(...gray900)
        doc.setFont('helvetica', 'bold')
        doc.text(`${em.val}`, mx, metricsY)
        mx += doc.getTextWidth(em.val) + 1
        doc.setTextColor(...gray500)
        doc.setFont('helvetica', 'normal')
        doc.text(em.label, mx, metricsY)
        mx += doc.getTextWidth(em.label) + 4
      }

      // Campaign engagement + EMV
      doc.setFontSize(7)
      doc.setTextColor(...gray500)
      doc.setFont('helvetica', 'normal')
      const campaignEng = (post.influencer?.followers || 0) > 0
        ? (((post.likes || 0) + (post.comments || 0)) / (post.influencer?.followers || 1) * 100).toFixed(2)
        : '0.00'
      doc.text(`Campaign Eng: ${campaignEng}%  |  Normal Eng: ${post.influencer?.engagementRate || 0}%`, textX, metricsY + 7)

      // EMV value
      doc.setFontSize(8)
      doc.setTextColor(...green600)
      doc.setFont('helvetica', 'bold')
      doc.text(`Media Value $${postEMV.extended.toFixed(0)}`, textX, metricsY + 14)

      // Date + type badge
      doc.setFontSize(6.5)
      doc.setTextColor(...gray500)
      doc.setFont('helvetica', 'normal')
      const dateStr = post.postedAt ? new Date(post.postedAt).toLocaleString() : ''
      doc.text(`${dateStr}  ${post.mediaType}`, textX, metricsY + 20)

      // Caption preview
      if (post.caption) {
        doc.setFontSize(6)
        doc.setTextColor(156, 163, 175)
        const captionLines = doc.splitTextToSize(post.caption.substring(0, 120), textW)
        doc.text(captionLines.slice(0, 2), textX, metricsY + 26)
      }

      // Clickable link (whole card area)
      if (post.permalink) {
        doc.link(M, y, CW, cardHeight, { url: post.permalink })
      }

      y += cardHeight + 4
    }
  }

  // ==========================================
  // STORIES SECTION
  // ==========================================
  if (stories.length > 0) {
    if (y > H - 60) {
      doc.addPage()
      y = 20
    }

    doc.setFillColor(...purple)
    doc.roundedRect(M, y, CW, 10, 2, 2, 'F')
    doc.setFontSize(10)
    doc.setTextColor(...white)
    doc.setFont('helvetica', 'bold')
    doc.text(`STORIES (${stories.length})`, M + 5, y + 7)
    y += 14

    const storyRows = stories.map(s => {
      const sEmv = calculateEMV({
        platform: s.influencer?.platform || 'INSTAGRAM',
        impressions: s.impressions, reach: s.reach, views: s.views,
        clicks: 0, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saves,
      })
      return [
        s.influencer?.username ? `@${s.influencer.username}` : '-',
        fmt(s.influencer?.followers || 0),
        fmt(s.views || 0),
        `$${sEmv.extended.toFixed(0)}`,
        s.postedAt ? new Date(s.postedAt).toLocaleDateString() : '-',
        s.permalink ? 'View' : '-',
      ]
    })

    autoTable(doc, {
      startY: y,
      head: [['Account', 'Followers', 'Views', 'Media Value', 'Date', 'Link']],
      body: storyRows,
      theme: 'grid',
      headStyles: {
        fillColor: [243, 232, 255] as [number, number, number],
        textColor: darkPurple,
        fontStyle: 'bold',
        fontSize: 7,
        cellPadding: 3,
      },
      bodyStyles: { fontSize: 7, cellPadding: 2.5, textColor: gray900 },
      alternateRowStyles: { fillColor: [249, 250, 251] as [number, number, number] },
      margin: { left: M, right: M },
      didDrawCell: (data) => {
        // Make "View" links clickable
        if (data.section === 'body' && data.column.index === 5 && data.cell.text[0] === 'View') {
          const story = stories[data.row.index]
          if (story?.permalink) {
            doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url: story.permalink })
          }
        }
      },
      // Footer added in final loop across all pages
    })
  }

  // Add footer + page numbers to ALL pages (skip cover page 1)
  const totalPages = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages()
  for (let i = 2; i <= totalPages; i++) {
    doc.setPage(i)
    addFooter(doc, W, H, campaign.name, i, totalPages)
  }

  // Generate
  const pdfOutput = doc.output('arraybuffer')
  const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_report.pdf`

  return new NextResponse(Buffer.from(pdfOutput), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

function addFooter(doc: jsPDF, pageWidth: number, pageHeight: number, campaignName: string, pageNum: number, totalPages: number) {
  const footerY = pageHeight - 8
  doc.setFillColor(248, 246, 255)
  doc.rect(0, footerY - 4, pageWidth, 12, 'F')

  doc.setFontSize(6)
  doc.setTextColor(156, 163, 175)
  doc.setFont('helvetica', 'normal')
  doc.text(`TKOC Intelligence  |  ${campaignName}  |  ${new Date().toLocaleDateString()}`, 15, footerY)
  doc.text(`${pageNum} / ${totalPages}`, pageWidth - 15, footerY, { align: 'right' })
}

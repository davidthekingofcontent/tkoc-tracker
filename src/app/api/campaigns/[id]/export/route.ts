import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

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
          include: {
            influencer: true,
          },
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

    if (format === 'csv') {
      return generateCSV(campaign)
    }

    if (format === 'pdf') {
      return generatePDF(campaign)
    }

    return NextResponse.json({ error: 'Unsupported format. Use csv or pdf.' }, { status: 400 })
  } catch (error) {
    console.error('Export campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface CampaignData {
  name: string
  status: string
  startDate: Date | null
  endDate: Date | null
  platforms: string[]
  targetHashtags: string[]
  targetAccounts: string[]
  influencers: {
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
    likes: number
    comments: number
    shares: number
    saves: number
    views: number
    reach: number
    impressions: number
    postedAt: Date | null
    influencer: {
      username: string
      displayName: string | null
      platform: string
      followers: number
      engagementRate: number
    } | null
  }[]
}

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function generateCSV(campaign: CampaignData): NextResponse {
  const lines: string[] = []

  // Campaign Summary Section
  lines.push('CAMPAIGN REPORT')
  lines.push(`Campaign Name,${escapeCSV(campaign.name)}`)
  lines.push(`Status,${escapeCSV(campaign.status)}`)
  lines.push(`Start Date,${campaign.startDate ? new Date(campaign.startDate).toLocaleDateString() : 'N/A'}`)
  lines.push(`End Date,${campaign.endDate ? new Date(campaign.endDate).toLocaleDateString() : 'N/A'}`)
  lines.push(`Platforms,${escapeCSV(campaign.platforms.join(', '))}`)
  lines.push(`Hashtags,${escapeCSV(campaign.targetHashtags.join(', '))}`)
  lines.push(`Tracked Accounts,${escapeCSV(campaign.targetAccounts.join(', '))}`)
  lines.push('')

  // Aggregate metrics
  let totalReach = 0
  let totalLikes = 0
  let totalComments = 0
  let totalShares = 0
  let totalViews = 0

  for (const m of campaign.media) {
    totalReach += m.reach || 0
    totalLikes += m.likes || 0
    totalComments += m.comments || 0
    totalShares += m.shares || 0
    totalViews += m.views || 0
  }

  const totalEngagements = totalLikes + totalComments + totalShares
  const engRate = totalReach > 0 ? ((totalEngagements / totalReach) * 100).toFixed(2) : '0'

  lines.push('OVERVIEW')
  lines.push(`Total Influencers,${campaign.influencers.length}`)
  lines.push(`Total Media,${campaign.media.length}`)
  lines.push(`Total Reach,${totalReach}`)
  lines.push(`Total Engagements,${totalEngagements}`)
  lines.push(`Engagement Rate,${engRate}%`)
  lines.push(`Total Likes,${totalLikes}`)
  lines.push(`Total Comments,${totalComments}`)
  lines.push(`Total Shares,${totalShares}`)
  lines.push(`Total Views,${totalViews}`)
  lines.push('')

  // Influencers Section
  lines.push('INFLUENCERS')
  lines.push('Username,Display Name,Platform,Followers,Engagement Rate,Avg Likes,Avg Comments,Avg Views,Email,Website,Location')

  for (const ci of campaign.influencers) {
    const inf = ci.influencer
    lines.push([
      escapeCSV(inf.username),
      escapeCSV(inf.displayName),
      escapeCSV(inf.platform),
      inf.followers,
      `${inf.engagementRate}%`,
      inf.avgLikes,
      inf.avgComments,
      inf.avgViews,
      escapeCSV(inf.email),
      escapeCSV(inf.website),
      escapeCSV([inf.city, inf.country].filter(Boolean).join(', ')),
    ].join(','))
  }

  lines.push('')

  // Media Section
  lines.push('MEDIA')
  lines.push('Date,Influencer,Platform,Type,Likes,Comments,Shares,Views,Reach,Impressions,Link,Caption')

  for (const media of campaign.media) {
    lines.push([
      media.postedAt ? new Date(media.postedAt).toLocaleDateString() : '',
      escapeCSV(media.influencer?.username || ''),
      escapeCSV(media.influencer?.platform || ''),
      escapeCSV(media.mediaType),
      media.likes,
      media.comments,
      media.shares,
      media.views,
      media.reach,
      media.impressions,
      escapeCSV(media.permalink),
      escapeCSV(media.caption?.substring(0, 200)),
    ].join(','))
  }

  const csvContent = lines.join('\n')

  // Add BOM for Excel UTF-8 compatibility
  const bom = '\uFEFF'

  const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_report.csv`

  return new NextResponse(bom + csvContent, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

// ============ PDF GENERATION ============

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

function generatePDF(campaign: CampaignData): NextResponse {
  const doc = new jsPDF('p', 'mm', 'a4')
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 15
  const contentWidth = pageWidth - margin * 2

  // Colors
  const purple = [124, 58, 237] as [number, number, number]       // #7C3AED
  const darkPurple = [91, 33, 182] as [number, number, number]    // #5B21B6
  const gray900 = [17, 24, 39] as [number, number, number]
  const gray500 = [107, 114, 128] as [number, number, number]
  const gray200 = [229, 231, 235] as [number, number, number]
  const white = [255, 255, 255] as [number, number, number]

  // Calculate metrics
  let totalReach = 0, totalLikes = 0, totalComments = 0, totalShares = 0, totalViews = 0

  for (const m of campaign.media) {
    totalReach += m.reach || 0
    totalLikes += m.likes || 0
    totalComments += m.comments || 0
    totalShares += m.shares || 0
    totalViews += m.views || 0
  }

  const totalEngagements = totalLikes + totalComments + totalShares
  const engRate = totalReach > 0 ? ((totalEngagements / totalReach) * 100).toFixed(2) : '0.00'
  const emv = totalEngagements * 0.15

  // ===== HEADER BAR =====
  doc.setFillColor(...darkPurple)
  doc.rect(0, 0, pageWidth, 42, 'F')

  // Gradient overlay effect
  doc.setFillColor(...purple)
  doc.rect(0, 0, pageWidth * 0.6, 42, 'F')

  // Brand name
  doc.setTextColor(...white)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text('TKOC TRACKER', margin, 14)

  // Campaign name
  doc.setFontSize(20)
  doc.setFont('helvetica', 'bold')
  const campaignName = campaign.name.length > 40 ? campaign.name.substring(0, 40) + '...' : campaign.name
  doc.text(campaignName, margin, 28)

  // Status + type
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  const statusText = `${campaign.status} | ${campaign.platforms.join(', ')} | Generated ${new Date().toLocaleDateString()}`
  doc.text(statusText, margin, 37)

  let y = 52

  // ===== CAMPAIGN INFO STRIP =====
  doc.setFillColor(248, 246, 255) // very light purple
  doc.roundedRect(margin, y, contentWidth, 22, 3, 3, 'F')

  doc.setFontSize(8)
  doc.setTextColor(...gray500)
  doc.setFont('helvetica', 'normal')

  const infoItems: string[] = []
  if (campaign.startDate) {
    const start = new Date(campaign.startDate).toLocaleDateString()
    const end = campaign.endDate ? new Date(campaign.endDate).toLocaleDateString() : 'Ongoing'
    infoItems.push(`Period: ${start} - ${end}`)
  } else {
    infoItems.push('Always On')
  }
  if (campaign.targetHashtags.length > 0) {
    infoItems.push(`Hashtags: ${campaign.targetHashtags.slice(0, 5).join(', ')}`)
  }
  if (campaign.targetAccounts.length > 0) {
    infoItems.push(`Accounts: ${campaign.targetAccounts.slice(0, 5).join(', ')}`)
  }

  doc.text(infoItems.join('  |  '), margin + 6, y + 9)

  // Second line if needed
  if (campaign.targetHashtags.length > 5 || campaign.targetAccounts.length > 5) {
    doc.text('+ more targets', margin + 6, y + 16)
  }

  y += 30

  // ===== METRICS CARDS =====
  const metrics = [
    { label: 'Influencers', value: campaign.influencers.length.toString(), color: purple },
    { label: 'Media Posts', value: campaign.media.length.toString(), color: purple },
    { label: 'Total Reach', value: formatNum(totalReach), color: purple },
    { label: 'Engagements', value: formatNum(totalEngagements), color: purple },
  ]

  const cardWidth = (contentWidth - 9) / 4
  const cardHeight = 28

  metrics.forEach((metric, i) => {
    const x = margin + i * (cardWidth + 3)

    // Card background
    doc.setFillColor(...white)
    doc.setDrawColor(...gray200)
    doc.roundedRect(x, y, cardWidth, cardHeight, 2, 2, 'FD')

    // Label
    doc.setFontSize(7)
    doc.setTextColor(...gray500)
    doc.setFont('helvetica', 'normal')
    doc.text(metric.label.toUpperCase(), x + 5, y + 9)

    // Value
    doc.setFontSize(18)
    doc.setTextColor(...metric.color)
    doc.setFont('helvetica', 'bold')
    doc.text(metric.value, x + 5, y + 22)
  })

  y += cardHeight + 6

  // Second metrics row
  const metrics2 = [
    { label: 'Total Likes', value: formatNum(totalLikes) },
    { label: 'Total Comments', value: formatNum(totalComments) },
    { label: 'Total Views', value: formatNum(totalViews) },
    { label: 'Eng. Rate', value: engRate + '%' },
  ]

  metrics2.forEach((metric, i) => {
    const x = margin + i * (cardWidth + 3)

    doc.setFillColor(...white)
    doc.setDrawColor(...gray200)
    doc.roundedRect(x, y, cardWidth, cardHeight, 2, 2, 'FD')

    doc.setFontSize(7)
    doc.setTextColor(...gray500)
    doc.setFont('helvetica', 'normal')
    doc.text(metric.label.toUpperCase(), x + 5, y + 9)

    doc.setFontSize(18)
    doc.setTextColor(...gray900)
    doc.setFont('helvetica', 'bold')
    doc.text(metric.value, x + 5, y + 22)
  })

  y += cardHeight + 4

  // EMV card if relevant
  if (emv > 0) {
    doc.setFillColor(236, 253, 245) // green-50
    doc.setDrawColor(167, 243, 208) // green-300
    doc.roundedRect(margin, y, contentWidth, 16, 2, 2, 'FD')

    doc.setFontSize(8)
    doc.setTextColor(5, 150, 105) // green-600
    doc.setFont('helvetica', 'bold')
    doc.text(`Estimated Media Value (EMV): $${formatNum(Math.round(emv))}`, margin + 6, y + 10)
    y += 22
  } else {
    y += 4
  }

  // ===== INFLUENCERS TABLE =====
  if (campaign.influencers.length > 0) {
    // Section header
    doc.setFillColor(...purple)
    doc.roundedRect(margin, y, contentWidth, 10, 2, 2, 'F')
    doc.setFontSize(10)
    doc.setTextColor(...white)
    doc.setFont('helvetica', 'bold')
    doc.text(`INFLUENCERS (${campaign.influencers.length})`, margin + 5, y + 7)
    y += 14

    const influencerRows = campaign.influencers.map(ci => {
      const inf = ci.influencer
      return [
        `@${inf.username}`,
        inf.displayName || '-',
        inf.platform,
        formatNum(inf.followers),
        `${inf.engagementRate || 0}%`,
        formatNum(inf.avgLikes || 0),
        formatNum(inf.avgComments || 0),
        inf.email || '-',
      ]
    })

    autoTable(doc, {
      startY: y,
      head: [['Username', 'Name', 'Platform', 'Followers', 'Eng. Rate', 'Avg Likes', 'Avg Comments', 'Email']],
      body: influencerRows,
      theme: 'grid',
      headStyles: {
        fillColor: [243, 232, 255] as [number, number, number], // purple-100
        textColor: [...darkPurple] as [number, number, number],
        fontStyle: 'bold',
        fontSize: 7,
        cellPadding: 3,
      },
      bodyStyles: {
        fontSize: 7,
        cellPadding: 2.5,
        textColor: [...gray900] as [number, number, number],
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251] as [number, number, number], // gray-50
      },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 28 },
        1: { cellWidth: 28 },
        2: { cellWidth: 18 },
        3: { cellWidth: 20, halign: 'right' },
        4: { cellWidth: 18, halign: 'right' },
        5: { cellWidth: 18, halign: 'right' },
        6: { cellWidth: 20, halign: 'right' },
        7: { cellWidth: 30 },
      },
      margin: { left: margin, right: margin },
      didDrawPage: () => {
        addFooter(doc, pageWidth, pageHeight, campaign.name)
      },
    })

    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY + 8
  }

  // ===== MEDIA TABLE =====
  if (campaign.media.length > 0) {
    // Check if we need a new page
    if (y > pageHeight - 60) {
      doc.addPage()
      y = 20
    }

    // Section header
    doc.setFillColor(...purple)
    doc.roundedRect(margin, y, contentWidth, 10, 2, 2, 'F')
    doc.setFontSize(10)
    doc.setTextColor(...white)
    doc.setFont('helvetica', 'bold')
    doc.text(`MEDIA CONTENT (${campaign.media.length})`, margin + 5, y + 7)
    y += 14

    // Show top 100 media items max for PDF
    const mediaRows = campaign.media.slice(0, 100).map(m => [
      m.postedAt ? new Date(m.postedAt).toLocaleDateString() : '-',
      m.influencer?.username ? `@${m.influencer.username}` : '-',
      m.mediaType,
      formatNum(m.likes || 0),
      formatNum(m.comments || 0),
      formatNum(m.views || 0),
      formatNum(m.reach || 0),
      (m.caption || '').substring(0, 50) + ((m.caption || '').length > 50 ? '...' : ''),
    ])

    autoTable(doc, {
      startY: y,
      head: [['Date', 'Creator', 'Type', 'Likes', 'Comments', 'Views', 'Reach', 'Caption']],
      body: mediaRows,
      theme: 'grid',
      headStyles: {
        fillColor: [243, 232, 255] as [number, number, number],
        textColor: [...darkPurple] as [number, number, number],
        fontStyle: 'bold',
        fontSize: 7,
        cellPadding: 3,
      },
      bodyStyles: {
        fontSize: 6.5,
        cellPadding: 2,
        textColor: [...gray900] as [number, number, number],
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251] as [number, number, number],
      },
      columnStyles: {
        0: { cellWidth: 18 },
        1: { fontStyle: 'bold', cellWidth: 22 },
        2: { cellWidth: 14 },
        3: { cellWidth: 15, halign: 'right' },
        4: { cellWidth: 18, halign: 'right' },
        5: { cellWidth: 15, halign: 'right' },
        6: { cellWidth: 15, halign: 'right' },
        7: { cellWidth: 63 },
      },
      margin: { left: margin, right: margin },
      didDrawPage: () => {
        addFooter(doc, pageWidth, pageHeight, campaign.name)
      },
    })

    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY + 8
  }

  // ===== TOP PERFORMERS =====
  if (campaign.media.length > 0) {
    if (y > pageHeight - 80) {
      doc.addPage()
      y = 20
    }

    doc.setFillColor(...purple)
    doc.roundedRect(margin, y, contentWidth, 10, 2, 2, 'F')
    doc.setFontSize(10)
    doc.setTextColor(...white)
    doc.setFont('helvetica', 'bold')
    doc.text('TOP PERFORMING CONTENT', margin + 5, y + 7)
    y += 16

    // Top 5 by engagement
    const topMedia = [...campaign.media]
      .sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)))
      .slice(0, 5)

    topMedia.forEach((m, i) => {
      if (y > pageHeight - 30) {
        doc.addPage()
        y = 20
      }

      const engagements = (m.likes || 0) + (m.comments || 0) + (m.shares || 0)

      // Rank badge
      doc.setFillColor(...purple)
      doc.circle(margin + 4, y + 4, 4, 'F')
      doc.setFontSize(8)
      doc.setTextColor(...white)
      doc.setFont('helvetica', 'bold')
      doc.text(`${i + 1}`, margin + 4, y + 5.5, { align: 'center' })

      // Content info
      doc.setFontSize(8)
      doc.setTextColor(...gray900)
      doc.setFont('helvetica', 'bold')
      doc.text(`@${m.influencer?.username || 'unknown'}`, margin + 12, y + 4)

      doc.setFont('helvetica', 'normal')
      doc.setTextColor(...gray500)
      doc.setFontSize(7)
      const stats = `${formatNum(m.likes || 0)} likes | ${formatNum(m.comments || 0)} comments | ${formatNum(m.views || 0)} views | ${formatNum(engagements)} total engagements`
      doc.text(stats, margin + 12, y + 10)

      if (m.caption) {
        doc.setFontSize(6.5)
        doc.setTextColor(156, 163, 175) // gray-400
        const caption = m.caption.substring(0, 100) + (m.caption.length > 100 ? '...' : '')
        doc.text(caption, margin + 12, y + 15, { maxWidth: contentWidth - 16 })
      }

      y += m.caption ? 22 : 16
    })
  }

  // Add footer to last page
  addFooter(doc, pageWidth, pageHeight, campaign.name)

  // Generate PDF buffer
  const pdfOutput = doc.output('arraybuffer')
  const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_report.pdf`

  return new NextResponse(Buffer.from(pdfOutput), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

function addFooter(doc: jsPDF, pageWidth: number, pageHeight: number, campaignName: string) {
  const footerY = pageHeight - 8
  doc.setFillColor(248, 246, 255)
  doc.rect(0, footerY - 4, pageWidth, 12, 'F')

  doc.setFontSize(6)
  doc.setTextColor(156, 163, 175)
  doc.setFont('helvetica', 'normal')
  doc.text(`TKOC Tracker | ${campaignName} | Generated ${new Date().toLocaleDateString()}`, 15, footerY)

  const pageNum = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages()
  doc.text(`Page ${pageNum}`, pageWidth - 15, footerY, { align: 'right' })
}

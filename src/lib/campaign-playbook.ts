/**
 * Campaign Playbook™ — Post-campaign intelligence that tells you
 * what to do NEXT based on what happened.
 *
 * Transforms "here's what happened" into "here's what to do next time":
 * - Which creators to repeat
 * - Which format worked best
 * - Where to shift budget
 * - What to scale and what to cut
 */

// ============ TYPES ============

export interface PlaybookInput {
  campaignName: string
  objective: string         // awareness, engagement, traffic, conversion, content
  totalSpent: number
  totalEMV: number

  influencers: Array<{
    username: string
    platform: string
    agreedFee: number
    totalLikes: number
    totalComments: number
    totalViews: number
    totalShares: number
    totalSaves: number
    mediaPosts: number
    mediaTypes: string[]    // POST, REEL, VIDEO, SHORT, STORY, CAROUSEL
  }>
}

export interface PlaybookResult {
  // Campaign summary
  campaignGrade: string     // A+, A, B, C, D, F
  roiRatio: number
  roiVerdict: string        // "Strong ROI", "Break even", "Below target"

  // Key insights (3-5 bullet points)
  insights: PlaybookInsight[]

  // Creator rankings
  topPerformer: { username: string; reason: string } | null
  worstPerformer: { username: string; reason: string } | null
  repeatList: string[]      // usernames to definitely repeat
  skipList: string[]        // usernames to skip next time

  // Format analysis
  bestFormat: { format: string; reason: string } | null
  worstFormat: { format: string; reason: string } | null

  // Budget recommendation
  budgetAdvice: string

  // Next campaign recommendation
  nextCampaignRec: string
}

export interface PlaybookInsight {
  type: 'success' | 'warning' | 'action' | 'insight' | 'info'
  icon: string              // emoji
  text: string
  textKey: string           // i18n key
}

// ============ MAIN FUNCTION ============

export function generatePlaybook(input: PlaybookInput): PlaybookResult {
  const { influencers, totalSpent, totalEMV, objective } = input

  if (influencers.length === 0) {
    return createEmptyPlaybook(input)
  }

  // Calculate ROI
  const roiRatio = totalSpent > 0 ? Math.round((totalEMV / totalSpent) * 100) / 100 : 0
  const campaignGrade = gradeROI(roiRatio)
  const roiVerdict = roiRatio >= 2.5 ? 'Excellent ROI' :
                     roiRatio >= 1.5 ? 'Strong ROI' :
                     roiRatio >= 1.0 ? 'Positive ROI' :
                     roiRatio >= 0.5 ? 'Below target' :
                     'Poor ROI'

  // Analyze each influencer
  const influencerAnalysis = influencers.map(inf => {
    const totalEngagement = inf.totalLikes + inf.totalComments + inf.totalShares
    const emvShare = totalEMV > 0 ? ((inf.agreedFee > 0 ? inf.agreedFee : 1) / totalSpent) : 0
    const cpm = inf.totalViews > 0 ? (inf.agreedFee / inf.totalViews) * 1000 : Infinity
    const engagementPerEuro = inf.agreedFee > 0 ? totalEngagement / inf.agreedFee : 0

    return {
      ...inf,
      totalEngagement,
      emvShare,
      cpm,
      engagementPerEuro,
    }
  })

  // Sort by engagement per euro (efficiency)
  const sorted = [...influencerAnalysis].sort((a, b) => b.engagementPerEuro - a.engagementPerEuro)

  // Top/worst performers
  const topPerformer = sorted[0] ? {
    username: sorted[0].username,
    reason: `Generated ${sorted[0].totalEngagement.toLocaleString()} engagements at €${sorted[0].cpm.toFixed(0)} CPM — best efficiency in campaign.`,
  } : null

  const worstPerformer = sorted.length > 1 ? {
    username: sorted[sorted.length - 1].username,
    reason: `Lowest engagement-per-euro ratio. CPM of €${sorted[sorted.length - 1].cpm.toFixed(0)} with only ${sorted[sorted.length - 1].totalEngagement.toLocaleString()} engagements.`,
  } : null

  // Repeat / skip lists
  const repeatList = sorted
    .filter(inf => inf.engagementPerEuro >= (sorted[0]?.engagementPerEuro || 0) * 0.5 && inf.cpm < 30)
    .map(inf => inf.username)
  const skipList = sorted
    .filter(inf => inf.engagementPerEuro < (sorted[0]?.engagementPerEuro || 0) * 0.2 || inf.cpm > 50)
    .map(inf => inf.username)

  // Format analysis
  const formatMap = new Map<string, { views: number; engagement: number; posts: number }>()
  for (const inf of influencerAnalysis) {
    for (const type of inf.mediaTypes) {
      const existing = formatMap.get(type) || { views: 0, engagement: 0, posts: 0 }
      existing.views += inf.totalViews / (inf.mediaTypes.length || 1)
      existing.engagement += inf.totalEngagement / (inf.mediaTypes.length || 1)
      existing.posts += inf.mediaPosts / (inf.mediaTypes.length || 1)
      formatMap.set(type, existing)
    }
  }

  let bestFormat: PlaybookResult['bestFormat'] = null
  let worstFormat: PlaybookResult['worstFormat'] = null
  if (formatMap.size > 1) {
    const formats = Array.from(formatMap.entries())
      .map(([format, data]) => ({ format, engPerPost: data.posts > 0 ? data.engagement / data.posts : 0 }))
      .sort((a, b) => b.engPerPost - a.engPerPost)

    bestFormat = {
      format: formats[0].format,
      reason: `${Math.round(formats[0].engPerPost).toLocaleString()} avg engagements per post — ${Math.round(formats[0].engPerPost / (formats[formats.length - 1].engPerPost || 1))}x better than ${formats[formats.length - 1].format}.`,
    }
    worstFormat = {
      format: formats[formats.length - 1].format,
      reason: `Only ${Math.round(formats[formats.length - 1].engPerPost).toLocaleString()} avg engagements per post.`,
    }
  }

  // Generate insights
  const insights = generateInsights(input, influencerAnalysis, sorted, roiRatio, bestFormat, worstFormat)

  // Budget advice
  const budgetAdvice = generateBudgetAdvice(roiRatio, sorted, totalSpent)

  // Next campaign recommendation
  const nextCampaignRec = generateNextCampaignRec(input, roiRatio, sorted, bestFormat)

  return {
    campaignGrade,
    roiRatio,
    roiVerdict,
    insights,
    topPerformer,
    worstPerformer,
    repeatList,
    skipList,
    bestFormat,
    worstFormat,
    budgetAdvice,
    nextCampaignRec,
  }
}

// ============ HELPERS ============

function gradeROI(roi: number): string {
  if (roi >= 3.0) return 'A+'
  if (roi >= 2.5) return 'A'
  if (roi >= 2.0) return 'B+'
  if (roi >= 1.5) return 'B'
  if (roi >= 1.0) return 'C'
  if (roi >= 0.5) return 'D'
  return 'F'
}

function generateInsights(
  input: PlaybookInput,
  analysis: Array<{ username: string; totalEngagement: number; cpm: number; engagementPerEuro: number; totalViews: number; agreedFee: number }>,
  sorted: typeof analysis,
  roi: number,
  bestFormat: PlaybookResult['bestFormat'],
  worstFormat: PlaybookResult['worstFormat']
): PlaybookInsight[] {
  const insights: PlaybookInsight[] = []

  // ROI insight
  if (roi >= 2.0) {
    insights.push({
      type: 'success',
      icon: '🎯',
      text: `Campaign generated ${roi.toFixed(1)}x return on investment. Strong performance.`,
      textKey: 'playbook_roi_strong',
    })
  } else if (roi < 1.0) {
    insights.push({
      type: 'warning',
      icon: '⚠️',
      text: `Campaign EMV (€${input.totalEMV.toLocaleString()}) was below investment (€${input.totalSpent.toLocaleString()}). ROI is ${roi.toFixed(1)}x.`,
      textKey: 'playbook_roi_negative',
    })
  }

  // Concentration risk
  if (sorted.length >= 3) {
    const topShare = sorted[0].totalEngagement / analysis.reduce((sum, a) => sum + a.totalEngagement, 0)
    if (topShare > 0.5) {
      insights.push({
        type: 'insight',
        icon: '📊',
        text: `@${sorted[0].username} generated ${Math.round(topShare * 100)}% of all engagement. High concentration risk — diversify next time.`,
        textKey: 'playbook_concentration_risk',
      })
    }
  }

  // Format insight
  if (bestFormat) {
    insights.push({
      type: 'action',
      icon: '🎬',
      text: `${bestFormat.format}s performed best. ${bestFormat.reason} Focus budget on this format next time.`,
      textKey: 'playbook_best_format',
    })
  }

  // Cost efficiency
  const cheapHighPerformers = sorted.filter(inf => inf.cpm <= 15 && inf.totalEngagement > 100)
  if (cheapHighPerformers.length > 0) {
    insights.push({
      type: 'success',
      icon: '💰',
      text: `${cheapHighPerformers.length} creator(s) delivered strong results at CPM under €15. These are your best value picks.`,
      textKey: 'playbook_value_picks',
    })
  }

  // Underperformers
  const expensive = sorted.filter(inf => inf.cpm > 30 && inf.totalEngagement < 500)
  if (expensive.length > 0) {
    insights.push({
      type: 'warning',
      icon: '📉',
      text: `${expensive.length} creator(s) had high CPM (>€30) with low engagement. Cut or renegotiate for next campaign.`,
      textKey: 'playbook_cut_underperformers',
    })
  }

  return insights.slice(0, 5) // Max 5 insights
}

function generateBudgetAdvice(roi: number, sorted: Array<{ username: string; cpm: number; engagementPerEuro: number }>, totalSpent: number): string {
  if (roi >= 2.0) {
    return `Strong ROI at ${roi.toFixed(1)}x. Consider increasing budget by 20-30% and concentrating on top performers.`
  }
  if (roi >= 1.0) {
    return `Positive but modest ROI. Reallocate budget from bottom performers to top creators. Same spend, better distribution.`
  }
  return `Below target ROI. Reduce total budget or dramatically shift to fewer, better-performing creators. Quality over quantity.`
}

function generateNextCampaignRec(
  input: PlaybookInput,
  roi: number,
  sorted: Array<{ username: string; cpm: number; engagementPerEuro: number }>,
  bestFormat: PlaybookResult['bestFormat']
): string {
  const topCreators = sorted.slice(0, Math.ceil(sorted.length * 0.4)).map(s => `@${s.username}`).join(', ')
  const formatRec = bestFormat ? ` Focus on ${bestFormat.format}s.` : ''

  if (roi >= 2.0) {
    return `Scale this campaign. Keep ${topCreators}.${formatRec} Increase budget to amplify what works.`
  }
  if (roi >= 1.0) {
    return `Repeat with a tighter roster: ${topCreators}.${formatRec} Cut underperformers to improve efficiency.`
  }
  return `Rethink the approach. Test with 2-3 proven creators (${topCreators}) at lower fees.${formatRec} Validate before scaling.`
}

function createEmptyPlaybook(input: PlaybookInput): PlaybookResult {
  return {
    campaignGrade: 'N/A',
    roiRatio: 0,
    roiVerdict: 'No data',
    insights: [{
      type: 'info' as const,
      icon: 'ℹ️',
      text: 'No influencer data available yet. Playbook will be generated once content is tracked.',
      textKey: 'playbook_no_data',
    }],
    topPerformer: null,
    worstPerformer: null,
    repeatList: [],
    skipList: [],
    bestFormat: null,
    worstFormat: null,
    budgetAdvice: 'Insufficient data.',
    nextCampaignRec: 'Start tracking influencer content to generate actionable recommendations.',
  }
}

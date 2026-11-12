/**
 * The serializers of the MCP connector: ONE per entity. Everything a tool
 * answers goes through here, and nowhere else is a field of a database row
 * copied into an answer.
 *
 * Each function names the fields it copies, one by one. None of them spreads
 * its input (`...row`), so a column added to the schema tomorrow, or a relation
 * a caller happened to load, can never leak: what is not written here does not
 * leave. Their parameter types are deliberately small (only what is read), so
 * the compiler does not even offer the other columns.
 *
 * NEVER returned by any of them: e-mails, phone numbers, postal or shipping
 * addresses, free-text notes (campaign notes, membership notes, business
 * notes, briefs, bios), captions, tokens, password hashes, invitation tokens.
 *
 * Fees, costs, budgets, CPM, client-reported revenue and every ESTIMATE (EMV,
 * estimated audience) live only in the `*Economics` serializers, whose output
 * is always labelled `internal: true`. A tool calls them only when the caller
 * asked with `includeEconomics: true`.
 *
 * Pure module: no database, no network.
 */
import {
  hasPlausibleViews,
  type CampaignOverview,
  type EngagementRateResult,
  type PerInfluencerMetrics,
  type TargetComparison,
} from '@/lib/metrics'
import { finite, isoDay, isoInstant, shortText, shortTexts } from './shared'

/** Written next to every internal figure. */
export const INTERNAL_NOTICE =
  'Internal agency figures. Do not share them with clients or creators. EMV and estimated audience are estimates, not measurements.'

// ============ Campaign ============

interface CampaignRow {
  id: string
  name: string
  status: string
  type: string
  platforms: readonly string[]
  startDate: Date | string | null
  endDate: Date | string | null
}

/** A campaign as it appears in a list and at the top of its detail. */
export function serializeCampaign(row: CampaignRow, extra: { brand: string | null; creators: number; pieces: number }) {
  return {
    id: row.id,
    name: shortText(row.name) ?? '',
    brand: shortText(extra.brand, 120),
    status: row.status,
    type: row.type,
    platforms: shortTexts(row.platforms, 10, 20),
    startDate: isoDay(row.startDate),
    endDate: isoDay(row.endDate),
    creators: extra.creators,
    pieces: extra.pieces,
  }
}

interface CampaignTargetsRow {
  targetAccounts: readonly string[] | null
  targetHashtags: readonly string[] | null
  targetKeywords: readonly string[] | null
}

/** What makes a publication count for the brand: its accounts, hashtags and product keywords. */
export function serializeBrandTargets(row: CampaignTargetsRow) {
  return {
    accounts: shortTexts(row.targetAccounts),
    hashtags: shortTexts(row.targetHashtags),
    productKeywords: shortTexts(row.targetKeywords),
  }
}

/** The engagement rate as the platform publishes it: null with its reason when the sample is not good enough. */
export function serializeEngagementRate(er: EngagementRateResult | null | undefined) {
  if (!er) return null
  return {
    percent: finite(er.value),
    pieces: er.pieces,
    notPublishedBecause: er.value === null ? (er.reason ?? null) : null,
  }
}

/** One numeric objective of the campaign against what was achieved. */
export function serializeObjective(t: TargetComparison) {
  return {
    metric: t.key,
    target: finite(t.target),
    actual: finite(t.actual),
    variationPercent: finite(t.variationPct),
    verdict: t.verdict,
  }
}

const MISSING_IDS_SHOWN = 20

/**
 * The public figures of a campaign: totals, engagement rate, objectives,
 * delivery checklist and balance. Call it with the overview ALREADY passed
 * through stripEconomics (src/lib/campaign-overview.ts). It copies real
 * figures only: nothing here is a fee, a cost or an estimate.
 */
export function serializeCampaignResults(overview: CampaignOverview) {
  const t = overview.totals
  const d = overview.delivery
  const piecesByType: Record<string, number> = {}
  for (const [type, count] of Object.entries(t.mediaCounts || {})) {
    if (typeof count === 'number' && Number.isFinite(count)) piecesByType[type.slice(0, 20)] = count
  }
  return {
    totals: {
      pieces: t.media,
      posts: t.posts,
      stories: t.stories,
      piecesDeletedByCreator: t.mediaDeleted,
      piecesByType,
      creators: t.members,
      creatorsWithPieces: t.creatorsActive,
      views: t.views,
      likes: t.likes,
      comments: t.comments,
      shares: t.shares,
      saves: t.saves,
      interactions: t.engagements,
      reach: t.reachReal,
      impressions: finite(t.impressionsReal),
      piecesWithRealAudience: t.audience.realPieces,
      engagementRate: serializeEngagementRate(t.er),
      engagementRateOnReach: serializeEngagementRate(overview.erOnReach),
    },
    objectives: overview.targets.filter(o => o.key !== 'cpm').map(serializeObjective),
    delivery: {
      creators: { planned: d.creators.planned, delivered: d.creators.delivered, ok: d.creators.ok },
      pieces: { planned: finite(d.pieces.planned), delivered: d.pieces.delivered, ok: d.pieces.ok },
      dates: { insideCampaignDates: d.dates.inWindow, dated: d.dates.total, ok: d.dates.ok },
      adDisclosure: {
        disclosed: d.disclosure.disclosed,
        piecesChecked: d.disclosure.total,
        ok: d.disclosure.ok,
        missing: d.disclosure.missingMediaIds.length,
        missingPieceIds: d.disclosure.missingMediaIds.slice(0, MISSING_IDS_SHOWN),
      },
      allOk: d.allOk,
    },
    balance: {
      execution: overview.balance.execution,
      results: overview.balance.results,
      dataReliability: overview.balance.dataReliability,
      shareOfPiecesWithRealData: finite(overview.balance.realShare),
    },
  }
}

interface CampaignMoneyRow {
  budget?: number | null
}

/**
 * The internal figures of a campaign. ONLY for `includeEconomics: true`.
 * Call it with the overview as computeCampaignOverview returned it (not
 * stripped). The client's own notes are never included.
 */
export function serializeCampaignEconomics(overview: CampaignOverview, campaign: CampaignMoneyRow) {
  const t = overview.totals
  const b = overview.business
  const cpmObjective = overview.targets.find(o => o.key === 'cpm')
  return {
    internal: true as const,
    notice: INTERNAL_NOTICE,
    currency: 'EUR',
    budget: finite(campaign.budget),
    cost: t.cost,
    creatorsWithCost: t.membersWithCost,
    cpm: finite(t.cpm),
    cpmObjective: cpmObjective ? serializeObjective(cpmObjective) : null,
    efficiency: overview.balance.efficiency,
    emv: {
      estimate: true as const,
      extended: t.emvExtended,
      basic: t.emvBasic,
      ratioToCost: finite(t.emvRatio),
      fromStoriesWithRealViews: t.emvRealStories,
      fromStoriesEstimated: t.emvEstimatedStories,
      estimatedAudienceBehindIt: t.emvEstimatedAudience,
      trustMultiplier: finite(t.emvTrustMultiplier) ?? 1,
    },
    estimatedAudience: {
      estimate: true as const,
      estimated: t.audience.estimated,
      realPlusEstimated: t.audience.total,
      estimatedShare: finite(Math.round(t.audience.estimatedShare * 100) / 100),
    },
    clientReportedResults: b
      ? {
          promoCode: shortText(b.promoCode, 60),
          codeRedemptions: finite(b.codeRedemptions),
          sales: finite(b.clientReportedSales),
          leads: finite(b.clientReportedLeads),
          revenue: finite(b.clientReportedRevenue),
          reportedAt: isoInstant(b.reportedAt),
          costPerAcquisition: finite(b.cpa),
          roas: finite(b.roas),
        }
      : null,
  }
}

// ============ A creator inside a campaign ============

/** One member of a campaign with her figures in it. `p` comes from the STRIPPED overview. */
export function serializeCampaignCreator(p: PerInfluencerMetrics) {
  return {
    creatorId: p.influencerId,
    handle: shortText(p.username, 80) ?? '',
    network: p.platform,
    status: p.status,
    followers: p.followers,
    pieces: p.media,
    posts: p.posts,
    stories: p.stories,
    piecesDeletedByCreator: p.deleted,
    piecesPlanned: finite(p.deliverablesPlanned),
    views: p.views,
    interactions: p.engagements,
    engagementRate: serializeEngagementRate(p.er),
  }
}

interface MembershipMoneyRow {
  agreedFee?: number | null
}

/**
 * The internal figures of one member. ONLY for `includeEconomics: true`.
 * `p` comes from the overview as computed (not stripped). `cost` is the
 * figure the platform uses everywhere: the agreed fee, or the product cost
 * when there is no fee.
 */
export function serializeCampaignCreatorEconomics(p: PerInfluencerMetrics, membership: MembershipMoneyRow | null | undefined) {
  return {
    internal: true as const,
    currency: 'EUR',
    fee: finite(membership?.agreedFee),
    cost: p.cost,
    cpm: finite(p.cpm),
    emvExtended: p.emvExtended,
    emvBasic: p.emvBasic,
    emvRatioToCost: finite(p.emvRatio),
  }
}

// ============ Publication ============

interface MediaRow {
  id: string
  permalink: string | null
  platform: string
  mediaType: string
  postedAt: Date | string | null
  likes: number
  comments: number
  shares: number
  saves: number
  views: number
  reach: number
  source: string
  insightsSource: string | null
  isDeleted: boolean
  influencer?: { username: string } | null
}

/** A link is only returned when it is an http(s) URL of reasonable length. */
function safeLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 400) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * The figures of one publication that are often "no data" stored as 0, and
 * the rule that tells them apart (null = not known), the same one the
 * platform's screens use:
 *  - views: only when plausible (hasPlausibleViews of src/lib/metrics.ts:
 *    above 0 and at least the likes). Images, carousels and scraped stories
 *    publish no views, Meta delivers reels with 0, and a public view count
 *    below the likes is not a real audience: the screens show «—» for all of
 *    them and the overview does not count them as real views;
 *  - reach: only above 0. Only the creator's own statistics carry it;
 *  - saves: only above 0. No public scrape reads them (src/lib/apify.ts
 *    writes 0 on every network), and Meta answers 0 for the posts of other
 *    accounts that tag the brand (src/lib/meta-materialize.ts);
 *  - shares: above 0, or a 0 that a public TikTok scrape really read (TikTok
 *    publishes them; the Instagram and YouTube scrapes write 0).
 * A zero the creator really had is therefore returned as null too: it is the
 * honest side to err on.
 */
function measuredFigures(row: MediaRow) {
  const positive = (n: number) => (Number.isFinite(n) && n > 0 ? n : null)
  const sharesPublished = row.platform === 'TIKTOK' && row.source === 'apify'
  return {
    views: hasPlausibleViews(row) ? row.views : null,
    reach: positive(row.reach),
    saves: positive(row.saves),
    shares: sharesPublished && row.shares === 0 ? 0 : positive(row.shares),
  }
}

/**
 * One publication of a campaign. `capturedBy` is how the row entered the
 * platform (apify: public scrape; meta_api: the connected account; manual:
 * added by a person); `statsFrom` is where the creator's own statistics came
 * from, when she provided them. views, reach, saves and shares are null when
 * the figure is not known for this piece (measuredFigures), never a made-up 0.
 * The caption is never returned.
 */
export function serializeMedia(row: MediaRow) {
  const figures = measuredFigures(row)
  return {
    id: row.id,
    permalink: safeLink(row.permalink),
    creator: shortText(row.influencer?.username, 80),
    network: row.platform,
    type: row.mediaType,
    postedAt: isoInstant(row.postedAt),
    likes: row.likes,
    comments: row.comments,
    shares: figures.shares,
    saves: figures.saves,
    views: figures.views,
    reach: figures.reach,
    capturedBy: shortText(row.source, 30),
    statsFrom: shortText(row.insightsSource, 30),
    deletedByCreator: row.isDeleted,
  }
}

// ============ Creator ============

interface CreatorRow {
  id: string
  username: string
  platform: string
  displayName: string | null
  followers: number
  country: string | null
  isVerified: boolean
}

interface CreatorProfileRow extends CreatorRow {
  following: number
  postsCount: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  language: string | null
  lastScraped: Date | string | null
}

/**
 * A creator: her public identity on one network. No contact data: no e-mail,
 * no phone, no website, no bio (bios carry contact details), no city.
 */
export function serializeCreator(row: CreatorRow) {
  return {
    id: row.id,
    handle: shortText(row.username, 80) ?? '',
    network: row.platform,
    name: shortText(row.displayName, 120),
    followers: row.followers,
    country: shortText(row.country, 60),
    verified: row.isVerified,
  }
}

/** The public profile figures of a creator, on top of serializeCreator. Never her usual fee. */
export function serializeCreatorProfile(row: CreatorProfileRow) {
  return {
    ...serializeCreator(row),
    following: row.following,
    posts: row.postsCount,
    profileEngagementRate: finite(row.engagementRate),
    averageLikes: row.avgLikes,
    averageComments: row.avgComments,
    averageViews: row.avgViews,
    language: shortText(row.language, 40),
    profileReadAt: isoInstant(row.lastScraped),
  }
}

interface CreatorMembershipRow {
  status: string
  campaign: { id: string; name: string; status: string; startDate: Date | string | null; endDate: Date | string | null }
}

/** One campaign of a creator: the campaign, her status in it and her pieces. */
export function serializeCreatorCampaign(row: CreatorMembershipRow, extra: { brand: string | null; pieces: number }) {
  return {
    campaignId: row.campaign.id,
    name: shortText(row.campaign.name) ?? '',
    brand: shortText(extra.brand, 120),
    campaignStatus: row.campaign.status,
    creatorStatus: row.status,
    startDate: isoDay(row.campaign.startDate),
    endDate: isoDay(row.campaign.endDate),
    pieces: extra.pieces,
  }
}

// ============ State of the capture ============

/**
 * One capture job: the last run stamp it left (Setting `cron_<job>_last_run`)
 * and, only for a job that records its failures, the last one
 * (`cron_<job>_last_failed`).
 *
 * The stamp is NOT proof that a run completed: each job writes it at a
 * different moment (capture_status says which, job by job), hence its name.
 * A job that records no failures gets `lastFailedAt: 'not_recorded'`, never
 * null: a null would read as "it never failed".
 */
export function serializeCaptureJob(
  job: string,
  lastRun: string | null | undefined,
  lastFailed: string | null | undefined,
  now: Date,
  recordsFailures: boolean,
) {
  const stampAt = isoInstant(lastRun)
  const hours = stampAt ? Math.round(((now.getTime() - Date.parse(stampAt)) / 3_600_000) * 10) / 10 : null
  return {
    job,
    lastRunStampAt: stampAt,
    hoursSinceLastRunStamp: hours,
    failuresRecorded: recordsFailures,
    lastFailedAt: recordsFailures ? isoInstant(lastFailed) : ('not_recorded' as const),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return record(JSON.parse(raw))
  } catch {
    return null
  }
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
/** A short machine label such as `apify_token` or `too_long`. Anything else is dropped. */
const label = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : null)
const SUMMARY_ROWS = 50

/**
 * The last result of the stories job (Setting `cron_stories_last_result`).
 * The stored JSON may carry the text of an exception (`detail`): it is never
 * copied. Unknown keys are ignored.
 */
export function serializeStoriesResult(raw: string | null | undefined) {
  const r = parseJsonObject(raw)
  if (!r) return null
  const campaigns = Array.isArray(r.campaigns) ? r.campaigns : []
  const skipped = Array.isArray(r.skipped) ? r.skipped : []
  return {
    at: isoInstant(typeof r.at === 'string' ? r.at : null),
    failed: bool(r.failed) ?? false,
    failureReason: label(r.reason),
    failedBatches: finite(r.failedBatches),
    partial: bool(r.partial),
    creatorsChecked: finite(r.usernamesChecked),
    storiesSeen: finite(r.totalStories),
    newStories: finite(r.newStories),
    newByBrandLink: finite(r.newByLink),
    newBySharedPost: finite(r.newByReshare),
    rejectedByRules: finite(r.rejectedByRules),
    campaignsScanned: campaigns.slice(0, SUMMARY_ROWS).flatMap(c => {
      const row = record(c)
      const id = label(row?.id)
      return row && id
        ? [{ campaignId: id, name: shortText(row.name), creators: finite(row.creators), newStories: finite(row.newStories) }]
        : []
    }),
    campaignsNotScanned: skipped.slice(0, SUMMARY_ROWS).flatMap(c => {
      const row = record(c)
      const id = label(row?.id)
      return row && id ? [{ campaignId: id, name: shortText(row.name), reason: label(row.reason) }] : []
    }),
  }
}

/** The last result of the automatic TikTok linking (Setting `cron_tiktok-link_last_result`). */
export function serializeTikTokLinkResult(raw: string | null | undefined) {
  const r = parseJsonObject(raw)
  if (!r) return null
  const campaigns = Array.isArray(r.campaigns) ? r.campaigns : []
  return {
    at: isoInstant(typeof r.at === 'string' ? r.at : null),
    partial: bool(r.partial),
    skippedBecause: label(r.skipped),
    handlesRead: finite(r.handlesScanned),
    handlesAnswered: finite(r.answered),
    handlesNotFound: finite(r.notFound),
    accountsLinked: finite(r.linked),
    videosCaptured: finite(r.videos),
    handlesPossiblyCut: shortTexts(r.truncated, SUMMARY_ROWS, 60),
    campaigns: campaigns.slice(0, SUMMARY_ROWS).flatMap(c => {
      const row = record(c)
      const id = label(row?.id)
      return row && id
        ? [
            {
              campaignId: id,
              name: shortText(row.name),
              candidates: finite(row.candidates),
              linked: shortTexts(row.linked, SUMMARY_ROWS, 60),
              videos: finite(row.videos),
            },
          ]
        : []
    }),
  }
}

interface ApifyState {
  auth: string
  exhausted: boolean
  resumesAt: string | null
  /** The object getApifyBudget returns. Its amounts (usd, limit, softLimit, coreLimit) are never read here. */
  budget: { usedPct: number | null; coreBlocked: boolean; optionalBlocked: boolean; cycleEndsAt: string | null }
}

/** Apify, the service the automatic capture reads the networks with. A percentage of the plan, never an amount. */
export function serializeApify(state: ApifyState) {
  return {
    tokenState: state.auth === 'ok' || state.auth === 'rejected' ? state.auth : 'unknown',
    monthlyLimitReached: state.exhausted,
    resumesAt: isoInstant(state.resumesAt),
    planUsedPercent: finite(state.budget.usedPct),
    captureJobsPausedByPlanLimit: state.budget.coreBlocked,
    discoverSearchPausedByPlanLimit: state.budget.optionalBlocked,
    cycleEndsAt: isoInstant(state.budget.cycleEndsAt),
  }
}

interface AlertRow {
  type: string
  title: string
  message: string
  createdAt: Date | string
}

/** An alert the platform sent to the administrators. Its text was written by the platform. */
export function serializeAlert(row: AlertRow) {
  return {
    type: shortText(row.type, 40),
    title: shortText(row.title, 200),
    message: shortText(row.message, 700),
    at: isoInstant(row.createdAt),
  }
}

/**
 * Titles of the alerts that are about the capture, exactly as the platform
 * writes them: src/lib/notifications.ts (Apify budget pauses, rejected token,
 * failed stories scan), src/app/api/cron/watchdog/route.ts (a job that is not
 * running), src/app/api/cron/stories/route.ts, src/lib/campaign-target-guard.ts
 * and src/instrumentation.ts.
 *
 * SECURITY: the alert types `apify_budget`, `cron_stale` and `cron_failure`
 * are NOT only used for the capture. A data-deletion request from Meta is sent
 * as `cron_stale` (src/app/api/data-deletion/route.ts) and its text carries
 * the person's Meta id and a confirmation code. Deny by default: an alert
 * leaves only when its title is one of these. The others are counted, never
 * shown. tests/unit/mcp-platform-sync.test.ts fails when one of these titles
 * is no longer in the platform's code.
 */
export const CAPTURE_ALERT_TITLES: readonly string[] = [
  // src/lib/notifications.ts
  'Rastreo de stories pausado por presupuesto de Apify',
  'Captura de publicaciones pausada por presupuesto de Apify',
  'Búsqueda externa de creadores pausada por presupuesto de Apify',
  'Actualización de vistas de vídeos pausada por presupuesto de Apify',
  'Apify ha rechazado el token',
  'El rastreo de stories ha fallado',
  // src/app/api/cron/watchdog/route.ts
  'El rastreo de stories no se está ejecutando',
  'La captura automática de publicaciones no se está ejecutando',
  'La comprobación de publicaciones nuevas no se está ejecutando',
  'La vinculación automática de TikTok no se está ejecutando',
  // src/app/api/cron/stories/route.ts
  'Stories sin rastrear',
  // src/lib/campaign-target-guard.ts
  'Cuentas de marca corregidas',
  // src/instrumentation.ts
  'Fallo en tarea automática',
]

/**
 * The alert «Fallo en tarea automática» (src/instrumentation.ts) quotes up to
 * 120 characters of whatever the failed job answered: an HTTP body or the text
 * of an exception, which may hold an address with a credential in it. That
 * excerpt is cut out and the rest of the sentence stays. When it cannot be
 * cut out cleanly the whole message is withheld.
 */
function withoutErrorExcerpt(message: string): string | null {
  if (!/último error/i.test(message)) return message
  const cut = message.replace(/\s*\(último error:[\s\S]*\)(?=\.\s*Los datos )/i, '')
  return /último error/i.test(cut) ? null : cut
}

/**
 * The alerts of capture_status. `rows` are the administrators' notifications
 * of the three alert types, newest first. Returned: the ones about the capture
 * (see CAPTURE_ALERT_TITLES), each once although every administrator received
 * its own copy, and how many other alerts were left out.
 */
export function selectCaptureAlerts(rows: readonly AlertRow[]) {
  const seen = new Set<string>()
  const alerts: ReturnType<typeof serializeAlert>[] = []
  let notShown = 0
  for (const row of rows) {
    const at = isoInstant(row.createdAt)
    const key = `${row.type}\n${row.title}\n${row.message}\n${at ? at.slice(0, 13) : ''}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!CAPTURE_ALERT_TITLES.includes(row.title)) {
      notShown += 1
      continue
    }
    // The excerpt is cut by what the text says, not by the type: one rule, no way round it
    const message = withoutErrorExcerpt(row.message)
    alerts.push(serializeAlert({ type: row.type, title: row.title, message: message ?? '', createdAt: row.createdAt }))
  }
  return { alerts, notShown }
}

// ============ A publication looked up by its URL ============

interface MediaRecordRow {
  id: string
  mediaType: string
  postedAt: Date | string | null
  source: string
  isDeleted: boolean
  campaign?: { id: string; name: string } | null
  influencer?: { username: string } | null
}

/** A Media row found for a pasted URL: where it is filed and for whom. */
export function serializeMediaRecord(row: MediaRecordRow) {
  return {
    pieceId: row.id,
    campaignId: row.campaign?.id ?? null,
    campaign: shortText(row.campaign?.name),
    creator: shortText(row.influencer?.username, 80),
    type: row.mediaType,
    postedAt: isoInstant(row.postedAt),
    capturedBy: shortText(row.source, 30),
    deletedByCreator: row.isDeleted,
  }
}

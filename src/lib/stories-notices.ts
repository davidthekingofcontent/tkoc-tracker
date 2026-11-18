/**
 * «Stories sin rastrear» and the scan block of the Stories tab (16 Nov 2026).
 *
 * Pure helpers (no database, no network) shared by the stories cron
 * (src/app/api/cron/stories/route.ts), the GET of a campaign's stories
 * (src/app/api/campaigns/[id]/stories/route.ts) and their tests.
 *
 * The rule of WHICH campaigns are scanned stays in one place,
 * storiesCampaignSkipReason (src/lib/campaign-capture.ts). This module only
 * decides when the team is TOLD that a live campaign is not scanned, and reads
 * the last run's summary for one campaign.
 *
 * Before this module the notice was sent ONCE per reason (Setting
 * stories_skip_notice_<campaignId> = reason) and never again while the reason
 * lasted: «11. VILEDA - UGC NOVIEMBRE» was told on 27 Oct and stayed out of the
 * scan for weeks in silence. Now the setting holds the reason AND the date of
 * the last notice, and the notice is repeated every 7 days while the reason
 * persists, to the campaign team and to the ADMINs.
 */

import type { StoriesSkipReason } from '@/lib/campaign-capture'
import { STORIES_MAX_CAMPAIGN_DAYS, campaignSpanDays } from '@/lib/campaign-capture'

const DAY_MS = 24 * 60 * 60 * 1000

/** While the reason persists, the notice is repeated this often. */
export const STORIES_NOTICE_REPEAT_MS = 7 * DAY_MS

/**
 * A campaign in dates with brand targets whose creators are ALL still before
 * Acordado is scanned with nobody to read. Its team is told once the campaign
 * has been running this long (a brand-new campaign is given time to confirm).
 */
export const STORIES_NO_CONFIRMED_AFTER_MS = 3 * DAY_MS

/**
 * Why a live campaign gets «Stories sin rastrear»: the cron's skip reasons
 * (never 'window': a campaign outside its dates is not a gap) plus
 * 'no_confirmed' (scanned, but 0 of its Instagram creators are in a scan status).
 */
export type StoriesNoticeReason = Exclude<StoriesSkipReason, 'window'> | 'no_confirmed'

/** What Setting stories_skip_notice_<campaignId> holds. */
export interface StoriesNoticeRecord {
  reason: string
  /** ISO time of the last notice; null for a value written before 16 Nov 2026 (reason only) */
  at: string | null
}

export function storiesNoticeKey(campaignId: string): string {
  return `stories_skip_notice_${campaignId}`
}

/** Reads the setting: the JSON of today, or the bare reason of the old format. null = nothing stored. */
export function parseStoriesNotice(value: string | null | undefined): StoriesNoticeRecord | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { reason?: unknown; at?: unknown }
      const reason = typeof parsed.reason === 'string' ? parsed.reason : ''
      if (!reason) return null
      const at = typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at)) ? new Date(Date.parse(parsed.at)).toISOString() : null
      return { reason, at }
    } catch {
      return null
    }
  }
  // Legacy: the reason alone. Its date is unknown, so the next tick notifies (and stamps).
  return { reason: raw, at: null }
}

export function serializeStoriesNotice(reason: StoriesNoticeReason, now: Date): string {
  return JSON.stringify({ reason, at: now.toISOString() })
}

/**
 * Is a notice owed now? Yes when nothing was stored, when the reason changed,
 * when the stored notice has no date (legacy value), or when the last one is
 * STORIES_NOTICE_REPEAT_MS old or older.
 */
export function storiesNoticeDue(existing: StoriesNoticeRecord | null, reason: StoriesNoticeReason, now: Date): boolean {
  if (!existing) return true
  if (existing.reason !== reason) return true
  if (!existing.at) return true
  const last = Date.parse(existing.at)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= STORIES_NOTICE_REPEAT_MS
}

/**
 * The second reason: a campaign that IS scanned (no skip reason) but has no
 * Instagram creator in a scan status, at least STORIES_NO_CONFIRMED_AFTER_MS
 * after its start, and with at least one Instagram creator to confirm.
 */
export function noConfirmedNoticeDue(
  campaign: { startDate: Date | string },
  counts: { confirmedCreators: number; instagramCreators: number },
  now: Date
): boolean {
  if (counts.confirmedCreators > 0 || counts.instagramCreators <= 0) return false
  const start = new Date(campaign.startDate).getTime()
  if (!Number.isFinite(start)) return false
  return now.getTime() - start >= STORIES_NO_CONFIRMED_AFTER_MS
}

/** What the team is told after «Las stories de "X" no se están rastreando: …» (Spanish, the notifications' language). */
export function storiesNoticeDetail(
  reason: StoriesNoticeReason,
  campaign: { startDate: Date | string; endDate: Date | string | null },
  counts: { instagramCreators: number } = { instagramCreators: 0 }
): string {
  switch (reason) {
    case 'listening':
      return 'es una campaña de Social Listening; las stories solo se rastrean en las campañas de seguimiento de influencers y UGC.'
    case 'no_targets':
      // The three kinds of brand target count (campaignHasTargets): a campaign with product keywords alone IS scanned
      return 'no tiene Cuentas de Marca Objetivo, hashtags ni palabras clave del producto; añade al menos uno en Editar campaña para que sus stories entren.'
    case 'too_long': {
      const span = campaignSpanDays({ startDate: new Date(campaign.startDate), endDate: campaign.endDate ? new Date(campaign.endDate) : null })
      return `dura ${span ?? '?'} días (máximo ${STORIES_MAX_CAMPAIGN_DAYS}) o no tiene fecha de fin; pon una fecha de fin o acorta la campaña, o registra sus stories a mano.`
    }
    case 'no_confirmed':
      return `la captura automática solo lee creadoras en Acordado o posterior y tiene 0 de ${counts.instagramCreators} en esos estados; cambia su estado en Elegir.`
  }
}

/** One campaign's line of the last stories run (Setting cron_stories_last_result). */
export interface StoriesLastResultForCampaign {
  /** When that run happened */
  at: string | null
  /** The run as a whole failed (nothing read, or an exception) */
  failed: boolean
  /** The campaign was in the scanned list (its confirmed creators were read) */
  scanned: boolean
  /** Confirmed Instagram creators read for it (scanned runs only) */
  creators: number | null
  /** Stories stored for it in that run (scanned runs only) */
  newStories: number | null
  /** Why it was left out (skipped runs only) */
  reason: string | null
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The last run's summary for ONE campaign, or null when the setting is
 * missing, unreadable, or does not mention the campaign (for example a run
 * before it existed, or a campaign skipped for 'window').
 */
export function storiesLastResultFor(raw: string | null | undefined, campaignId: string): StoriesLastResultForCampaign | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const r = parsed as Record<string, unknown>
  const at = typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? new Date(Date.parse(r.at)).toISOString() : null
  const failed = r.failed === true
  const rows = (list: unknown): Record<string, unknown>[] =>
    Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []
  const scanned = rows(r.campaigns).find(c => c.id === campaignId)
  if (scanned) {
    return { at, failed, scanned: true, creators: finite(scanned.creators), newStories: finite(scanned.newStories), reason: null }
  }
  const skipped = rows(r.skipped).find(c => c.id === campaignId)
  if (skipped) {
    return { at, failed, scanned: false, creators: null, newStories: null, reason: typeof skipped.reason === 'string' ? skipped.reason : null }
  }
  return null
}

/**
 * Whole days since a story was published (0 on its day). What expires after
 * 24 h is the story on Instagram, not its row in the report: the Stories tab
 * says «Publicada hace N días» instead of «Expirada». null without a date.
 */
export function daysSincePosted(postedAt: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!postedAt) return null
  const t = postedAt instanceof Date ? postedAt.getTime() : new Date(postedAt).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS))
}

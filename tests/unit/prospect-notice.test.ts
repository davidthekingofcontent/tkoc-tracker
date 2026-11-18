/**
 * The pure rules of the review of 16 Nov 2026 (TikTok and tracking):
 *  - src/lib/prospect-notice.ts: when the campaign page and the watchdog say
 *    that the automatic capture is not reading the creators still in Prospecto;
 *  - src/lib/campaign-ended.ts: when the capture crons stop reading a campaign
 *    that has ended (end date + 3 days of grace; no end date = never);
 *  - parseProfileHandle (src/lib/person-profiles.ts): what «Añadir perfil de
 *    TikTok» accepts as a username.
 * Every handle is invented.
 */
import { describe, expect, it } from 'vitest'
import {
  PROSPECT_NOTICE_MIN_DAYS,
  PROSPECT_NOTICE_REPEAT_DAYS,
  PROSPECT_NOTICE_SHARE,
  prospectNoticeFor,
  prospectNoticeMessage,
  prospectNoticeSettingKey,
} from '@/lib/prospect-notice'
import { CAMPAIGN_ENDED_GRACE_DAYS, CAMPAIGN_ENDED_GRACE_MS, campaignEndedForCrons } from '@/lib/campaign-ended'
import { parseProfileHandle } from '@/lib/person-profiles'

const NOW = new Date('2026-11-16T17:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const statuses = (counts: Record<string, number>) => Object.entries(counts).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })))

function campaign(over: Partial<{ type: string; startDate: Date; endDate: Date | null; influencers: Array<{ status: string }> }> = {}) {
  return {
    type: 'INFLUENCER_TRACKING',
    startDate: daysAgo(16),
    endDate: new Date('2026-11-30T00:00:00Z'),
    influencers: statuses({ PROSPECT: 33 }),
    ...over,
  }
}

describe('prospectNoticeFor', () => {
  it('«11.- Micros Noviembre» on day 16: 33 of 33 in PROSPECT, none readable', () => {
    expect(prospectNoticeFor(campaign(), NOW)).toEqual({ members: 33, prospects: 33, scanning: 0, startedDays: 16 })
  })

  it(`waits ${PROSPECT_NOTICE_MIN_DAYS} days from the start: the first days are for the PM to confirm the creators`, () => {
    expect(PROSPECT_NOTICE_MIN_DAYS).toBe(3)
    expect(prospectNoticeFor(campaign({ startDate: daysAgo(2) }), NOW)).toBeNull()
    expect(prospectNoticeFor(campaign({ startDate: daysAgo(2.9) }), NOW)).toBeNull()
    expect(prospectNoticeFor(campaign({ startDate: daysAgo(3) }), NOW)).toMatchObject({ startedDays: 3 })
  })

  it('applies from half the members in PROSPECT (Macros Noviembre: 12 of 20), not below', () => {
    expect(PROSPECT_NOTICE_SHARE).toBe(0.5)
    expect(prospectNoticeFor(campaign({ influencers: statuses({ CONTRACTED: 8, PROSPECT: 12 }) }), NOW)).toEqual({ members: 20, prospects: 12, scanning: 8, startedDays: 16 })
    expect(prospectNoticeFor(campaign({ influencers: statuses({ CONTRACTED: 10, PROSPECT: 10 }) }), NOW)).toMatchObject({ prospects: 10, members: 20 })
    expect(prospectNoticeFor(campaign({ influencers: statuses({ CONTRACTED: 12, PROSPECT: 8 }) }), NOW)).toBeNull()
  })

  it('also applies when nobody is in Acordado or later, whatever the share of PROSPECT (all in Contacto / Negociando)', () => {
    const notice = prospectNoticeFor(campaign({ influencers: statuses({ OUTREACH: 5, NEGOTIATING: 4, PROSPECT: 1 }) }), NOW)
    expect(notice).toEqual({ members: 10, prospects: 1, scanning: 0, startedDays: 16 })
    expect(prospectNoticeMessage(notice!)).toBe('La captura automática (publicaciones, stories, TikTok) solo lee creadoras en Acordado o posterior: 1 de 10 están en Prospecto y ninguna está en Acordado o posterior.')
  })

  it('does not apply to Dorco (22 CONTRACTED + 6 POSTED), to a Social Listening campaign, to a campaign without members or to one that has ended', () => {
    expect(prospectNoticeFor(campaign({ influencers: statuses({ CONTRACTED: 22, POSTED: 6 }) }), NOW)).toBeNull()
    expect(prospectNoticeFor(campaign({ type: 'SOCIAL_LISTENING' }), NOW)).toBeNull()
    expect(prospectNoticeFor(campaign({ influencers: [] }), NOW)).toBeNull()
    // Ended yesterday (the whole end day counts as inside)
    expect(prospectNoticeFor(campaign({ startDate: daysAgo(40), endDate: daysAgo(2) }), NOW)).toBeNull()
    expect(prospectNoticeFor(campaign({ startDate: daysAgo(40), endDate: new Date('2026-11-16T00:00:00Z') }), NOW)).not.toBeNull()
    // No end date: still inside
    expect(prospectNoticeFor(campaign({ endDate: null }), NOW)).not.toBeNull()
  })

  it('the sentence of the page and of the notification, and the setting that spaces the notification a week apart', () => {
    expect(prospectNoticeMessage({ members: 33, prospects: 33, scanning: 0, startedDays: 16 })).toBe('La captura automática (publicaciones, stories, TikTok) solo lee creadoras en Acordado o posterior: 33 de 33 están en Prospecto.')
    expect(prospectNoticeMessage({ members: 20, prospects: 12, scanning: 8, startedDays: 16 })).toBe('La captura automática (publicaciones, stories, TikTok) solo lee creadoras en Acordado o posterior: 12 de 20 están en Prospecto.')
    expect(PROSPECT_NOTICE_REPEAT_DAYS).toBe(7)
    expect(prospectNoticeSettingKey('cmwj94ldo06ut01nx20wgm9j5')).toBe('prospect_notice_cmwj94ldo06ut01nx20wgm9j5')
  })
})

describe('campaignEndedForCrons', () => {
  const october = { endDate: new Date('2026-10-31T00:00:00Z') }

  it(`stops ${CAMPAIGN_ENDED_GRACE_DAYS} days after the end of the window (the whole end day included), the grace the daily TikTok pass already had`, () => {
    expect(CAMPAIGN_ENDED_GRACE_DAYS).toBe(3)
    expect(CAMPAIGN_ENDED_GRACE_MS).toBe(3 * 86_400_000)
    expect(campaignEndedForCrons(october, new Date('2026-10-31T23:59:00Z'))).toBe(false)
    expect(campaignEndedForCrons(october, new Date('2026-11-01T00:00:00Z'))).toBe(false)
    expect(campaignEndedForCrons(october, new Date('2026-11-03T23:59:59Z'))).toBe(false)
    expect(campaignEndedForCrons(october, new Date('2026-11-04T00:00:00Z'))).toBe(true)
    expect(campaignEndedForCrons(october, new Date('2026-11-16T17:00:00Z'))).toBe(true)
  })

  it('a campaign without an end date (Social Listening) never ends for the crons; an end date as a string works too', () => {
    expect(campaignEndedForCrons({ endDate: null }, NOW)).toBe(false)
    expect(campaignEndedForCrons({ endDate: undefined }, NOW)).toBe(false)
    expect(campaignEndedForCrons({ endDate: '2026-10-31T00:00:00.000Z' }, NOW)).toBe(true)
    expect(campaignEndedForCrons({ endDate: '2026-12-31T00:00:00.000Z' }, NOW)).toBe(false)
  })
})

describe('parseProfileHandle («Añadir perfil de TikTok»)', () => {
  it('accepts a handle with or without @ and the profile URL of each network', () => {
    expect(parseProfileHandle('TIKTOK', '@Ale.Ficticia')).toBe('Ale.Ficticia')
    expect(parseProfileHandle('TIKTOK', '  ale_ficticia  ')).toBe('ale_ficticia')
    expect(parseProfileHandle('TIKTOK', 'https://www.tiktok.com/@ale.ficticia?lang=es')).toBe('ale.ficticia')
    expect(parseProfileHandle('TIKTOK', 'tiktok.com/@ale.ficticia/')).toBe('ale.ficticia')
    expect(parseProfileHandle('INSTAGRAM', 'https://www.instagram.com/ale_ficticia/')).toBe('ale_ficticia')
    expect(parseProfileHandle('YOUTUBE', 'https://www.youtube.com/@canal-demo')).toBe('canal-demo')
  })

  it('refuses what is not a handle: empty, spaces, a post URL, the URL of another network, a non-string', () => {
    expect(parseProfileHandle('TIKTOK', '')).toBeNull()
    expect(parseProfileHandle('TIKTOK', '   ')).toBeNull()
    expect(parseProfileHandle('TIKTOK', 'ale ficticia')).toBeNull()
    expect(parseProfileHandle('TIKTOK', 'https://www.tiktok.com/foryou')).toBeNull()
    // The URL of a video names its author: the handle is taken from it
    expect(parseProfileHandle('TIKTOK', 'https://www.tiktok.com/@ale.ficticia/video/7690000000000000001')).toBe('ale.ficticia')
    expect(parseProfileHandle('TIKTOK', 'https://www.instagram.com/ale_ficticia/')).toBeNull()
    expect(parseProfileHandle('INSTAGRAM', 'https://www.instagram.com/p/DfXyzAbc/')).toBeNull()
    expect(parseProfileHandle('TIKTOK', 42)).toBeNull()
    expect(parseProfileHandle('TIKTOK', null)).toBeNull()
    expect(parseProfileHandle('TIKTOK', 'a'.repeat(65))).toBeNull()
  })
})

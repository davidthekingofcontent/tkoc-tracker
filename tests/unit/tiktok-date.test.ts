import { describe, expect, it } from 'vitest'
import { tiktokIdPostedAt } from '@/lib/tiktok-id'
import { parsePostUrl } from '@/lib/post-url'

/** An id built the way TikTok builds them: Unix seconds in the top 32 bits, anything below. */
function idAt(iso: string, low = 1): string {
  return ((BigInt(Math.floor(Date.parse(iso) / 1000)) << BigInt(32)) | BigInt(low)).toString()
}

const NOW = Date.parse('2026-11-12T12:00:00.000Z')

describe('tiktokIdPostedAt: the publication date carried by a TikTok id', () => {
  it('decodes the second the video was published, whatever the low bits are', () => {
    expect(tiktokIdPostedAt('7695718965122419989', NOW)?.toISOString()).toBe('2026-10-12T10:00:00.000Z')
    for (const low of [0, 1, 123456789, 2 ** 32 - 1]) {
      expect(tiktokIdPostedAt(idAt('2026-10-12T10:00:00.000Z', low), NOW)?.toISOString()).toBe('2026-10-12T10:00:00.000Z')
    }
    expect(tiktokIdPostedAt(idAt('2026-10-31T23:59:59.000Z'), NOW)?.toISOString()).toBe('2026-10-31T23:59:59.000Z')
    expect(tiktokIdPostedAt(idAt('2026-11-01T00:00:00.000Z'), NOW)?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
  })

  it('reads old ids too (a 2017 video)', () => {
    expect(tiktokIdPostedAt('6500000000000000000', NOW)?.toISOString()).toBe('2017-12-16T04:39:43.000Z')
    expect(tiktokIdPostedAt(idAt('2014-01-01T00:00:00.000Z', 0), NOW)?.toISOString()).toBe('2014-01-01T00:00:00.000Z')
  })

  it('answers null for anything that is not an id it can trust', () => {
    // Not a number, too short, too long
    for (const bad of ['', 'abc', '12345', '7695718965122419989x', ' 7695718965122419989', '-7695718965122419989', '123456789012345678901']) {
      expect(tiktokIdPostedAt(bad, NOW), bad).toBeNull()
    }
    // Decodes to a date before 2014
    expect(tiktokIdPostedAt(idAt('2013-12-31T23:59:59.000Z', 0), NOW)).toBeNull()
    expect(tiktokIdPostedAt('100000000000000', NOW)).toBeNull()
    // Decodes to a date in the future (more than a day ahead of now)
    expect(tiktokIdPostedAt(idAt('2026-11-14T00:00:00.000Z'), NOW)).toBeNull()
    expect(tiktokIdPostedAt('18446744073709551615', NOW)).toBeNull()
    expect(tiktokIdPostedAt('99999999999999999999', NOW)).toBeNull()
    // Not a string at all
    expect(tiktokIdPostedAt(undefined as unknown as string, NOW)).toBeNull()
    expect(tiktokIdPostedAt(7695718965122419989 as unknown as string, NOW)).toBeNull()
  })

  it('allows a video published a few hours "ahead" (clock differences), up to one day', () => {
    expect(tiktokIdPostedAt(idAt('2026-11-12T20:00:00.000Z'), NOW)?.toISOString()).toBe('2026-11-12T20:00:00.000Z')
    expect(tiktokIdPostedAt(idAt('2026-11-13T12:00:01.000Z'), NOW)).toBeNull()
  })

  it('uses the current time when none is given', () => {
    const recent = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000)
    expect(tiktokIdPostedAt(idAt(recent.toISOString()))?.getTime()).toBe(recent.getTime())
  })

  it('works on the id of a pasted link, video or photo', () => {
    const id = idAt('2026-10-07T08:05:00.000Z', 77)
    for (const url of [
      `https://www.tiktok.com/@cuenta_inventada/video/${id}?is_from_webapp=1`,
      `https://www.tiktok.com/@cuenta_inventada/photo/${id}`,
      `tiktok.com/video/${id}`,
    ]) {
      const parsed = parsePostUrl(url)
      expect(parsed?.platform).toBe('TIKTOK')
      expect(tiktokIdPostedAt(parsed!.externalId, NOW)?.toISOString()).toBe('2026-10-07T08:05:00.000Z')
    }
  })
})

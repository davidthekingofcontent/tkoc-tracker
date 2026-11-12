// TikTok ids. Pure helpers: no database, no network.
//
// The id of a TikTok publication (a video or a photo post, the number at the
// end of tiktok.com/@user/video/{id}) carries the moment it was created: its
// top 32 bits are Unix seconds. That gives the publication date of a link a PM
// pastes when the scraper is not available, the same way an Instagram story
// id gives the story's (src/lib/story-url.ts), so no date has to be typed.
//
// Usage:
//
//   tiktokIdPostedAt('7695718965122419989')   // → 2026-10-12T10:00:00.000Z (a Date)
//   tiktokIdPostedAt('12345')                 // → null (not a TikTok id)
//   tiktokIdPostedAt('99999999999999999999')  // → null (decodes to a date we cannot trust)

/** Earliest date accepted as a real publication (the ids of 2014 musical.ly videos already follow this scheme) */
const MIN_POSTED_AT_MS = Date.UTC(2014, 0, 1)
const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Publication time encoded in a TikTok id (id >> 32 = Unix seconds).
 * Returns null unless the id is 15 to 20 digits AND the decoded date is
 * between 2014-01-01 and now + 1 day: anything else is not an id we can trust.
 */
export function tiktokIdPostedAt(id: string, now: number = Date.now()): Date | null {
  if (typeof id !== 'string' || !/^\d{15,20}$/.test(id)) return null
  let seconds: number
  try {
    // BigInt(32) rather than the 32n literal: tsconfig targets below ES2020
    seconds = Number(BigInt(id) >> BigInt(32))
  } catch {
    return null
  }
  if (!Number.isFinite(seconds)) return null
  const ms = seconds * 1000
  if (ms < MIN_POSTED_AT_MS || ms > now + ONE_DAY_MS) return null
  return new Date(ms)
}

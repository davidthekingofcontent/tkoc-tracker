// Instagram story URLs — pure helpers, no DB, no network.
//
// A story link looks like https://www.instagram.com/stories/{username}/{id}/
// and the {id} is an Instagram media snowflake: its top bits are the creation
// time in milliseconds since the Instagram epoch (2011-08-24 21:07:01.721 UTC).
// Stories expire after 24 h and the single-post scraper does not understand
// story URLs, so the snowflake is the ONLY automatic source we have for the
// publication date of a story a PM pastes by hand. Views and reach can never
// be read from the link: only the creator has them (insights screenshot).
//
// Usage:
//
//   parseInstagramStoryUrl('https://www.instagram.com/stories/marta.fit/3986689802749386127/')
//   // → { username: 'marta.fit', storyId: '3986689802749386127',
//   //     canonicalUrl: 'https://www.instagram.com/stories/marta.fit/3986689802749386127/',
//   //     postedAtHint: 2026-09-15T11:08:00.766Z }
//
//   parseInstagramStoryUrl('instagram.com/stories/marta.fit/3986689802749386127?igsh=abc')
//   // → same result: protocol optional, query string and trailing slash ignored
//
//   parseInstagramStoryUrl('https://www.instagram.com/stories/highlights/17912345678901234/')
//   // → { username: '', storyId: '17912345678901234',
//   //     canonicalUrl: 'https://www.instagram.com/stories/highlights/17912345678901234/',
//   //     postedAtHint: null, isHighlight: true }   ← callers must reject: a highlight has no date
//
//   parseInstagramStoryUrl('https://www.instagram.com/p/DBxyz123/')   // → null (a post, not a story)
//   instagramStoryPostedAt('12345')                                    // → null (not a snowflake)

export interface ParsedStoryUrl {
  /** Username embedded in the URL ('' for a highlight, whose URL carries none) */
  username: string
  /** Story media id (snowflake) — or the highlight reel id when `isHighlight` */
  storyId: string
  /** https://www.instagram.com/stories/{username}/{id}/ (no query string / hash) */
  canonicalUrl: string
  /** Publication time decoded from the snowflake; null when it cannot be trusted */
  postedAtHint: Date | null
  /** /stories/highlights/{id}/ — a saved highlight, not a dated story */
  isHighlight?: boolean
}

/** Instagram snowflake epoch, in ms (2011-08-24T21:07:01.721Z) */
const INSTAGRAM_EPOCH_MS = 1314220021721
/** Earliest date we accept as a real story timestamp (stories launched Aug 2016) */
const MIN_POSTED_AT_MS = Date.UTC(2015, 0, 1)
const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Publication time encoded in an Instagram media id (snowflake >> 23 + epoch).
 * Returns null unless the id is 15–25 digits AND the decoded date is between
 * 2015-01-01 and now + 1 day: anything else is not a story id we can trust.
 */
export function instagramStoryPostedAt(storyId: string): Date | null {
  if (!/^\d{15,25}$/.test(storyId)) return null
  let ms: number
  try {
    // BigInt(23) rather than the 23n literal: tsconfig targets below ES2020
    ms = Number(BigInt(storyId) >> BigInt(23)) + INSTAGRAM_EPOCH_MS
  } catch {
    return null
  }
  if (!Number.isFinite(ms)) return null
  if (ms < MIN_POSTED_AT_MS || ms > Date.now() + ONE_DAY_MS) return null
  return new Date(ms)
}

/**
 * Parses an Instagram story link. Accepts instagram.com, www.instagram.com and
 * m.instagram.com (any *.instagram.com host), with or without protocol.
 * Returns null for anything that is not /stories/{username}/{id}/.
 */
export function parseInstagramStoryUrl(input: string): ParsedStoryUrl | null {
  if (typeof input !== 'string') return null
  let url: URL
  try {
    const trimmed = input.trim()
    if (!trimmed) return null
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null

  const path = url.pathname

  // Highlights first: 'highlights' would otherwise pass as a username
  const highlight = path.match(/^\/stories\/highlights\/(\d+)(?:\/|$)/)
  if (highlight) {
    const highlightId = highlight[1]
    return {
      username: '',
      storyId: highlightId,
      canonicalUrl: `https://www.instagram.com/stories/highlights/${highlightId}/`,
      postedAtHint: null,
      isHighlight: true,
    }
  }

  const m = path.match(/^\/stories\/([A-Za-z0-9_.]{1,30})\/(\d{15,25})(?:\/|$)/)
  if (!m) return null
  const [, username, storyId] = m

  return {
    username,
    storyId,
    canonicalUrl: `https://www.instagram.com/stories/${username}/${storyId}/`,
    postedAtHint: instagramStoryPostedAt(storyId),
  }
}

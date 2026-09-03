/**
 * Creator handle parsing — shared contract.
 *
 * Accepts the many ways a PM pastes a creator into the product:
 *   @user · user · instagram.com/user · https://www.tiktok.com/@user?lang=es
 *   youtube.com/@user · youtube.com/c/user · youtube.com/channel/UC… · youtu.be/…
 * and returns a clean username (no "@") plus the platform inferred from the
 * host, or `null` when the input carried no host to infer it from.
 */

export type ParsedPlatform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

export interface ParsedCreatorHandle {
  username: string
  platform: ParsedPlatform | null
}

// Path segments that are site sections, never usernames.
const RESERVED_SEGMENTS = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'video', 'tag', 'discover',
  'watch', 'shorts', 'playlist', 'results', 'feed', 'embed', 'live', 'hashtag',
])

function platformFromHost(host: string): ParsedPlatform | null {
  const h = host.toLowerCase()
  if (h === 'instagram.com' || h.endsWith('.instagram.com') || h === 'instagr.am') return 'INSTAGRAM'
  if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) return 'TIKTOK'
  if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'YOUTUBE'
  return null
}

function cleanUsername(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '') // anything after a path/query/hash separator
    .replace(/\s+/g, '')
    .replace(/\/+$/, '')
}

export function parseCreatorHandle(input: string): ParsedCreatorHandle {
  const raw = (input || '').trim()
  if (!raw) return { username: '', platform: null }

  // Does it look like a URL (or a bare domain path like "instagram.com/user")?
  const looksLikeUrl = /^(https?:\/\/|www\.)/i.test(raw) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(raw)

  if (looksLikeUrl) {
    let url: URL | null = null
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
      url = null
    }

    if (url) {
      const host = url.hostname.replace(/^www\./i, '').replace(/^m\./i, '')
      const platform = platformFromHost(host)
      const segments = url.pathname.split('/').map(s => s.trim()).filter(Boolean)

      if (platform === 'YOUTUBE') {
        // youtube.com/@handle · /c/name · /user/name · /channel/UC…
        const first = segments[0] || ''
        if (first.startsWith('@')) return { username: cleanUsername(first), platform }
        if ((first === 'c' || first === 'user' || first === 'channel') && segments[1]) {
          return { username: cleanUsername(segments[1]), platform }
        }
        if (first && !RESERVED_SEGMENTS.has(first.toLowerCase())) {
          return { username: cleanUsername(first), platform }
        }
        return { username: '', platform }
      }

      // Instagram / TikTok / unknown host: the profile is the FIRST segment.
      // A post/reel URL (instagram.com/p/<shortcode>) carries no username —
      // only "stories/<user>/…" names the creator in a later segment.
      const first = segments[0] || ''
      const firstKey = first.replace(/^@/, '').toLowerCase()
      if (!first) return { username: '', platform }
      if (RESERVED_SEGMENTS.has(firstKey)) {
        if (firstKey === 'stories' && segments[1] && !RESERVED_SEGMENTS.has(segments[1].toLowerCase())) {
          return { username: cleanUsername(segments[1]), platform }
        }
        return { username: '', platform }
      }
      return { username: cleanUsername(first), platform }
    }
  }

  // Plain "@user" or "user"
  return { username: cleanUsername(raw), platform: null }
}

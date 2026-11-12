/**
 * Short share links (vm.tiktok.com/XXXX, vt.tiktok.com/XXXX, tiktok.com/t/XXXX,
 * instagram.com/share/…) carry no post id: the real link is only known after
 * following their redirect. Resolving them BEFORE parsing lets a PM paste what
 * the phone copies, and makes the duplicate check work on the real link.
 *
 * The redirect is followed by hand: https only, a few hops, a short timeout,
 * and every hop must stay on the platform's own hosts (this code makes an
 * outbound request with a URL typed by a user).
 */
import { parsePostUrl } from '@/lib/post-url'

const MAX_HOPS = 5
const HOP_TIMEOUT_MS = 6_000

const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com'])

function parse(input: string): URL | null {
  try {
    const trimmed = input.trim()
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '')
}

function isPlatformHost(host: string): boolean {
  return (
    host === 'tiktok.com' || host.endsWith('.tiktok.com') ||
    host === 'instagram.com' || host.endsWith('.instagram.com')
  )
}

/** Is this a share link that has to be opened to learn the real post URL? */
export function isShortPostUrl(input: string): boolean {
  const url = parse(input)
  if (!url) return false
  const host = hostOf(url)
  if (SHORT_HOSTS.has(host)) return true
  // tiktok.com/t/XXXX
  if ((host === 'tiktok.com' || host === 'm.tiktok.com') && /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname)) return true
  // instagram.com/share/XXXX, /share/reel/XXXX, /share/p/XXXX
  if (host === 'instagram.com' && /^\/share\/(?:(?:reel|p)\/)?[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return true
  return false
}

export type ShortUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_short' | 'blocked_host' | 'too_many_hops' | 'no_post' | 'unreachable' }

/**
 * Follow a short link to the publication it points at. Returns the first URL
 * in the redirect chain that is a recognisable post link (cleaned of tracking
 * parameters by parsePostUrl's canonical form at the caller).
 */
export async function resolveShortUrl(
  input: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShortUrlResult> {
  if (!isShortPostUrl(input)) return { ok: false, reason: 'not_short' }
  let current = parse(input) as URL
  if (current.protocol !== 'https:') current = new URL(current.toString().replace(/^http:/i, 'https:'))

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let res: Response
    try {
      res = await fetchImpl(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        headers: {
          // A phone browser: the platforms answer bots with an interstitial instead of the redirect
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
          Accept: 'text/html,application/xhtml+xml',
        },
      })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) {
      // No more redirects and we never saw a post link
      return { ok: false, reason: res.status >= 400 ? 'unreachable' : 'no_post' }
    }
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (next.protocol !== 'https:' || !isPlatformHost(hostOf(next))) {
      return { ok: false, reason: 'blocked_host' }
    }
    if (parsePostUrl(next.toString())) return { ok: true, url: next.toString() }
    current = next
  }
  return { ok: false, reason: 'too_many_hops' }
}

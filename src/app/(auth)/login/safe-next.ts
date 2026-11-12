/**
 * Where to go after a successful login when the login page was opened with
 * `?next=...`.
 *
 * SECURITY: `next` comes from the address bar, so anybody can write anything
 * in it. Exactly TWO destinations are honoured, both on this same site:
 *  - the consent screen of the MCP connector for Claude, `/oauth/authorize`,
 *    with its query;
 *  - the confirmation page of an action Claude asked for,
 *    `/mcp/confirmar/<id>`, where <id> is 1 to 64 letters, digits, `_` or `-`,
 *    with nothing after it (no query, no further segment).
 * Everything else returns null and the login goes where it always went:
 * other pages, absolute URLs, `//host`, backslashes, control characters,
 * look-alikes such as `/oauth/authorize.evil` or `/oauth/authorize/../x`.
 *
 * Pure function (no window, no router): the page passes the raw value in.
 */
const CONSENT_PATH = '/oauth/authorize'
const ACTION_PATH_RE = /^\/mcp\/confirmar\/[A-Za-z0-9_-]{1,64}$/
// The longest request the consent screen accepts is well under this
const MAX_NEXT_CHARS = 8192
// Any origin will do: it only lets the parser show us what it understood
const PARSE_BASE = 'http://localhost'

export function safeNextPath(next: string | null | undefined): string | null {
  if (typeof next !== 'string' || next.length === 0 || next.length > MAX_NEXT_CHARS) return null
  // The confirmation page of an action: the whole value must be exactly that shape
  if (ACTION_PATH_RE.test(next)) return next
  // Literal prefix first: the path itself, alone or followed by its query
  if (next !== CONSENT_PATH && !next.startsWith(CONSENT_PATH + '?')) return null
  // Browsers drop or rewrite these before navigating: never let them through
  if (/[\x00-\x20\x7f\\]/.test(next)) return null
  // Second opinion from the URL parser: still this site, still that path
  try {
    const url = new URL(next, PARSE_BASE)
    if (url.origin !== PARSE_BASE || url.pathname !== CONSENT_PATH) return null
    // Rebuilt from the parsed parts: a fragment, if any, is left behind
    return url.pathname + url.search
  } catch {
    return null
  }
}

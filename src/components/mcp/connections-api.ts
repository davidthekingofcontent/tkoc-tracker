/**
 * What the card «Conexiones con Claude» expects from the grants API, in one
 * place. Plain module (no React, no 'use client'): it is the contract between
 * the card and the two routes, and it can be tested without a browser.
 *
 *   GET    /api/oauth/grants        200 `{ grants: GrantSummary[] }` (or the bare array),
 *                                   each row as listGrants() of src/lib/mcp/oauth.ts
 *                                   returns it, dates as ISO text. Anything else: failure.
 *   DELETE /api/oauth/grants/<id>   2xx: revoked. 404: there was no live connection
 *                                   with that id. Anything else: failure.
 *
 * Both routes check the ADMIN session themselves. Nothing here ever carries a
 * token: only names and dates.
 */
export const GRANTS_ENDPOINT = '/api/oauth/grants'

/** One active connection, as the card shows it. */
export interface Connection {
  id: string
  /** Name the client gave when it registered. Untrusted text: render it as text only. null when unknown. */
  clientName: string | null
  /** The administrator who authorised it. null when the account no longer exists. */
  userName: string | null
  /** ISO date, or null when the route sent none. */
  createdAt: string | null
  /** ISO date of the last call, or null when it has not been used yet. */
  lastUsedAt: string | null
}

export type RevokeOutcome = 'revoked' | 'alreadyGone' | 'revokeError'

type Fetch = typeof fetch

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/** Accepts `{ grants: [...] }` or a bare array, keeps only well-formed rows and drops every other field. */
export function toConnections(data: unknown): Connection[] {
  const list: unknown = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? (data as { grants?: unknown }).grants
      : null
  if (!Array.isArray(list)) return []
  const rows: Connection[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = text(row.id)
    if (!id) continue
    rows.push({
      id,
      clientName: text(row.clientName),
      userName: text(row.userName),
      createdAt: text(row.createdAt),
      lastUsedAt: text(row.lastUsedAt),
    })
  }
  return rows
}

/** The active connections, or null when they could not be loaded (network, no session, not an administrator). */
export async function loadConnections(fetchImpl: Fetch = fetch): Promise<Connection[] | null> {
  try {
    const res = await fetchImpl(GRANTS_ENDPOINT, { cache: 'no-store' })
    if (!res.ok) return null
    const data: unknown = await res.json()
    // A 200 that is neither shape is a failure, not "no connections"
    const isList = Array.isArray(data) || (!!data && typeof data === 'object' && Array.isArray((data as { grants?: unknown }).grants))
    return isList ? toConnections(data) : null
  } catch {
    return null
  }
}

/** Revokes one connection. Never throws: the outcome says what to tell the administrator. */
export async function revokeConnection(id: string, fetchImpl: Fetch = fetch): Promise<RevokeOutcome> {
  try {
    const res = await fetchImpl(`${GRANTS_ENDPOINT}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.ok) return 'revoked'
    return res.status === 404 ? 'alreadyGone' : 'revokeError'
  } catch {
    return 'revokeError'
  }
}

/**
 * The address the SERVER answers for, read from its own RFC 9728 document
 * (`resource` of /.well-known/oauth-protected-resource), or null. Claude only
 * accepts the address that matches that document exactly, so the card prefers
 * it to the value bundled in the browser.
 */
export async function loadServerUrl(fetchImpl: Fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/.well-known/oauth-protected-resource', { cache: 'no-store' })
    if (!res.ok) return null
    const doc: unknown = await res.json()
    const resource = doc && typeof doc === 'object' ? (doc as { resource?: unknown }).resource : null
    return typeof resource === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(resource) ? resource : null
  } catch {
    return null
  }
}

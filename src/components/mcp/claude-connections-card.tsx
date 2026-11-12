'use client'

/**
 * Ajustes → Integraciones → «Conexiones con Claude» (ADMIN only).
 *
 * Self-contained: it loads its own data and needs no props.
 *   - the address of the MCP server, with a copy button;
 *   - three short steps to connect from Claude (and the Claude Code command);
 *   - the active connections of ALL administrators (GET /api/oauth/grants);
 *   - «Revocar», confirmed inside the page (DELETE /api/oauth/grants/<id>).
 *
 * The routes enforce the ADMIN session themselves: this card only shows what
 * they answer (see ./connections-api.ts for the contract). It never sees a
 * token, only names and dates.
 *
 * SECURITY: the client name is text typed by whoever registered the client.
 * It is only ever rendered as a React text node (escaped).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MCP_RESOURCE } from '@/lib/mcp/config'
import { formatDate, type EurLocale } from '@/lib/utils'
import { loadConnections, loadServerUrl, revokeConnection, type Connection, type RevokeOutcome } from './connections-api'

type LoadState = 'loading' | 'ready' | 'error'

/** House date (formatDate, Europe/Madrid) plus the time of day. */
function formatDateTime(value: string, locale: EurLocale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return formatDate(value, { locale })
  const time = new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
  return `${formatDate(date, { locale })}, ${time}`
}

export function ClaudeConnectionsCard() {
  const { t, locale } = useI18n()
  const c = t.mcp.connections

  // The bundled address is shown at once and replaced by the server's own if
  // the two ever differ (see loadServerUrl)
  const [serverUrl, setServerUrl] = useState(MCP_RESOURCE)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const urlInput = useRef<HTMLInputElement>(null)
  const copyTimer = useRef<number | null>(null)

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [connections, setConnections] = useState<Connection[]>([])
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<RevokeOutcome | null>(null)

  /** Shows what the server answered: the rows, or the error state when it gave none. */
  const show = useCallback((rows: Connection[] | null) => {
    if (rows) setConnections(rows)
    setLoadState(rows ? 'ready' : 'error')
  }, [])

  useEffect(() => {
    let alive = true
    void loadConnections().then(rows => {
      if (alive) show(rows)
    })
    void loadServerUrl().then(url => {
      if (alive && url) setServerUrl(url)
    })
    return () => {
      alive = false
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [show])

  function retry() {
    setLoadState('loading')
    void loadConnections().then(show)
  }

  async function copyUrl() {
    let copied = false
    try {
      await navigator.clipboard.writeText(serverUrl)
      copied = true
    } catch {
      // No clipboard access (old browser, permission denied): leave the
      // address selected so it can be copied by hand
      urlInput.current?.focus()
      urlInput.current?.select()
    }
    setCopyState(copied ? 'copied' : 'failed')
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), copied ? 2500 : 8000)
  }

  async function revoke(id: string) {
    setRevokingId(id)
    setNotice(null)
    const outcome = await revokeConnection(id)
    if (outcome === 'revoked') {
      setConnections(prev => prev.filter(conn => conn.id !== id))
    } else {
      // Not revoked by this click: show what the server has now (somebody else
      // may have revoked it, or it may have expired, while this list was open)
      show(await loadConnections())
    }
    setNotice(outcome)
    setRevokingId(null)
    setConfirmingId(null)
  }

  const noticeText = notice === 'revoked' ? c.revoked : notice === 'alreadyGone' ? c.alreadyGone : notice === 'revokeError' ? c.revokeError : ''

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{c.title}</h3>
        <Badge variant="default">{c.readOnly}</Badge>
      </div>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{c.intro}</p>

      <Card variant="elevated">
        <CardContent>
          {/* ---- Server address ---- */}
          <label htmlFor="mcp-server-url" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {c.serverUrl}
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={urlInput}
              id="mcp-server-url"
              type="text"
              readOnly
              value={serverUrl}
              onFocus={e => e.currentTarget.select()}
              className="block w-full min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-900 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <Button size="md" variant="secondary" onClick={copyUrl}>
              {copyState === 'copied' ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              {copyState === 'copied' ? c.copied : c.copy}
            </Button>
          </div>
          <p role="status" aria-live="polite" className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
            {copyState === 'failed' ? c.copyFailed : ''}
          </p>

          {/* ---- How to connect ---- */}
          <h4 className="mt-4 text-sm font-semibold text-gray-900 dark:text-white">{c.stepsTitle}</h4>
          <ol className="mt-3 space-y-2.5">
            {[c.step1, c.step2, c.step3].map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-100 text-xs font-bold text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                  {i + 1}
                </span>
                <span className="text-sm text-gray-700 dark:text-gray-300">{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">{c.claudeCode}</p>
          <code className="mt-1.5 block overflow-x-auto whitespace-nowrap rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            claude mcp add --transport http tkoc {serverUrl}
          </code>

          {/* ---- Active connections ---- */}
          <h4 className="mt-6 border-t border-gray-100 pt-5 text-sm font-semibold text-gray-900 dark:border-gray-700 dark:text-white">
            {c.listTitle}
          </h4>

          <p
            role="status"
            aria-live="polite"
            className={
              !notice
                ? 'sr-only'
                : notice === 'revoked'
                  ? 'mt-3 rounded-lg bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : 'mt-3 rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400'
            }
          >
            {noticeText}
          </p>

          {loadState === 'loading' ? (
            <div className="flex items-center justify-center py-8" role="status" aria-label={c.loading}>
              <Loader2 className="h-5 w-5 animate-spin text-purple-600" />
            </div>
          ) : loadState === 'error' ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm text-red-600 dark:text-red-400">{c.loadError}</p>
              <Button size="sm" variant="secondary" onClick={retry}>
                {c.retry}
              </Button>
            </div>
          ) : connections.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{c.empty}</p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
              {connections.map(conn => (
                <li key={conn.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-semibold text-gray-900 dark:text-white">
                        <bdi>{conn.clientName ?? c.unknownClient}</bdi>
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                        <span>
                          {c.authorisedBy}: <span className="text-gray-700 dark:text-gray-300">{conn.userName ?? c.unknownUser}</span>
                        </span>
                        <span>
                          {c.created}: {formatDate(conn.createdAt, { locale })}
                        </span>
                        <span>
                          {c.lastUsed}: {conn.lastUsedAt ? formatDateTime(conn.lastUsedAt, locale) : c.neverUsed}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setNotice(null)
                          setConfirmingId(conn.id)
                        }}
                        disabled={confirmingId === conn.id || revokingId !== null}
                      >
                        {c.revoke}
                      </Button>
                    </div>
                  </div>
                  {confirmingId === conn.id && (
                    <div
                      role="group"
                      aria-labelledby={`mcp-revoke-${conn.id}`}
                      className="mt-3 flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-red-900/50 dark:bg-red-900/20"
                    >
                      <p id={`mcp-revoke-${conn.id}`} className="text-sm text-red-800 dark:text-red-300">
                        {c.revokeConfirm}
                      </p>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          autoFocus
                          onClick={() => setConfirmingId(null)}
                          disabled={revokingId === conn.id}
                        >
                          {c.revokeNo}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => revoke(conn.id)} loading={revokingId === conn.id}>
                          {c.revokeYes}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

'use client'

/**
 * What /oauth/authorize shows: the consent screen and its two refusals.
 *
 * Presentation only. Every decision (session, role, validity of the request,
 * signing of the consent token) is taken on the server by the page
 * (src/app/oauth/authorize/page.tsx) before any of this renders.
 *
 * These are client components only so the text follows the language of the
 * rest of the platform (useI18n). They are rendered to HTML on the server, in
 * Spanish, and the form is a plain HTML form: it works with JavaScript off.
 *
 * SECURITY: `clientName` is text typed by whoever registered the client. It is
 * only ever rendered as a React text node (escaped). Never put it in
 * dangerouslySetInnerHTML, in a URL or in a style.
 */
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useI18n } from '@/i18n/context'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  CONSENT_FORM_ACTION,
  CONSENT_TOKEN_FIELD,
  DECISION_ALLOW,
  DECISION_DENY,
  DECISION_FIELD,
} from './consent-form'

/**
 * Fills one `{placeholder}` of a translation. The replacement goes through a
 * function so `$&`, `$1` and the like inside an untrusted value stay literal.
 */
function fill(template: string, placeholder: string, value: string): string {
  return template.replace(`{${placeholder}}`, () => value)
}

function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-gray-950">
      <div className="w-full max-w-md">
        <Card variant="elevated" className="rounded-2xl p-8 shadow-lg">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-purple-200 bg-purple-100 dark:border-purple-800 dark:bg-purple-900/30">
              <svg
                className="h-6 w-6 text-purple-600 dark:text-purple-300"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
              </svg>
            </div>
            <p className="text-sm font-semibold tracking-tight text-purple-600 dark:text-purple-300">{t.auth.title}</p>
          </div>
          {children}
        </Card>
      </div>
    </main>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 text-sm text-gray-700 dark:text-gray-300">{children}</dd>
    </div>
  )
}

export interface ConsentScreenProps {
  /** Name the client gave when it registered. Untrusted text. */
  clientName: string
  /** Where the browser goes after the decision: Claude's hosted callback or an application on this computer. */
  redirectKind: 'claude' | 'loopback'
  /** Host of the validated redirect URI, for example `claude.ai` or `localhost:53124`. */
  redirectHost: string
  /** Name of the administrator who is signed in. */
  adminName: string
  /** Token signed for this administrator and this exact request (src/lib/mcp/crypto.ts). */
  consentToken: string
}

/** «Permitir» / «Cancelar»: who is asking, what it gets, what it never gets and where it is revoked. */
export function ConsentScreen({ clientName, redirectKind, redirectHost, adminName, consentToken }: ConsentScreenProps) {
  const { t } = useI18n()
  const c = t.mcp.consent
  const returnsTo = fill(redirectKind === 'claude' ? c.returnsToClaude : c.returnsToLoopback, 'host', redirectHost)

  return (
    <Shell>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">{c.title}</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{fill(c.signedInAs, 'name', adminName)}</p>

      <dl className="mt-6 space-y-4">
        <Row label={c.whoLabel}>
          <p className="break-words text-base font-semibold text-gray-900 dark:text-white">
            <bdi>{clientName}</bdi>
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{c.whoNameHint}</p>
          <p className="mt-1 break-words">{returnsTo}</p>
        </Row>
        <Row label={c.getsLabel}>{c.gets}</Row>
        <Row label={c.neverLabel}>{c.never}</Row>
        <Row label={c.revokeLabel}>{c.revoke}</Row>
      </dl>

      <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
        {c.onlyIfYou}
      </p>

      {/* Plain HTML form: no handler, no script. «Cancelar» comes first in the
          document, so an implicit submission can never mean «Permitir». */}
      <form
        method="post"
        action={CONSENT_FORM_ACTION}
        autoComplete="off"
        className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"
      >
        <input type="hidden" name={CONSENT_TOKEN_FIELD} value={consentToken} />
        <Button type="submit" name={DECISION_FIELD} value={DECISION_DENY} variant="secondary">
          {c.cancel}
        </Button>
        <Button type="submit" name={DECISION_FIELD} value={DECISION_ALLOW} variant="primary">
          {c.allow}
        </Button>
      </form>
    </Shell>
  )
}

export interface ConsentNoticeProps {
  /** `forbidden`: signed in but not an administrator. `invalid`: unknown client or redirect URI. */
  kind: 'forbidden' | 'invalid'
  /** OAuth error code of an invalid request (one of our own fixed codes, never text from the request). */
  code?: string
}

/** The two cases in which nothing is offered and nothing is redirected. */
export function ConsentNotice({ kind, code }: ConsentNoticeProps) {
  const { t } = useI18n()
  const c = t.mcp.consent

  return (
    <Shell>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">
        {kind === 'forbidden' ? c.forbiddenTitle : c.invalidTitle}
      </h1>
      <p
        role="alert"
        className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300"
      >
        {kind === 'forbidden' ? c.forbidden : c.invalid}
      </p>
      {kind === 'invalid' && <p className="mt-4 text-sm text-gray-700 dark:text-gray-300">{c.invalidHint}</p>}
      {kind === 'invalid' && code && (
        <p className="mt-3 font-mono text-xs text-gray-400 dark:text-gray-500">{fill(c.errorCode, 'code', code)}</p>
      )}
      <div className="mt-6">
        <Link href="/dashboard" className="text-sm font-medium text-purple-600 hover:underline dark:text-purple-300">
          {c.backToPlatform}
        </Link>
      </div>
    </Shell>
  )
}

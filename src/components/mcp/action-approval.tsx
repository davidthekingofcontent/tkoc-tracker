'use client'

/**
 * What /mcp/confirmar/[id] shows: the confirmation screen of an action Claude
 * asked for (delete something, write to a person), and the notices of every
 * other state (confirmed, cancelled, run, expired, someone else's, unknown).
 *
 * Presentation only. The page (src/app/mcp/confirmar/[id]/page.tsx) decides
 * everything on the server first: the session (an active ADMIN, checked
 * against the database), the state of the action and whether this
 * administrator may decide it, and it signs the form's token.
 *
 * Client components only so the text follows the language of the platform
 * (useI18n). They render to HTML on the server, and the form is a plain HTML
 * form: it works with JavaScript off.
 *
 * SECURITY: the preview, the client name and the names of people are text
 * typed by others. They are only ever rendered as React text nodes (escaped):
 * never in dangerouslySetInnerHTML, a URL or a style.
 */
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useI18n } from '@/i18n/context'
import type { Locale } from '@/i18n/translations'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ACTION_CANCEL, ACTION_CONFIRM, ACTION_DECISION_FIELD, ACTION_PASSWORD_FIELD, ACTION_TOKEN_FIELD, actionFormAction } from './action-form'
import { MCP_WRITE_TEXTS, fillText } from './write-texts'

/** Times are shown in Spain's time zone, the same on the server and in the browser. */
const TIME_ZONE = 'Europe/Madrid'

function formatTime(iso: string, locale: Locale): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE }).format(d)
}

function formatDateTime(iso: string, locale: Locale): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  }).format(d)
}

function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-gray-950">
      <div className="w-full max-w-lg">
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
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
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

export interface ActionApprovalScreenProps {
  actionId: string
  /** Plain Spanish written by the tool from platform data. Untrusted text. */
  preview: string
  confirmation: 'destructive' | 'outbound'
  tool: string
  /** Name the Claude client gave when it registered. Untrusted text. */
  clientName: string | null
  /** The administrator who connected Claude (who is looking at this page). */
  ownerName: string
  /** ISO instant the action expires. */
  expiresAt: string
  /** Whole minutes left, computed by the server. */
  minutesLeft: number
  /** Token signed for this administrator and this action (src/lib/mcp/confirm.ts). */
  decisionToken: string
  /** The previous «Confirmar» came without the right password: nothing was confirmed. */
  passwordRefused?: boolean
}

/** The form that carries the password; the «Confirmar» button submits it from outside (`form` attribute). */
const CONFIRM_FORM_ID = 'mcp-action-confirm'

/** «Confirmar» / «Cancelar»: what will happen, who asks, until when. */
export function ActionApprovalScreen(props: ActionApprovalScreenProps) {
  const { locale } = useI18n()
  const a = MCP_WRITE_TEXTS[locale].action

  return (
    <Shell>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">{a.title}</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{fillText(a.signedInAs, { name: props.ownerName })}</p>

      <dl className="mt-6 space-y-4">
        <Row label={a.whatLabel}>
          <p className="whitespace-pre-line break-words rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-base text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-white">
            {props.preview}
          </p>
        </Row>
        <Row label={a.kindLabel}>{props.confirmation === 'outbound' ? a.kindOutbound : a.kindDestructive}</Row>
        <Row label={a.whoLabel}>
          {props.clientName && (
            <>
              <p className="break-words font-semibold text-gray-900 dark:text-white">
                <bdi>{props.clientName}</bdi>
              </p>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{a.whoNameHint}</p>
            </>
          )}
          <p className="mt-1">{fillText(a.connectedBy, { owner: props.ownerName })}</p>
        </Row>
        <Row label={a.expiresLabel}>
          {fillText(a.expires, { time: formatTime(props.expiresAt, locale), minutes: String(Math.max(0, props.minutesLeft)) })}
        </Row>
        <Row label={a.toolLabel}>
          <span className="font-mono text-xs">{props.tool}</span>
        </Row>
      </dl>

      <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
        {a.onlyIfYou}
      </p>

      {props.passwordRefused && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {a.passwordRefused}
        </p>
      )}

      {/* Two plain HTML forms, no handler, no script. «Cancelar» posts its own
          form and needs nothing more. «Confirmar» posts the form with the
          administrator's own password, typed by them: a browser driven by
          Claude can press a button but does not know it. `new-password` keeps
          the browser from filling in a saved password by itself. «Cancelar»
          comes first in the document; Enter in the password field means
          «Confirmar» (the only button of that form). */}
      <form id={CONFIRM_FORM_ID} method="post" action={actionFormAction(props.actionId)} autoComplete="off" className="mt-6">
        <input type="hidden" name={ACTION_TOKEN_FIELD} value={props.decisionToken} />
        <label htmlFor="mcp-action-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {a.passwordLabel}
        </label>
        <input
          id="mcp-action-password"
          type="password"
          name={ACTION_PASSWORD_FIELD}
          autoComplete="new-password"
          required
          maxLength={200}
          className="mt-1.5 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{a.passwordHint}</p>
      </form>
      <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        {/* The form stretches its button on a phone (column layout); Button replaces, not merges, a className */}
        <form method="post" action={actionFormAction(props.actionId)} autoComplete="off" className="flex flex-col">
          <input type="hidden" name={ACTION_TOKEN_FIELD} value={props.decisionToken} />
          <Button type="submit" name={ACTION_DECISION_FIELD} value={ACTION_CANCEL} variant="secondary">
            {a.cancel}
          </Button>
        </form>
        <Button type="submit" form={CONFIRM_FORM_ID} name={ACTION_DECISION_FIELD} value={ACTION_CONFIRM} variant="primary">
          {a.confirm}
        </Button>
      </div>
    </Shell>
  )
}

export type ActionNoticeKind =
  | 'approved'
  | 'denied'
  | 'executed'
  | 'expired'
  | 'foreign'
  | 'notFound'
  | 'forbidden'
  | 'closed'

export interface ActionNoticeProps {
  kind: ActionNoticeKind
  /** foreign: whose action it is. */
  ownerName?: string | null
  /** approved: when it expires. executed: when it ran. ISO instant. */
  at?: string | null
}

/** Every state in which nothing can be decided here. */
export function ActionNotice({ kind, ownerName, at }: ActionNoticeProps) {
  const { locale } = useI18n()
  const a = MCP_WRITE_TEXTS[locale].action
  const owner = ownerName || a.someoneElse

  const content: Record<ActionNoticeKind, { title: string; text: string; tone: 'ok' | 'info' | 'error' }> = {
    approved: { title: a.approvedTitle, text: fillText(a.approved, { time: at ? formatTime(at, locale) : '' }), tone: 'ok' },
    denied: { title: a.deniedTitle, text: a.denied, tone: 'info' },
    executed: { title: a.executedTitle, text: fillText(a.executed, { date: at ? formatDateTime(at, locale) : '' }), tone: 'info' },
    expired: { title: a.expiredTitle, text: a.expired, tone: 'info' },
    foreign: { title: a.foreignTitle, text: fillText(a.foreign, { owner }), tone: 'error' },
    notFound: { title: a.notFoundTitle, text: a.notFound, tone: 'error' },
    forbidden: { title: a.forbiddenTitle, text: a.forbidden, tone: 'error' },
    closed: { title: a.closedTitle, text: a.closed, tone: 'info' },
  }
  const { title, text, tone } = content[kind]
  const toneClass =
    tone === 'ok'
      ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300'
      : tone === 'info'
        ? 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300'
        : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300'

  return (
    <Shell>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">{title}</h1>
      <p role={tone === 'error' ? 'alert' : 'status'} className={`mt-4 rounded-lg border px-4 py-3 text-sm ${toneClass}`}>
        {text}
      </p>
      <div className="mt-6">
        <Link href="/dashboard" className="text-sm font-medium text-purple-600 hover:underline dark:text-purple-300">
          {a.backToPlatform}
        </Link>
      </div>
    </Shell>
  )
}

'use client'

/**
 * The pieces of the screen «Fichas duplicadas» (ADMIN only): a candidate card,
 * the review of a merge, its result, the history, and the notice of the
 * campaign page. Presentational only: no fetch, no state; the container
 * (./person-merge-screen.tsx) holds the state and calls the route. Every text
 * comes from `texts` (translations.personMerge) so both languages render, and
 * the sentences the server writes (evidence, warnings, summaries,
 * differences) are rendered as React text nodes only.
 *
 * Safety of the merge (owner's rule: a merge cannot be applied by accident):
 *  - «Fusionar» is enabled only on a fresh preview of exactly what is
 *    selected, with no choice missing (canMerge);
 *  - nothing is preselected where the API has no default (money and
 *    deliverables in conflict, the shipping block when both have data);
 *  - «Fusionar» only opens an in-page confirmation; «Sí, fusionar» applies.
 */
import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, ExternalLink, GitMerge, Loader2, Undo2, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/components/mcp/format'
import { cn } from '@/lib/utils'
import type { Locale } from '@/i18n/translations'
import type {
  MergeApplyResult,
  MergeCampaignEffect,
  MergeCandidate,
  MergeChoice,
  MergeChoices,
  MergeDifference,
  MergeFieldOutcome,
  MergeHistoryEntry,
  MergeMode,
  MergePreview,
  MergeProfileSummary,
  MergeStrength,
  UndoMergeResult,
} from '@/lib/person-merge'
import {
  addedValue,
  canMerge,
  chosenFor,
  fieldValueText,
  fill,
  followersText,
  isSuggestedKeep,
  mergeScreenHref,
  moneyText,
  networkName,
  piecesText,
  profileHref,
  profileLabel,
  type MergeSelection,
  type MergeTexts,
} from './merge-api'

const H4 = 'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400'
const TAG = 'inline-flex items-center rounded-full border border-purple-200 bg-purple-50 px-1.5 py-0 text-[10px] font-medium text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300'

const STRENGTH_TONE: Record<MergeStrength, string> = {
  double_count: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300',
  strong: 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  review: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
}

const NETWORK_BADGE: Record<string, 'instagram' | 'tiktok' | 'youtube'> = { INSTAGRAM: 'instagram', TIKTOK: 'tiktok', YOUTUBE: 'youtube' }

/** «Cuenta doble en una campaña» / «Fuerte» / «Revisar», with what it means on hover. */
export function StrengthBadge({ strength, texts }: { strength: MergeStrength; texts: MergeTexts }) {
  const key = (strength in STRENGTH_TONE ? strength : 'review') as MergeStrength
  return (
    <span
      title={texts.strengthHint[key]}
      className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold', STRENGTH_TONE[key])}
    >
      {texts.strength[key]}
    </span>
  )
}

function NetworkBadge({ platform }: { platform: string }) {
  return (
    <Badge variant={NETWORK_BADGE[String(platform).toUpperCase()] ?? 'default'} className="px-2 py-0 text-[10px]">
      {networkName(platform)}
    </Badge>
  )
}

/** One of the two profiles of a candidate: who she is and where she counts. */
function ProfileSummary({ profile, role, texts, locale }: { profile: MergeProfileSummary; role: 'keep' | 'other'; texts: MergeTexts; locale: Locale }) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg border p-4',
        role === 'keep'
          ? 'border-purple-200 bg-purple-50/40 dark:border-purple-800 dark:bg-purple-900/10'
          : 'border-gray-200 dark:border-gray-700'
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {role === 'keep' ? texts.suggestedKeep : texts.suggestedOther}
      </p>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
        <a
          href={profileHref(profile)}
          target="_blank"
          rel="noopener noreferrer"
          title={fill(texts.openProfile, { handle: profile.username, network: networkName(profile.platform) })}
          className="inline-flex min-w-0 items-center gap-1 text-sm font-semibold text-purple-700 hover:underline dark:text-purple-300"
        >
          <span className="truncate">@{profile.username}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
        </a>
        <NetworkBadge platform={profile.platform} />
      </div>
      {profile.displayName && <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{profile.displayName}</p>}
      <p className="mt-1 text-xs tabular-nums text-gray-600 dark:text-gray-300">
        {followersText(profile.followers ?? 0, texts, locale)} · {piecesText(profile.pieces ?? 0, texts, locale)}
      </p>
      {(profile.otherProfiles ?? []).length > 0 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {fill(texts.alsoProfiles, { list: profile.otherProfiles.map(profileLabel).join(', ') })}
        </p>
      )}
      <ul className="mt-3 space-y-1">
        {(profile.campaigns ?? []).length === 0 ? (
          <li className="text-xs text-gray-400 dark:text-gray-500">{texts.noCampaigns}</li>
        ) : (
          profile.campaigns.map(c => (
            <li key={c.id} className="text-xs leading-relaxed">
              <span className="font-medium text-gray-800 dark:text-gray-200">{c.name}</span>
              <span className="text-gray-500 dark:text-gray-400">
                {' · '}{(texts.status as Record<string, string>)[c.membershipStatus] ?? c.membershipStatus}
                {' · '}{piecesText(c.pieces ?? 0, texts, locale)}
                {c.hasFee ? ` · ${texts.hasFee}` : ''}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

export interface CandidateCardProps {
  candidate: MergeCandidate
  texts: MergeTexts
  locale: Locale
  /** The review of this pair is open (rendered below, as children) */
  reviewing: boolean
  /** Its dismissal is on its way */
  dismissing: boolean
  /** Another operation is running: the buttons wait */
  busy: boolean
  /** Why the last action on this card failed */
  error?: string | null
  onReview: () => void
  onDismiss: () => void
  children?: ReactNode
}

/** A pair that may be one creator: both profiles side by side, why, and what to do. */
export function CandidateCard({ candidate, texts, locale, reviewing, dismissing, busy, error, onReview, onDismiss, children }: CandidateCardProps) {
  const [keep, other] = candidate.profiles
  return (
    <article
      data-candidate={candidate.key}
      className={cn(
        'rounded-xl border bg-white p-5 shadow-sm dark:bg-gray-900',
        reviewing ? 'border-purple-300 dark:border-purple-700' : 'border-gray-200 dark:border-gray-700'
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StrengthBadge strength={candidate.strength} texts={texts} />
        {(candidate.sharedCampaigns ?? []).map(sc => (
          <span key={sc.id} className="text-xs text-gray-600 dark:text-gray-300">
            <span className="font-medium">{sc.name}</span>
            {': '}
            <span className="tabular-nums">{fill(texts.membersBeforeAfter, { before: sc.membersBefore, after: sc.membersAfter })}</span>
          </span>
        ))}
      </header>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ProfileSummary profile={keep} role="keep" texts={texts} locale={locale} />
        <ProfileSummary profile={other} role="other" texts={texts} locale={locale} />
      </div>

      <div className="mt-4">
        <p className={H4}>{texts.evidenceTitle}</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
          {(candidate.evidence ?? []).map((e, i) => (
            <li key={`${e.code}-${i}`}>{e.text}</li>
          ))}
        </ul>
        {candidate.suggestion?.reason && (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{fill(texts.suggestion, { reason: candidate.suggestion.reason })}</p>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {!reviewing && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={onReview} disabled={busy || dismissing}>
            <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
            {texts.review}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDismiss} disabled={busy} loading={dismissing}>
            {dismissing ? texts.dismissing : texts.dismiss}
          </Button>
        </div>
      )}

      {children}
    </article>
  )
}

// ===========================================================================
// The review
// ===========================================================================

export type ReviewStep = 'review' | 'confirm' | 'applying'

export interface ReviewPanelProps {
  candidate: MergeCandidate
  selection: MergeSelection
  choices: MergeChoices
  /** The last preview received (it may be of an older selection while a new one is computed) */
  preview: MergePreview | null
  loading: boolean
  error: string | null
  /** A notice that is not an error («los datos han cambiado…») */
  notice: string | null
  step: ReviewStep
  texts: MergeTexts
  locale: Locale
  onKeep: (id: string) => void
  onMode: (mode: MergeMode) => void
  onChoice: (campaignId: string, group: string, choice: MergeChoice) => void
  onMerge: () => void
  onConfirm: () => void
  onBack: () => void
  onCancel: () => void
}

/**
 * The name of a field of the membership row in the screen's language. The
 * server's label (Spanish) is the fallback for a column added later.
 */
export function fieldLabelOf(f: { group: string; label: string }, texts: MergeTexts): string {
  return (texts.fieldLabel as Record<string, string> | undefined)?.[f.group] ?? f.label
}

/** The preview only counts when it is of exactly what is selected. */
function previewOfSelection(preview: MergePreview | null, selection: MergeSelection): MergePreview | null {
  return preview && preview.keep?.id === selection.keepId && preview.other?.id === selection.otherId && preview.mode === selection.mode ? preview : null
}

function Choice({ name, checked, disabled, onChange, children, className }: { name: string; checked: boolean; disabled?: boolean; onChange: () => void; children: ReactNode; className?: string }) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
        checked
          ? 'border-purple-400 bg-white dark:border-purple-600 dark:bg-gray-900'
          : 'border-gray-200 bg-white/60 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900/60',
        disabled && 'cursor-not-allowed opacity-70',
        className
      )}
    >
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} className="mt-0.5 shrink-0 accent-purple-600" />
      <span className="min-w-0">{children}</span>
    </label>
  )
}

export function ReviewPanel(props: ReviewPanelProps) {
  const { candidate, selection, choices, preview, loading, error, notice, step, texts, locale } = props
  const locked = step !== 'review'
  const fresh = previewOfSelection(preview, selection)
  const ready = canMerge(preview, selection, loading)
  const campaignName = new Map((fresh?.campaigns ?? []).map(c => [c.campaignId, c.campaignName]))
  const missing = (fresh?.missingChoices ?? []).map(m => `${fieldLabelOf(m, texts)} («${campaignName.get(m.campaignId) ?? m.campaignId}»)`)
  // The suggestion is about its record staying: with the other record kept, no mode is «sugerida»
  const suggestedHere = isSuggestedKeep(candidate, selection.keepId)

  return (
    <section
      aria-label={texts.reviewTitle}
      className="mt-5 rounded-xl border border-purple-200 bg-purple-50/30 p-4 dark:border-purple-900 dark:bg-purple-950/20"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{texts.reviewTitle}</h3>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={step === 'applying'}
          aria-label={texts.close}
          className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 1. Which record stays */}
      <fieldset disabled={locked} className="mt-3">
        <legend className="text-sm font-medium text-gray-900 dark:text-gray-100">{texts.keepQuestion}</legend>
        <p className="text-xs text-gray-500 dark:text-gray-400">{texts.keepHint}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {candidate.profiles.map(p => (
            <Choice key={p.id} name={`keep-${candidate.key}`} checked={selection.keepId === p.id} disabled={locked} onChange={() => props.onKeep(p.id)}>
              <span className="font-medium text-gray-900 dark:text-gray-100">{profileLabel(p)}</span>
              <span className="text-gray-500 dark:text-gray-400"> · {followersText(p.followers ?? 0, texts, locale)}</span>
              {p.id === candidate.suggestion?.keepId && <span className={cn(TAG, 'ml-1.5')}>{texts.suggestedTag}</span>}
            </Choice>
          ))}
        </div>
      </fieldset>

      {/* 2. What the other record is */}
      <fieldset disabled={locked} className="mt-4">
        <legend className="text-sm font-medium text-gray-900 dark:text-gray-100">{texts.modeQuestion}</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(['link', 'absorb'] as const).map(m => (
            <Choice key={m} name={`mode-${candidate.key}`} checked={selection.mode === m} disabled={locked} onChange={() => props.onMode(m)}>
              <span className="font-medium text-gray-900 dark:text-gray-100">{m === 'link' ? texts.modeLink : texts.modeAbsorb}</span>
              {suggestedHere && m === candidate.suggestion?.mode && <span className={cn(TAG, 'ml-1.5')}>{texts.suggestedTag}</span>}
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{m === 'link' ? texts.modeLinkHint : texts.modeAbsorbHint}</span>
            </Choice>
          ))}
        </div>
      </fieldset>

      {loading && (
        <p className="mt-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {texts.calculating}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">{notice}</p>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">{error}</p>
      )}

      {fresh && <PreviewDetails preview={fresh} choices={choices} locked={locked} texts={texts} locale={locale} onChoice={props.onChoice} />}

      {step === 'review' ? (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button onClick={props.onMerge} disabled={!ready}>
            <GitMerge className="h-4 w-4" aria-hidden="true" />
            {texts.merge}
          </Button>
          <Button variant="ghost" onClick={props.onCancel}>{texts.cancel}</Button>
          {fresh?.nothingToDo && <span className="text-sm text-gray-600 dark:text-gray-400">{texts.nothingToDo}</span>}
          {missing.length > 0 && (
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{fill(texts.missingChoices, { list: missing.join(', ') })}</span>
          )}
        </div>
      ) : (
        fresh && (
          <div
            role="alertdialog"
            aria-labelledby={`confirm-${candidate.key}`}
            className="mt-5 rounded-lg border-2 border-purple-300 bg-white p-4 dark:border-purple-700 dark:bg-gray-900"
          >
            <p id={`confirm-${candidate.key}`} className="text-sm font-semibold text-gray-900 dark:text-gray-100">{texts.confirmTitle}</p>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{fresh.summary}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{texts.confirmBody}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={props.onConfirm} loading={step === 'applying'}>
                {step === 'applying' ? texts.applying : texts.confirmYes}
              </Button>
              <Button variant="secondary" onClick={props.onBack} disabled={step === 'applying'}>{texts.confirmBack}</Button>
            </div>
          </div>
        )
      )}
    </section>
  )
}

function actionText(c: MergeCampaignEffect, preview: MergePreview, texts: MergeTexts): string {
  if (c.action === 'fold') return fill(texts.actionFold, { handle: c.survivor?.username ?? preview.keep.username })
  if (c.action === 'move') return fill(texts.actionMove, { handle: c.target?.username ?? preview.keep.username })
  return texts.actionUnchanged
}

function WarningList({ items, texts }: { items: string[]; texts: MergeTexts }) {
  if (items.length === 0) return null
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 dark:border-amber-800 dark:bg-amber-900/10">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        {texts.warningsTitle}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-900 dark:text-amber-200">
        {items.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </div>
  )
}

/** What the preview says: the person, the campaigns, the conflicts with their choices, the warnings. */
function PreviewDetails({ preview, choices, locked, texts, locale, onChoice }: {
  preview: MergePreview
  choices: MergeChoices
  locked: boolean
  texts: MergeTexts
  locale: Locale
  onChoice: ReviewPanelProps['onChoice']
}) {
  const { person } = preview
  const showPerson = person.createsPerson || person.joining.length > 0 || person.otherLeavesPerson
  return (
    <div className="mt-4 space-y-4">
      {showPerson && (
        <div>
          <p className={H4}>{texts.personTitle}</p>
          <ul className="mt-1 space-y-0.5 text-sm text-gray-700 dark:text-gray-300">
            {person.createsPerson && <li>{texts.personCreates}</li>}
            {person.joining.length > 0 && <li>{fill(texts.personJoins, { list: person.joining.map(profileLabel).join(', ') })}</li>}
            {person.otherLeavesPerson && <li>{fill(texts.personLeaves, { handle: preview.other.username })}</li>}
          </ul>
        </div>
      )}

      <div>
        <p className={H4}>{texts.effectsTitle}</p>
        {preview.campaigns.length === 0 ? (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{texts.noCampaignEffects}</p>
        ) : (
          <div className="mt-1.5 overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">{texts.colCampaign}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{texts.colAction}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{texts.colMembers}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{texts.colPieces}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{texts.colViews}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{texts.colCost}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {preview.campaigns.map(c => (
                  <tr key={c.campaignId} data-campaign={c.campaignId} className="align-top">
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{c.campaignName}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{actionText(c, preview, texts)}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                      {c.membersBefore} → <span className={cn(c.membersAfter !== c.membersBefore && 'font-semibold text-purple-700 dark:text-purple-300')}>{c.membersAfter}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">{c.piecesBefore} → {c.piecesAfter}</td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{texts.unchanged}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                      {moneyText(c.costBefore, locale)} → {c.costAfter === null ? <span className="font-medium text-amber-700 dark:text-amber-400">{texts.costPending}</span> : moneyText(c.costAfter, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {preview.campaigns.map(c => (
        <CampaignDetails key={c.campaignId} effect={c} preview={preview} choices={choices} locked={locked} texts={texts} locale={locale} onChoice={onChoice} />
      ))}

      <WarningList items={preview.warnings ?? []} texts={texts} />
    </div>
  )
}

function CampaignDetails({ effect: c, preview, choices, locked, texts, locale, onChoice }: {
  effect: MergeCampaignEffect
  preview: MergePreview
  choices: MergeChoices
  locked: boolean
  texts: MergeTexts
  locale: Locale
  onChoice: ReviewPanelProps['onChoice']
}) {
  const conflicts = c.conflicts ?? []
  const completed = (c.fields ?? []).filter(f => !f.conflict)
  const duplicates = c.duplicates ?? []
  const warnings = c.warnings ?? []
  if (conflicts.length === 0 && completed.length === 0 && duplicates.length === 0 && warnings.length === 0) return null
  const survivorHandle = c.survivor?.username ?? preview.keep.username
  const otherHandle = preview.other.username

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-campaign-details={c.campaignId}>
      {conflicts.length > 0 && (
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{fill(texts.conflictsTitle, { campaign: c.campaignName })}</p>
          <div className="mt-2 space-y-2">
            {conflicts.map(f => (
              <ConflictChoice
                key={f.group}
                field={f}
                campaignId={c.campaignId}
                current={chosenFor(choices, c.campaignId, f)}
                survivorHandle={survivorHandle}
                otherHandle={otherHandle}
                locked={locked}
                texts={texts}
                locale={locale}
                onChoice={onChoice}
              />
            ))}
          </div>
        </div>
      )}

      {completed.length > 0 && (
        <div>
          <p className={H4}>{texts.completedTitle} · {c.campaignName}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-gray-600 dark:text-gray-400">
            {completed.map(f => (
              <li key={f.group}>
                {f.resolution === 'joined'
                  ? fill(texts.fieldJoined, { label: fieldLabelOf(f, texts) })
                  : f.resolution === 'earliest'
                    ? fill(texts.fieldEarliest, { label: fieldLabelOf(f, texts), value: fieldValueText(f, f.otherValue, texts, locale) })
                    : fill(texts.fieldFromOther, { label: fieldLabelOf(f, texts), value: fieldValueText(f, f.result ?? f.otherValue, texts, locale), handle: otherHandle })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {duplicates.length > 0 && (
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{texts.duplicatesTitle}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{texts.duplicatesHint}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {duplicates.map(d => (
              <li key={d.detachMediaId} className="text-gray-600 dark:text-gray-400">
                {networkName(d.platform)}
                {d.permalink && /^https:\/\//i.test(d.permalink) && (
                  <>
                    {' · '}
                    <a href={d.permalink} target="_blank" rel="noopener noreferrer" className="text-purple-700 hover:underline dark:text-purple-300">{texts.viewPost}</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <WarningList items={warnings} texts={texts} />
    </div>
  )
}

/** One field in conflict: the options side by side; nothing checked while the API has no default and nobody chose. */
function ConflictChoice({ field: f, campaignId, current, survivorHandle, otherHandle, locked, texts, locale, onChoice }: {
  field: MergeFieldOutcome
  campaignId: string
  current: MergeChoice | null
  survivorHandle: string
  otherHandle: string
  locked: boolean
  texts: MergeTexts
  locale: Locale
  onChoice: ReviewPanelProps['onChoice']
}) {
  const value = (v: unknown) => fieldValueText(f, v, texts, locale)
  const label = (opt: MergeChoice) =>
    opt === 'add'
      ? fill(texts.optionAdd, { value: value(addedValue(f)) })
      : fill(opt === 'keep' ? texts.optionKeep : texts.optionOther, {
          handle: opt === 'keep' ? survivorHandle : otherHandle,
          value: value(opt === 'keep' ? f.survivorValue : f.otherValue),
        })
  return (
    <fieldset disabled={locked} data-conflict={f.group} className={cn('rounded-lg border p-3', current === null ? 'border-amber-300 bg-amber-50/40 dark:border-amber-700 dark:bg-amber-900/10' : 'border-gray-200 dark:border-gray-700')}>
      <legend className="px-1 text-sm font-medium text-gray-900 dark:text-gray-100">
        {fieldLabelOf(f, texts)}
        {current === null && <span className="ml-2 text-xs font-semibold text-amber-700 dark:text-amber-400">{texts.conflictNeedsChoice}</span>}
      </legend>
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {(f.options ?? []).map(opt => (
          <Choice key={opt} name={`choice-${campaignId}-${f.group}`} checked={current === opt} disabled={locked} onChange={() => onChoice(campaignId, f.group, opt)}>
            <span className="text-gray-800 dark:text-gray-200">{label(opt)}</span>
            {f.default === opt && <span className="ml-1 text-xs text-gray-400">({texts.defaultTag})</span>}
          </Choice>
        ))}
      </div>
    </fieldset>
  )
}

// ===========================================================================
// Result, history, notice
// ===========================================================================

/** What the last merge did (the ADMIN can undo it from the history). */
export function MergeResultPanel({ result, texts, locale, onClose }: { result: MergeApplyResult; texts: MergeTexts; locale: Locale; onClose: () => void }) {
  const changed = (result.campaigns ?? []).filter(c => c.action !== 'unchanged')
  return (
    <div role="status" className="rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-green-800 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {texts.resultTitle}
        </p>
        <button type="button" onClick={onClose} aria-label={texts.close} className="rounded p-0.5 text-green-700 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-900/40">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-1 text-sm text-green-900 dark:text-green-200">{result.summary}</p>
      {changed.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs tabular-nums text-green-900 dark:text-green-200">
          {changed.map(c => (
            <li key={c.campaignId}>
              <span className="font-medium">{c.campaignName}</span>
              {`: ${texts.colMembers.toLowerCase()} ${c.membersBefore} → ${c.membersAfter} · ${texts.colPieces.toLowerCase()} ${c.piecesBefore} → ${c.piecesAfter} · ${texts.colCost.toLowerCase()} ${moneyText(c.costBefore, locale)} → ${moneyText(c.costAfter, locale)}`}
            </li>
          ))}
        </ul>
      )}
      {(result.warnings ?? []).length > 0 && <div className="mt-2"><WarningList items={result.warnings} texts={texts} /></div>}
      <p className="mt-2 text-xs text-green-800 dark:text-green-300">{texts.resultUndoHint}</p>
    </div>
  )
}

/** The state of an undo asked from the history. */
export interface UndoView {
  status: 'sending' | 'ask_force' | 'blocked' | 'error' | 'done'
  /** The server's sentence (or ours when there was no answer) */
  message?: string | null
  differences?: MergeDifference[]
  result?: UndoMergeResult | null
  /** The ADMIN already saw the differences and forces it */
  forcing?: boolean
  /** The hash of `differences`: a forced undo sends it, so it overwrites exactly this list */
  differencesHash?: string | null
  /** The list changed after it was shown, while forcing: it is asked again */
  changedAgain?: boolean
}

export interface HistoryListProps {
  entries: MergeHistoryEntry[]
  undo: Record<string, UndoView>
  /** Another operation is running: the buttons wait */
  busy: boolean
  texts: MergeTexts
  locale: Locale
  onUndo: (logId: string) => void
  onForce: (logId: string) => void
  onCancelUndo: (logId: string) => void
}

function DifferenceList({ items }: { items: MergeDifference[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
      {items.map((d, i) => <li key={`${d.kind}-${d.id}-${i}`}>{d.text}</li>)}
    </ul>
  )
}

function UndoMessage({ logId, view, entry, texts, onForce, onCancelUndo }: { logId: string; view: UndoView; entry: MergeHistoryEntry; texts: MergeTexts; onForce: (id: string) => void; onCancelUndo: (id: string) => void }) {
  if (view.status === 'ask_force' || (view.status === 'sending' && view.forcing)) {
    const sending = view.status === 'sending'
    return (
      <div role="alertdialog" aria-label={texts.undoChangedTitle} className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="text-sm font-semibold">{texts.undoChangedTitle}</p>
        {view.changedAgain && <p className="mt-0.5 text-xs font-semibold">{texts.undoChangedAgain}</p>}
        <p className="mt-0.5 text-xs">{texts.undoChangedBody}</p>
        <DifferenceList items={view.differences ?? []} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="danger" onClick={() => onForce(logId)} loading={sending}>{sending ? texts.undoing : texts.undoForce}</Button>
          <Button size="sm" variant="secondary" onClick={() => onCancelUndo(logId)} disabled={sending}>{texts.cancel}</Button>
        </div>
      </div>
    )
  }
  if (view.status === 'blocked') {
    return (
      <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        <p className="text-sm font-semibold">{texts.undoBlockedTitle}</p>
        {view.message && <p className="mt-0.5 text-xs">{view.message}</p>}
        <p className="mt-1 text-xs">{texts.undoBlockedBody}</p>
        <DifferenceList items={view.differences ?? []} />
      </div>
    )
  }
  if (view.status === 'error') {
    return <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{view.message || texts.undoError}</p>
  }
  if (view.status === 'done' && view.result) {
    const r = view.result
    // «Todo vuelve a estar como antes» only when nothing was overwritten and everything went back
    const partial = (r.overwritten ?? []).length > 0 || (r.notRestored ?? []).length > 0
    const head = r.alreadyUndone
      ? texts.undoAlready
      : (r.kind === 'dismiss_candidate' || entry.action === 'dismiss_candidate')
        ? texts.undoDismissDone
        : partial ? texts.undoDonePartial : texts.undoDone
    return (
      <div role="status" className="mt-2 text-xs text-green-700 dark:text-green-400">
        <p>{head}</p>
        {(r.overwritten ?? []).length > 0 && <p className="mt-0.5 text-amber-700 dark:text-amber-400">{fill(texts.undoOverwritten, { list: r.overwritten.map(d => d.text).join(' ') })}</p>}
        {(r.notRestored ?? []).length > 0 && <p className="mt-0.5 text-amber-700 dark:text-amber-400">{fill(texts.undoNotRestored, { list: r.notRestored.join(' ') })}</p>}
      </div>
    )
  }
  return null
}

/** The last merges and dismissals: what, who, when, and «Deshacer». */
export function HistoryList({ entries, undo, busy, texts, locale, onUndo, onForce, onCancelUndo }: HistoryListProps) {
  if (entries.length === 0) {
    return <p className="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">{texts.historyEmpty}</p>
  }
  return (
    <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm dark:divide-gray-800 dark:border-gray-700 dark:bg-gray-900">
      {entries.map(e => {
        const view = undo[e.logId]
        const sending = view?.status === 'sending'
        // The button stays while nothing else is asked about this entry; after a
        // refusal (blocked) it is offered again, to retry once it is solved
        const showButton = e.undoable && (!view || view.status === 'error' || view.status === 'blocked' || (sending && !view.forcing))
        return (
          <li key={e.logId} data-log={e.logId} className="px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0 text-[11px] font-medium',
                    e.action === 'merge'
                      ? 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
                      : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'
                  )}>
                    {e.action === 'merge' ? texts.historyMerge : texts.historyDismiss}
                  </span>
                  <time dateTime={e.createdAt}>{formatDateTime(e.createdAt, locale)}</time>
                  {e.actorName && <span>{fill(texts.historyBy, { name: e.actorName })}</span>}
                </div>
                <p className={cn('mt-1 text-sm', e.undoneAt ? 'text-gray-400 line-through dark:text-gray-500' : 'text-gray-800 dark:text-gray-200')}>{e.summary}</p>
                {e.undoneAt && (
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {e.undoneByName
                      ? fill(texts.historyUndoneBy, { date: formatDateTime(e.undoneAt, locale), name: e.undoneByName })
                      : fill(texts.historyUndone, { date: formatDateTime(e.undoneAt, locale) })}
                  </p>
                )}
              </div>
              {showButton && (
                <Button size="sm" variant="secondary" onClick={() => onUndo(e.logId)} disabled={busy && !sending} loading={sending}>
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {sending ? texts.undoing : texts.undo}
                </Button>
              )}
            </div>
            {view && <UndoMessage logId={e.logId} view={view} entry={e} texts={texts} onForce={onForce} onCancelUndo={onCancelUndo} />}
          </li>
        )
      })}
    </ul>
  )
}

/** Campaign page, ADMIN only: «Hay N posibles fichas duplicadas en esta campaña. Revisarlas». */
export function DuplicatesNoticeView({ count, campaignId, texts }: { count: number; campaignId: string; texts: MergeTexts }) {
  if (!(count > 0)) return null
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
      <Users className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span>{count === 1 ? texts.noticeOne : fill(texts.noticeMany, { n: count })}</span>
      <Link href={mergeScreenHref(campaignId)} className="font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-100">
        {count === 1 ? texts.noticeLinkOne : texts.noticeLinkMany}
      </Link>
      <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">{texts.adminOnly}</span>
    </div>
  )
}

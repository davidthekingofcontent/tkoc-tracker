'use client'

import { useState } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { useI18n } from '@/i18n/context'
import type { TranslationKeys } from '@/i18n/translations'
import { AlertCircle, AlertTriangle, Loader2, UserPlus } from 'lucide-react'

/**
 * «¿De quién es esta publicación?» — the confirmation of «Añadir publicación por URL»
 * (a creator is a person with several profiles, Nov 2026).
 *
 * POST /api/campaigns/[id]/media/manual answers 409 `profile_not_linked` when the author
 * of the pasted link is not a registered profile of any creator of the campaign. Nothing
 * was created by that answer. Here the PM says which creator the profile belongs to and
 * the SAME request is sent again with `linkProfileTo` (and `confirmUnverified: true` when
 * the network could not confirm the author): the server then registers the profile on
 * that creator and stores the publication under her. No member is ever created.
 *
 * The answer is about the author SHOWN here: it travels with the request
 * (`linkProfileAuthor`, `linkProfileAuthorPlatform`). The server reads the author again on every request, and when it
 * reads another one (the network answered this time and not before, or the other way
 * round) it links nothing and asks again: the dialog then shows that author, with nothing
 * chosen, and the PM answers for it.
 *
 * The page keeps the refused request in state (`LinkProfileRequest`) and renders this
 * component; null means closed.
 */

export interface LinkProfileAuthor {
  /** Without the leading @ */
  handle: string
  /** INSTAGRAM | TIKTOK | YOUTUBE: the network of the publication */
  platform: string
  /** true = read from the network (scraped); false = only what the link says */
  verified: boolean
}

export interface LinkProfileSuggestion {
  influencerId: string
  username: string
  platform: string
  /** selected | bio_link | same_handle (anything else is shown without a reason) */
  reason: string
}

export interface LinkProfileRequest {
  /** JSON body of the request that was answered 409: sent again as it was, plus the PM's answer */
  body: Record<string, unknown>
  author: LinkProfileAuthor
  /** Strongest first, as the server sent them */
  suggestions: LinkProfileSuggestion[]
}

/** A campaign member as the campaign page holds it (CampaignInfluencer with its influencer) */
interface MemberLike {
  influencer?: { id: string; username: string; platform: string } | null
}

type Texts = TranslationKeys['campaignDetail']

/** What the server stored, as its answer says (the form names the piece from it) */
export interface LinkProfileSaved {
  /** The stored row of the answer (`media`), when it came */
  media?: Record<string, unknown>
  /** false = the publication was already in the campaign and was updated */
  created?: boolean
}

export type LinkProfileOutcome =
  | ({ kind: 'done'; message: string } & LinkProfileSaved)
  /** The network could not confirm the author this time: the PM must tick the confirmation */
  | { kind: 'confirm_unverified' }
  /** The server read ANOTHER author than the one the PM answered for: nothing was linked, ask again about this one */
  | ({ kind: 'author_changed' } & Pick<LinkProfileRequest, 'author' | 'suggestions'>)
  /** The content could not be dated: the form has to ask for the date */
  | { kind: 'needs_date'; message: string }
  | { kind: 'error'; message: string }

/**
 * How the LAST resend ended, when it neither stored the publication nor asked again.
 * The form says it when the PM closes the question: closing after a failed resend is
 * not "closed without answering".
 */
export type LinkProfileFailure =
  /** No answer (the connection dropped, or a proxy answered in place of the server): it may have been stored */
  | { kind: 'network' }
  /** The server answered and refused it, with its own sentence */
  | { kind: 'refused'; message: string }

/**
 * No usable answer: a gateway or proxy answered (502, 503, 504 during a deploy or a
 * restart) with something that is not the server's JSON. The request may or may not
 * have been processed, so nothing can be said about the link but "not confirmed".
 */
export function noClearAnswer(res: { ok: boolean; status: number }, data: unknown): boolean {
  return !res.ok && res.status >= 502 && !isRecord(data)
}

/**
 * How an answer to the resend that did not store the publication leaves the question.
 * A refusal (or an undated content with nowhere to ask for the date) is the server's
 * reason; a new question (another author, or a confirmation to tick) is no failure:
 * nothing was stored and the PM is asked again.
 */
export function failureOf(outcome: LinkProfileOutcome): LinkProfileFailure | null {
  return outcome.kind === 'error' || outcome.kind === 'needs_date' ? { kind: 'refused', message: outcome.message } : null
}

/**
 * What the form says about the link when the PM closes the question: «Sin confirmar»
 * when the last resend got no answer (it may be stored), the server's reason when it
 * refused it, and «has cerrado la pregunta sin responder» only when nothing was sent
 * (or the server asked again).
 */
export function closedQuestionResult(lastFailure: LinkProfileFailure | null, link: string, texts: Texts): { type: 'error'; title: string; message: string } {
  if (lastFailure?.kind === 'network') return { type: 'error', title: fill(texts.manualResultUnknown, { link }), message: texts.manualDetailNetworkError }
  if (lastFailure?.kind === 'refused') return { type: 'error', title: fill(texts.manualResultNotAdded, { link }), message: lastFailure.message }
  return { type: 'error', title: fill(texts.manualResultNotAdded, { link }), message: texts.manualDetailCancelled }
}

const NETWORK_LABEL: Record<string, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' }

function networkLabel(platform: string): string {
  return NETWORK_LABEL[platform.toUpperCase()] ?? platform
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bareHandle(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/^@+/, '').trim() : ''
}

function sameAuthor(a: LinkProfileAuthor, b: LinkProfileAuthor): boolean {
  return a.handle.toLowerCase() === b.handle.toLowerCase() && a.platform.toUpperCase() === b.platform.toUpperCase()
}

/** Fills the {placeholders} of a sentence; the values are inserted literally */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

/**
 * Reads the 409 `profile_not_linked` answer of the manual endpoint. null for any other
 * answer (or a malformed one): the caller then shows the error text as it always did.
 */
export function profileNotLinkedFrom(status: number, data: unknown): Pick<LinkProfileRequest, 'author' | 'suggestions'> | null {
  if (status !== 409 || !isRecord(data) || data.code !== 'profile_not_linked') return null
  const author = data.author
  if (!isRecord(author)) return null
  const handle = bareHandle(author.handle)
  const platform = typeof author.platform === 'string' ? author.platform.trim() : ''
  if (!handle || !platform) return null

  const suggestions: LinkProfileSuggestion[] = []
  if (Array.isArray(data.suggestions)) {
    for (const s of data.suggestions) {
      if (!isRecord(s) || typeof s.influencerId !== 'string' || !s.influencerId) continue
      const influencerId = s.influencerId
      if (suggestions.some(x => x.influencerId === influencerId)) continue
      suggestions.push({
        influencerId,
        username: bareHandle(s.username),
        platform: typeof s.platform === 'string' ? s.platform : '',
        reason: typeof s.reason === 'string' ? s.reason : '',
      })
    }
  }
  // Anything but an explicit `true` is treated as unverified: the PM is asked to confirm
  return { author: { handle, platform, verified: author.verified === true }, suggestions }
}

/**
 * Options of «Es otro perfil de:»: the suggestions first (with why they are suggested),
 * then the rest of the members by username. `suggested` are the ids of the suggestions
 * that made it into the list, in order.
 */
export function linkProfileOptions(
  suggestions: LinkProfileSuggestion[],
  members: ReadonlyArray<MemberLike>,
  texts: Texts,
): { options: { value: string; label: string }[]; suggested: string[] } {
  const reasonText: Record<string, string> = {
    selected: texts.linkProfileReasonSelected,
    bio_link: texts.linkProfileReasonBioLink,
    same_handle: texts.linkProfileReasonSameHandle,
  }
  const profiles = members.flatMap(m => (m.influencer ? [m.influencer] : []))
  const byId = new Map(profiles.map(p => [p.id, p]))
  const labelOf = (username: string, platform: string) =>
    platform ? `@${username} · ${networkLabel(platform)}` : `@${username}`

  const options: { value: string; label: string }[] = []
  const suggested: string[] = []
  for (const s of suggestions) {
    if (suggested.includes(s.influencerId)) continue
    const known = byId.get(s.influencerId)
    const username = s.username || known?.username || ''
    if (!username) continue
    const reason = reasonText[s.reason]
    const label = labelOf(username, s.platform || known?.platform || '')
    options.push({ value: s.influencerId, label: reason ? `${label} · ${reason}` : label })
    suggested.push(s.influencerId)
  }
  const rest = profiles
    .filter((p, i) => !suggested.includes(p.id) && profiles.findIndex(q => q.id === p.id) === i)
    .sort((a, b) => a.username.localeCompare(b.username, 'es', { sensitivity: 'base' }))
  for (const p of rest) options.push({ value: p.id, label: labelOf(p.username, p.platform) })
  return { options, suggested }
}

/**
 * The same request again with the PM's answer. `influencerId` is set to the chosen creator
 * too, so the «Creador» picked in the form can never contradict the answer given here.
 * `linkProfileAuthor` and `linkProfileAuthorPlatform` are the author and the network the PM
 * was shown when she answered: the server links nothing when the author it reads for this
 * request is another one, or on another network.
 */
export function linkProfileResendBody(
  body: Record<string, unknown>,
  memberInfluencerId: string,
  confirmUnverified: boolean,
  shownAuthorHandle: string,
  shownAuthorPlatform?: string,
): Record<string, unknown> {
  // Never an answer left in the kept request: only the one given now travels
  const rest: Record<string, unknown> = { ...body }
  delete rest.linkProfileAuthorPlatform
  const platform = typeof shownAuthorPlatform === 'string' ? shownAuthorPlatform.trim().toUpperCase() : ''
  return {
    ...rest,
    influencerId: memberInfluencerId,
    linkProfileTo: memberInfluencerId,
    linkProfileAuthor: bareHandle(shownAuthorHandle),
    ...(platform ? { linkProfileAuthorPlatform: platform } : {}),
    ...(confirmUnverified ? { confirmUnverified: true } : {}),
  }
}

/**
 * What the answer to the resent request means for the modal. `shownAuthor` is the author
 * the PM answered for: a new question about ANOTHER author replaces the one on screen.
 */
export function readLinkProfileAnswer(args: { ok: boolean; status: number; data: unknown; sentConfirmUnverified: boolean; texts: Texts; shownAuthor?: LinkProfileAuthor }): LinkProfileOutcome {
  const { ok, status, data, sentConfirmUnverified, texts, shownAuthor } = args
  const body = isRecord(data) ? data : {}

  if (ok) {
    // The server says what it linked; without it nothing is claimed about the profile
    const linked = body.linkedProfile
    const author = isRecord(linked) ? bareHandle(linked.handle) : ''
    const creator = isRecord(linked) ? bareHandle(linked.memberUsername) : ''
    return {
      kind: 'done',
      message: author && creator
        ? fill(texts.linkProfileAdded, { author, creator })
        : texts.linkProfileAddedPlain,
      // The stored row and whether it was new, so the form can name THIS piece (network, who published it, type, date)
      ...(isRecord(body.media) ? { media: body.media } : {}),
      ...(typeof body.created === 'boolean' ? { created: body.created } : {}),
    }
  }

  const errorText = typeof body.error === 'string' && body.error.trim() ? body.error : texts.linkProfileError
  if (status === 409 && body.code === 'profile_not_linked') {
    const again = profileNotLinkedFrom(status, data)
    if (again && shownAuthor && !sameAuthor(again.author, shownAuthor)) return { kind: 'author_changed', ...again }
    const author = body.author
    const stillUnverified = isRecord(author) && author.verified !== true
    if (stillUnverified && !sentConfirmUnverified) return { kind: 'confirm_unverified' }
    return { kind: 'error', message: errorText }
  }
  if (body.needsPostedAt === true) return { kind: 'needs_date', message: errorText }
  // 409 profile_of_other_person, dates outside the campaign, a duplicate under another creator…: the server's own sentence
  return { kind: 'error', message: errorText }
}

interface LinkProfileConfirmProps {
  campaignId: string
  /** The refused request; null = closed */
  request: LinkProfileRequest | null
  /** Members of the campaign (the page's list) */
  members: ReadonlyArray<MemberLike>
  /** Closed by the PM. `lastFailure` = how the last resend ended (null: none was sent, or it asked again) */
  onClose: (lastFailure: LinkProfileFailure | null) => void
  /** The publication was stored: `message` is the sentence to show, `saved` what the server says it stored */
  onDone: (message: string, saved: LinkProfileSaved) => void
  /** The server could not date the content: close and let the form ask for the date */
  onNeedsPostedAt?: (message: string) => void
}

export function LinkProfileConfirm({ request, ...rest }: LinkProfileConfirmProps) {
  // Mounted only while there is a question to ask, and keyed by it: every new 409 starts clean
  if (!request) return null
  const key = [String(request.body.url ?? ''), request.author.platform, request.author.handle, request.author.verified ? 'v' : 'u'].join('|')
  return <LinkProfileDialog key={key} request={request} {...rest} />
}

function LinkProfileDialog({ campaignId, request, members, onClose, onDone, onNeedsPostedAt }: Omit<LinkProfileConfirmProps, 'request'> & { request: LinkProfileRequest }) {
  const { t } = useI18n()
  const texts = t.campaignDetail
  // The question on screen. It starts as the refused request's and is replaced when the
  // server, asked again, reads another author: the PM always answers for what she sees.
  const [asked, setAsked] = useState<Pick<LinkProfileRequest, 'author' | 'suggestions'>>({ author: request.author, suggestions: request.suggestions })
  const { options, suggested } = linkProfileOptions(asked.suggestions, members, texts)

  // Nothing preselected unless there is exactly one suggestion
  const [memberId, setMemberId] = useState(suggested.length === 1 ? suggested[0] : '')
  // Also turned on when the answer to the resend says the author could not be verified this time
  const [unverified, setUnverified] = useState(!request.author.verified)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How the last resend ended when it failed: said by the form if she closes the question now
  const [lastFailure, setLastFailure] = useState<LinkProfileFailure | null>(null)

  const canConfirm = !!memberId && (!unverified || confirmed) && !submitting

  async function handleConfirm() {
    if (!canConfirm) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/media/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(linkProfileResendBody(request.body, memberId, unverified, asked.author.handle, asked.author.platform)),
      })
      const data: unknown = await res.json().catch(() => null)
      if (noClearAnswer(res, data)) {
        // A proxy answered, not the server: it may have been stored
        setError(texts.linkProfileNetworkError)
        setLastFailure({ kind: 'network' })
        return
      }
      const outcome = readLinkProfileAnswer({ ok: res.ok, status: res.status, data, sentConfirmUnverified: unverified, texts, shownAuthor: asked.author })
      if (outcome.kind === 'done') {
        onDone(outcome.message, { media: outcome.media, created: outcome.created })
        return
      }
      // What closing the question now would say about the link
      setLastFailure(failureOf(outcome))
      if (outcome.kind === 'author_changed') {
        // Another author than the one she answered for: show it, say so, and start the
        // answer again (nothing chosen, nothing ticked). Nothing was stored.
        setAsked({ author: outcome.author, suggestions: outcome.suggestions })
        setMemberId('')
        setUnverified(!outcome.author.verified)
        setConfirmed(false)
        setError(fill(texts.linkProfileAuthorChanged, { author: outcome.author.handle, network: networkLabel(outcome.author.platform) }))
      } else if (outcome.kind === 'confirm_unverified') {
        setUnverified(true)
        setConfirmed(false)
      } else if (outcome.kind === 'needs_date' && onNeedsPostedAt) {
        onNeedsPostedAt(outcome.message)
      } else {
        // The server's own reason (another person's profile, outside the dates, an expired session…)
        setError(outcome.message)
      }
    } catch {
      // The request may have reached the server and been stored: the answer did not arrive
      setError(texts.linkProfileNetworkError)
      setLastFailure({ kind: 'network' })
    } finally {
      setSubmitting(false)
    }
  }

  // Not closable while the request is on its way: its answer must land somewhere visible
  const close = () => { if (!submitting) onClose(lastFailure) }

  return (
    <Modal open onClose={close}>
      <div role="dialog" aria-modal="true" aria-labelledby="link-profile-title">
        <ModalHeader onClose={close}>
          <span id="link-profile-title" className="inline-flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-purple-600" />
            {texts.linkProfileTitle}
          </span>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p className="text-sm text-gray-600">
            {fill(texts.linkProfileBody, { author: asked.author.handle, network: networkLabel(asked.author.platform) })}
          </p>

          <Select
            id="link-profile-member"
            label={texts.linkProfileSelectLabel}
            placeholder={texts.linkProfileSelectPlaceholder}
            options={options}
            value={memberId}
            // «Confirmo que es su perfil» is about the creator chosen at that moment: another creator, another tick
            onChange={e => { setMemberId(e.target.value); setConfirmed(false); setError(null) }}
            disabled={submitting}
            autoFocus
          />

          {unverified && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
              <p className="flex items-start gap-2 text-sm text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                {texts.linkProfileUnverified}
              </p>
              <label className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-gray-800">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={submitting}
                  onChange={e => setConfirmed(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
                {texts.linkProfileConfirmCheckbox}
              </label>
            </div>
          )}

          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            {t.common.cancel}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            {texts.linkProfileConfirm}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}

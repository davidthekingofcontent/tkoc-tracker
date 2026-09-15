'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Users, Loader2 } from 'lucide-react'
import { Modal, ModalHeader, ModalBody } from '@/components/ui/modal'
import { useI18n } from '@/i18n/context'

interface TeamMember {
  id: string
  name: string
  email: string
  role: string
  isOwner: boolean
  assignmentId: string | null
}

interface StaffUser {
  id: string
  name: string
  email: string
  role: string
}

interface TeamResponse {
  ownerId: string
  owner: { id: string; name: string } | null
  canManage: boolean
  members: TeamMember[]
  staff: StaffUser[]
}

interface CampaignTeamButtonProps {
  campaignId: string
  locale: string
}

/**
 * "Equipo": who has access to this campaign.
 *
 * Access = the creator (Campaign.userId) + rows in campaign_assignments. Being
 * on the team puts the campaign in the PM's list and subscribes them to its
 * notifications; nobody else receives them, whatever their role (David,
 * 2026-09-15). This is the one place where the creator or an admin grants it:
 * one switch per staff member, saved on the spot.
 */
export function CampaignTeamButton({ campaignId, locale }: CampaignTeamButtonProps) {
  const { t } = useI18n()
  const es = locale === 'es'
  const [isOpen, setIsOpen] = useState(false)
  const [data, setData] = useState<TeamResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  // Toggles still awaiting the server (synchronous mirror of `pending`)
  const inFlight = useRef(0)
  // Bumped whenever a toggle starts or settles: a GET that began before the
  // bump carries a snapshot older than the optimistic state, so it is dropped
  // and the last toggle to settle resyncs from the server instead.
  const mutationSeq = useRef(0)

  const fetchTeam = useCallback(async () => {
    const seq = mutationSeq.current
    setIsLoading(true)
    setLoadError(false)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/assignments`)
      if (res.ok) {
        const json = (await res.json()) as TeamResponse
        if (mutationSeq.current === seq) {
          setData({
            ownerId: json.ownerId,
            owner: json.owner ?? null,
            canManage: !!json.canManage,
            members: Array.isArray(json.members) ? json.members : [],
            staff: Array.isArray(json.staff) ? json.staff : [],
          })
        }
      } else {
        setLoadError(true)
      }
    } catch {
      setLoadError(true)
    }
    setIsLoading(false)
  }, [campaignId])

  // Fetched on mount for the count badge; refreshed each time the dialog opens
  useEffect(() => {
    void fetchTeam()
  }, [fetchTeam])

  useEffect(() => {
    if (isOpen) {
      setError(null)
      void fetchTeam()
    }
  }, [isOpen, fetchTeam])

  // Owner first, then every active staff member by name, then any member that
  // is no longer in the staff list (deactivated) so the row can still be removed.
  const rows = useMemo(() => {
    if (!data) return []
    const memberById = new Map(data.members.map(m => [m.id, m]))
    const owner = data.members.find(m => m.isOwner) ?? null
    const collator = new Intl.Collator(es ? 'es' : 'en', { sensitivity: 'base' })
    const staff = data.staff
      .filter(u => u.id !== data.ownerId)
      .sort((a, b) => collator.compare(a.name, b.name))
      .map(u => ({ ...u, isOwner: false, isMember: memberById.has(u.id) }))
    const staffIds = new Set(data.staff.map(u => u.id))
    const extras = data.members
      .filter(m => !m.isOwner && !staffIds.has(m.id))
      .map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, isOwner: false, isMember: true }))
    const list: Array<{ id: string; name: string; email: string; role: string; isOwner: boolean; isMember: boolean }> = []
    if (owner) list.push({ id: owner.id, name: owner.name, email: owner.email, role: owner.role, isOwner: true, isMember: true })
    return list.concat(staff, extras)
  }, [data, es])

  async function toggleAccess(user: { id: string; name: string; email: string; role: string }, next: boolean) {
    if (!data || !data.canManage || pending.has(user.id)) return
    // Only this user's row is restored on failure: other rows may have their
    // own toggles in flight, so a whole-object snapshot would clobber them.
    const restored: TeamMember = data.members.find(m => m.id === user.id) ?? { ...user, isOwner: false, assignmentId: null }
    setError(null)
    mutationSeq.current += 1
    inFlight.current += 1
    setPending(p => new Set(p).add(user.id))
    // Optimistic: the row moves at once, rolled back if the server says no
    setData(d => {
      if (!d) return d
      const others = d.members.filter(m => m.id !== user.id)
      return next
        ? { ...d, members: [...others, { ...user, isOwner: false, assignmentId: null }] }
        : { ...d, members: others }
    })
    try {
      const res = next
        ? await fetch(`/api/campaigns/${campaignId}/assignments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id }),
          })
        : await fetch(`/api/campaigns/${campaignId}/assignments?userId=${encodeURIComponent(user.id)}`, {
            method: 'DELETE',
          })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (next) {
        const json = (await res.json()) as { assignment?: { id: string } }
        const assignmentId = json.assignment?.id ?? null
        setData(d =>
          d ? { ...d, members: d.members.map(m => (m.id === user.id ? { ...m, assignmentId } : m)) } : d
        )
      }
    } catch {
      setData(d => {
        if (!d) return d
        const others = d.members.filter(m => m.id !== user.id)
        return next ? { ...d, members: others } : { ...d, members: [...others, restored] }
      })
      setError(t.campaignDetail.teamError)
    } finally {
      inFlight.current -= 1
      mutationSeq.current += 1
      setPending(p => {
        const n = new Set(p)
        n.delete(user.id)
        return n
      })
      // Once the last toggle has settled, take the server's word for the
      // final state (assignment ids, rows another admin changed meanwhile).
      if (inFlight.current === 0) void fetchTeam()
    }
  }

  const count = data?.members.length ?? null
  const canManage = data?.canManage ?? false

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        title={t.campaignDetail.teamTitle}
      >
        <Users className="h-4 w-4" />
        {t.campaignDetail.teamButton}
        {count !== null && (
          <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            {count}
          </span>
        )}
      </button>

      <Modal open={isOpen} onClose={() => setIsOpen(false)} className="max-w-md dark:border-gray-700 dark:bg-gray-900">
        <ModalHeader onClose={() => setIsOpen(false)} className="dark:border-gray-700">
          <span className="inline-flex items-center gap-2 dark:text-gray-100">
            <Users className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            {t.campaignDetail.teamTitle}
          </span>
        </ModalHeader>
        <ModalBody>
          <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t.campaignDetail.teamHint}</p>

          {isLoading && rows.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : loadError && rows.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{t.campaignDetail.teamError}</p>
              <button
                type="button"
                onClick={() => void fetchTeam()}
                className="mt-2 text-xs font-medium text-purple-600 hover:underline dark:text-purple-400"
              >
                {es ? 'Reintentar' : 'Retry'}
              </button>
            </div>
          ) : (
            <ul className="mt-3 max-h-[60vh] divide-y divide-gray-100 overflow-y-auto dark:divide-gray-800" aria-busy={isLoading}>
              {rows.map(user => {
                const checked = user.isMember
                const disabled = user.isOwner || !canManage || pending.has(user.id)
                return (
                  <li key={user.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {user.name}
                        </span>
                        {user.isOwner && (
                          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                            {t.campaignDetail.teamOwner}
                          </span>
                        )}
                        {user.role === 'ADMIN' && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                            Admin
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="hidden text-xs text-gray-500 sm:inline dark:text-gray-400">{t.campaignDetail.teamHasAccess}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={checked}
                        aria-label={`${t.campaignDetail.teamHasAccess}: ${user.name}`}
                        disabled={disabled}
                        onClick={() => void toggleAccess(user, !checked)}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                          checked ? 'bg-purple-600' : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
                        />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
          {data && !canManage && (
            <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">{t.campaignDetail.teamReadOnly}</p>
          )}
        </ModalBody>
      </Modal>
    </>
  )
}

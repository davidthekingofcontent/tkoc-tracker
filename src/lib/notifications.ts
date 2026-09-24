import { prisma } from '@/lib/db'

export type NotificationType =
  | 'campaign_created'
  | 'campaign_completed'
  | 'campaign_access'
  | 'influencer_added'
  | 'influencer_status_changed'
  | 'media_posted'
  | 'post_deleted'
  | 'note_added'
  | 'invitation_sent'
  | 'team_joined'
  | 'apify_budget'
  | 'cron_stale'

export interface CreateNotificationParams {
  userId: string
  type: NotificationType
  title: string
  message: string
  link?: string
}

export async function createNotification(params: CreateNotificationParams) {
  try {
    return await prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        title: params.title,
        message: params.message,
        link: params.link || null,
      },
    })
  } catch (error) {
    console.error('Failed to create notification:', error)
    return null
  }
}

/**
 * The TEAM of one or more campaigns: each campaign's creator (Campaign.userId)
 * plus every user in campaign_assignments for it, restricted to ACTIVE staff
 * (role ADMIN or EMPLOYEE) and deduped. Clients (BRAND), creators, inactive
 * accounts and staff who are not on the team are never included — an ADMIN
 * sees every campaign, but only receives the events of the campaigns they
 * created or were given access to (David, 2026-09-15).
 *
 * Never throws: returns [] on error.
 */
export async function campaignTeamUserIds(campaignIds: string | string[]): Promise<string[]> {
  try {
    const ids = Array.from(new Set((Array.isArray(campaignIds) ? campaignIds : [campaignIds]).filter(Boolean)))
    if (ids.length === 0) return []

    const [campaigns, assignments] = await Promise.all([
      prisma.campaign.findMany({ where: { id: { in: ids } }, select: { userId: true } }),
      prisma.campaignAssignment.findMany({ where: { campaignId: { in: ids } }, select: { userId: true } }),
    ])
    const candidates = Array.from(new Set([
      ...campaigns.map(c => c.userId),
      ...assignments.map(a => a.userId),
    ]))
    if (candidates.length === 0) return []

    const users = await prisma.user.findMany({
      where: {
        id: { in: candidates },
        isActive: true,
        role: { in: ['ADMIN', 'EMPLOYEE'] },
      },
      select: { id: true },
    })
    return users.map(u => u.id)
  } catch (error) {
    console.error('Failed to resolve campaign team:', error)
    return []
  }
}

/**
 * Notify the team of one or more campaigns (see campaignTeamUserIds) about an
 * event, minus the actor (`excludeUserId`). One row per team member, written
 * in a single createMany. Returns the number of notifications created; never
 * throws (0 on error).
 */
export async function notifyCampaignTeam(
  campaignIds: string | string[],
  params: Omit<CreateNotificationParams, 'userId'>,
  excludeUserId?: string
): Promise<number> {
  try {
    const team = (await campaignTeamUserIds(campaignIds)).filter(id => id !== excludeUserId)
    if (team.length === 0) return 0

    const result = await prisma.notification.createMany({
      data: team.map(userId => ({
        userId,
        type: params.type,
        title: params.title,
        message: params.message,
        link: params.link || null,
      })),
    })
    return result.count
  } catch (error) {
    console.error('Failed to notify campaign team:', error)
    return 0
  }
}

/**
 * System alert to every ACTIVE ADMIN (one row each, single createMany).
 * Returns the number of notifications created; never throws (0 on error).
 */
export async function notifyAdmins(params: Omit<CreateNotificationParams, 'userId'>): Promise<number> {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: { id: true },
    })
    if (admins.length === 0) return 0

    const result = await prisma.notification.createMany({
      data: admins.map(admin => ({
        userId: admin.id,
        type: params.type,
        title: params.title,
        message: params.message,
        link: params.link || null,
      })),
    })
    return result.count
  } catch (error) {
    console.error('Failed to notify admins:', error)
    return 0
  }
}

// ============ APIFY BUDGET PAUSE ALERTS ============

export type ApifyBudgetGate = 'stories' | 'track' | 'discover'

const APIFY_BUDGET_GATE_COPY: Record<ApifyBudgetGate, { title: string; subject: string; meanwhile: string }> = {
  stories: {
    title: 'Rastreo de stories pausado por presupuesto de Apify',
    subject: 'El rastreo automático de stories',
    meanwhile: 'Mientras, registra las stories a mano en Ejecutar → Stories.',
  },
  track: {
    title: 'Captura de publicaciones pausada por presupuesto de Apify',
    subject: 'La captura automática de publicaciones',
    meanwhile: 'Mientras, añade las publicaciones a mano en Ejecutar → Media → Añadir publicación por URL.',
  },
  discover: {
    title: 'Búsqueda externa de creadores pausada por presupuesto de Apify',
    subject: 'La búsqueda externa de creadores',
    meanwhile: 'Mientras, la búsqueda en nuestra base de datos sigue funcionando.',
  },
}

/** dd/mm (Europe/Madrid) of the day the Apify cycle resets: the instant right after it ends. */
function formatApifyCycleResetDay(cycleEndsAt: string | null): string | null {
  if (!cycleEndsAt) return null
  const t = Date.parse(cycleEndsAt)
  if (Number.isNaN(t)) return null
  // formatToParts + padStart: some ICU builds ignore '2-digit' for es-ES ("25/9")
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit' }).formatToParts(new Date(t + 1))
  const day = parts.find(p => p.type === 'day')?.value
  const month = parts.find(p => p.type === 'month')?.value
  return day && month ? `${day.padStart(2, '0')}/${month.padStart(2, '0')}` : null
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

/**
 * Claim today's alert for a gate ATOMICALLY (Setting 'apify_budget_alert_{gate}'
 * = YYYY-MM-DD of the last alert). Exactly one of N concurrent callers wins:
 * either the single-row UPDATE whose WHERE re-checks `value != today` under the
 * row lock (Postgres re-evaluates it on the committed row, so the loser matches
 * 0 rows), or the INSERT that the unique key on Setting.key lets only one caller
 * complete. A read-then-upsert was not a claim: two callers 100 ms apart both
 * passed the check and every ADMIN got the alert twice. Throws on DB errors.
 */
async function claimApifyBudgetAlertDay(key: string, today: string): Promise<boolean> {
  const updated = await prisma.setting.updateMany({ where: { key, value: { not: today } }, data: { value: today } })
  if (updated.count > 0) return true
  try {
    await prisma.setting.create({ data: { key, value: today } })
    return true
  } catch (err) {
    if (isUniqueViolation(err)) return false // the row exists → already stamped today by someone else
    throw err
  }
}

/**
 * ADMIN alert at most ONCE per UTC day for an arbitrary alert key (Setting
 * `<alertKey>` = YYYY-MM-DD of the last alert), with the same atomic claim /
 * release semantics as the Apify budget alert. Returns true when a
 * notification was sent; never throws.
 */
export async function notifyAdminsOncePerDay(
  alertKey: string,
  params: Omit<CreateNotificationParams, 'userId'>
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10) // UTC day
  let claimed = false
  try {
    claimed = await claimApifyBudgetAlertDay(alertKey, today)
    if (!claimed) return false
    const sent = await notifyAdmins(params)
    if (sent > 0) return true
    await prisma.setting.deleteMany({ where: { key: alertKey, value: today } })
    return false
  } catch (error) {
    console.error(`Failed to send daily admin alert ${alertKey}:`, error)
    if (claimed) await prisma.setting.deleteMany({ where: { key: alertKey, value: today } }).catch(() => {})
    return false
  }
}

/**
 * ADMIN alert when an Apify budget gate pauses a path — at most ONCE per UTC
 * day per gate. The day is claimed atomically BEFORE sending (see
 * claimApifyBudgetAlertDay) so concurrent callers never double-post, and the
 * claim is RELEASED when nothing was sent (transient DB error, no active
 * ADMIN) so the next cron tick retries instead of the pause staying invisible
 * for a whole day. Spanish, percentage only — never an amount (PMs and clients
 * never see Apify prices). Returns true when a notification was sent; never
 * throws (false on error).
 *
 * Born 2026-09-24: the 40 $ soft limit had silently paused the stories and
 * track crons for two weeks and nobody was told.
 */
export async function notifyApifyBudgetPauseOnce(
  gate: ApifyBudgetGate,
  budget: { usedPct: number | null; cycleEndsAt: string | null }
): Promise<boolean> {
  const key = `apify_budget_alert_${gate}`
  const today = new Date().toISOString().slice(0, 10) // UTC day
  let claimed = false
  try {
    claimed = await claimApifyBudgetAlertDay(key, today)
    if (!claimed) return false

    const copy = APIFY_BUDGET_GATE_COPY[gate]
    const used = budget.usedPct !== null ? `el ${budget.usedPct} %` : 'casi todo'
    const resetDay = formatApifyCycleResetDay(budget.cycleEndsAt)
    const resumes = resetDay ? `el ${resetDay} (nuevo ciclo)` : 'al empezar el próximo ciclo'
    const sent = await notifyAdmins({
      type: 'apify_budget',
      title: copy.title,
      message: `Apify ha usado ${used} del plan mensual. ${copy.subject} se reanuda ${resumes} o antes si se amplía el plan en Apify → Billing. ${copy.meanwhile}`,
      link: '/settings',
    })
    if (sent > 0) return true
    // Nothing reached an ADMIN (notifyAdmins swallows errors → 0): release the
    // day so the next tick retries. Only OUR claim can carry today's value here
    // — nobody else can claim while the row says today — so this never deletes
    // a stamp behind a notification that was actually sent.
    await prisma.setting.deleteMany({ where: { key, value: today } })
    return false
  } catch (error) {
    console.error('Failed to send Apify budget alert:', error)
    if (claimed) {
      // Same release as above (the failure happened after the claim)
      await prisma.setting.deleteMany({ where: { key, value: today } }).catch(() => {})
    }
    return false
  }
}

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

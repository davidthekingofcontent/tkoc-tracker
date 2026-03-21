import { prisma } from '@/lib/db'

type NotificationType =
  | 'campaign_created'
  | 'campaign_completed'
  | 'influencer_added'
  | 'influencer_status_changed'
  | 'media_posted'
  | 'post_deleted'
  | 'note_added'
  | 'invitation_sent'
  | 'team_joined'

interface CreateNotificationParams {
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

export async function notifyAllTeam(
  params: Omit<CreateNotificationParams, 'userId'>,
  excludeUserId?: string
) {
  try {
    const users = await prisma.user.findMany({
      select: { id: true },
      where: excludeUserId ? { id: { not: excludeUserId } } : undefined,
    })

    await prisma.notification.createMany({
      data: users.map(u => ({
        userId: u.id,
        type: params.type,
        title: params.title,
        message: params.message,
        link: params.link || null,
      })),
    })
  } catch (error) {
    console.error('Failed to notify team:', error)
  }
}

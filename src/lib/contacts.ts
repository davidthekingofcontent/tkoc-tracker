import { prisma } from '@/lib/db'

/**
 * Guarantees that a Contact row exists for (influencerId, userId).
 *
 * Every influencer whose data enters the platform must show up in the
 * Contacts page of the user who brought it in, so this is called after
 * every Influencer upsert (analyze, discovery, lists, campaign members).
 *
 * - Creates the Contact with status 'new' when it is missing.
 * - Leaves an existing Contact untouched (status, notes, tags preserved).
 * - Never throws: failures are logged and swallowed so the calling flow
 *   (scrape, list add, campaign add) is never broken by a contact hiccup.
 */
export async function ensureContact(influencerId: string, userId: string): Promise<void> {
  if (!influencerId || !userId) return
  try {
    await prisma.contact.upsert({
      where: { influencerId_userId: { influencerId, userId } },
      create: { influencerId, userId, status: 'new' },
      update: {},
    })
  } catch (error) {
    console.error(
      `[contacts] ensureContact failed for influencer=${influencerId} user=${userId}:`,
      error instanceof Error ? error.message : error
    )
  }
}

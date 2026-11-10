import { prisma } from '@/lib/db'
import { campaignHasTargets } from '@/lib/campaign-capture'
import { splitMemberAccounts } from '@/lib/campaign-targets'
import { notifyCampaignTeam } from '@/lib/notifications'

/**
 * A creator of the campaign can never be one of its "Cuentas de Marca
 * Objetivo". Nov 2026: a PM typed the 28 creators of "Dorco - Delyplus" into
 * that field (the product's real hashtag was being refused); every creator's
 * own @mention then counted as a brand reference, unrelated reels and stories
 * were captured and each handle paid a mention scrape per day.
 *
 * Called right after memberships are created (single add, bulk add,
 * move/copy) and BEFORE any capture is triggered, with the usernames of the
 * creators JUST added: those handles are removed from targetAccounts and the
 * campaign team is told — never a silent change. Members that were already
 * there are not re-judged here (PUT /api/campaigns/[id] refuses creators among
 * the brand accounts on every save), and an account that carries the attached
 * brand's name is never taken for a creator. Returns the removed handles;
 * never throws.
 */
export async function stripMemberHandlesFromTargets(campaignId: string, addedUsernames: string[]): Promise<string[]> {
  if (!addedUsernames || addedUsernames.length === 0) return []
  try {
    const brandName = await campaignBrandName(campaignId)
    for (let attempt = 0; attempt < 3; attempt++) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          name: true,
          targetAccounts: true,
          targetHashtags: true,
          targetKeywords: true,
        },
      })
      if (!campaign || campaign.targetAccounts.length === 0) return []
      const { brand, members } = splitMemberAccounts(campaign.targetAccounts, addedUsernames, brandName, campaign.name)
      if (members.length === 0) return []

      // Optimistic write: two creators added at once must not overwrite each
      // other's cleanup (read-modify-write of one array column).
      const written = await prisma.campaign.updateMany({
        where: { id: campaignId, targetAccounts: { equals: campaign.targetAccounts } },
        data: { targetAccounts: brand },
      })
      if (written.count === 0) continue

      const shown = members.slice(0, 10).map(m => `@${m}`).join(', ')
      const more = members.length > 10 ? ` y ${members.length - 10} más` : ''
      const leftWithout = !campaignHasTargets({ ...campaign, targetAccounts: brand })
      await notifyCampaignTeam(campaignId, {
        type: 'cron_stale',
        title: 'Cuentas de marca corregidas',
        message:
          `En "${campaign.name}" se han quitado de "Cuentas de Marca Objetivo" ${shown}${more}: son creadores de la campaña y ese campo es para la cuenta de la marca.` +
          (leftWithout
            ? ' La campaña se ha quedado sin objetivos y no capturará nada: añade la cuenta de la marca, sus hashtags o las palabras clave del producto en "Editar campaña".'
            : ''),
        link: `/campaigns/${campaignId}`,
      })
      console.log(`[TargetGuard] Campaign "${campaign.name}": removed ${members.length} creator handle(s) from targetAccounts`)
      return members
    }
    return []
  } catch (err) {
    console.error('[TargetGuard] stripMemberHandlesFromTargets failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Name of the brand attached to the campaign (Setting campaign_brand_<id> → Setting <brandId> JSON { name }), or null. */
async function campaignBrandName(campaignId: string): Promise<string | null> {
  try {
    const mapping = await prisma.setting.findUnique({ where: { key: `campaign_brand_${campaignId}` } })
    if (!mapping?.value) return null
    const brand = await prisma.setting.findUnique({ where: { key: mapping.value } })
    if (!brand?.value) return null
    const data = JSON.parse(brand.value) as { name?: unknown }
    return typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : null
  } catch {
    return null
  }
}

import { prisma } from '@/lib/db'
import type { Platform } from '@/generated/prisma/client'
import { memberCost } from '@/lib/metrics'
import { normalizeHandle } from '@/lib/person-profiles'

/**
 * CAMPAIGN ROSTER — who is credited for a publication (Nov 2026).
 *
 * A creator is a person with several profiles, but in a campaign she is still
 * ONE CampaignInfluencer row. Content she publishes from any of her profiles
 * is stored with Media.influencerId = that member row's profile (the credited
 * member) and Media.publishedByInfluencerId = the profile that published.
 *
 * This is the only place that decides which member a publication is credited
 * to. Rules, in this order:
 *
 *   1. A profile that is ITSELF a member of the campaign is credited to itself.
 *      Two accounts of one person that are both members (legacy double
 *      memberships, the TikTok twins) each keep their own content: nothing moves.
 *   2. Otherwise, a profile whose person is the person of a member is credited
 *      to that member. If several members share that person: the one on the
 *      publication's network, else the one with a fee, else the oldest
 *      membership.
 *   3. Otherwise nobody: the publication is not of this campaign's creators.
 *
 * Handles are compared by exact equality once normalised (lowercase, no @):
 * 'maria_garcia' is never 'maria.garcia', and the same handle on another
 * network is NOT the same creator unless the two profiles are linked.
 *
 * buildRoster is pure (no database); loadCampaignRoster reads what it needs.
 */

export interface RosterMember {
  influencerId: string
  username: string
  platform: Platform
  personId: string | null
  followers: number
  bio?: string | null
  website?: string | null
  /** When she was added to the campaign (the membership's createdAt) */
  createdAt: Date
  hasFee: boolean
}

export interface RosterProfile {
  influencerId: string
  username: string
  platform: Platform
  personId: string | null
  followers: number
}

export interface Credit {
  /** The CampaignInfluencer row that is credited */
  member: RosterMember
  /** The profile that published */
  publisher: RosterProfile
  /** publisher is the member's own profile */
  self: boolean
}

export interface Roster {
  members: RosterMember[]
  creditFor(platform: Platform, handle: string): Credit | null
  creditForInfluencer(influencerId: string): Credit | null
}

function profileOf(member: RosterMember): RosterProfile {
  return {
    influencerId: member.influencerId,
    username: member.username,
    platform: member.platform,
    personId: member.personId,
    followers: member.followers,
  }
}

function time(d: Date): number {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER
}

/** Fee first, then the oldest membership, then the id: a total, stable order. */
function byFeeThenOldest(a: RosterMember, b: RosterMember): number {
  return (
    Number(b.hasFee) - Number(a.hasFee) ||
    time(a.createdAt) - time(b.createdAt) ||
    a.influencerId.localeCompare(b.influencerId)
  )
}

export function buildRoster(members: RosterMember[], profiles: RosterProfile[]): Roster {
  const memberById = new Map<string, RosterMember>()
  for (const m of members) if (!memberById.has(m.influencerId)) memberById.set(m.influencerId, m)
  const roster = Array.from(memberById.values())

  // Rule 2 index: the members of each person
  const membersByPerson = new Map<string, RosterMember[]>()
  for (const m of roster) {
    if (!m.personId) continue
    const list = membersByPerson.get(m.personId)
    if (list) list.push(m)
    else membersByPerson.set(m.personId, [m])
  }

  // Linked profiles that are not members themselves (a member is always rule 1)
  const linkedById = new Map<string, RosterProfile>()
  for (const p of profiles) {
    if (!p.personId || memberById.has(p.influencerId) || linkedById.has(p.influencerId)) continue
    if (!membersByPerson.has(p.personId)) continue
    linkedById.set(p.influencerId, p)
  }
  const linked = Array.from(linkedById.values()).sort((a, b) => a.influencerId.localeCompare(b.influencerId))

  const selfCredit = (member: RosterMember): Credit => ({ member, publisher: profileOf(member), self: true })

  /** Rule 2 for a profile that is not a member, published on `network`. */
  const creditLinked = (profile: RosterProfile, network: Platform): Credit | null => {
    const candidates = profile.personId ? membersByPerson.get(profile.personId) : undefined
    if (!candidates || candidates.length === 0) return null
    const sameNetwork = candidates.filter(m => m.platform === network)
    const member = [...(sameNetwork.length > 0 ? sameNetwork : candidates)].sort(byFeeThenOldest)[0]
    return { member, publisher: profile, self: false }
  }

  return {
    members: roster,

    creditFor(platform: Platform, handle: string): Credit | null {
      const wanted = normalizeHandle(handle)
      if (!wanted) return null
      // Rule 1 (rows that differ only in casing: the same deterministic order)
      const own = roster
        .filter(m => m.platform === platform && normalizeHandle(m.username) === wanted)
        .sort(byFeeThenOldest)[0]
      if (own) return selfCredit(own)
      // Rule 2
      for (const profile of linked) {
        if (profile.platform !== platform || normalizeHandle(profile.username) !== wanted) continue
        const credit = creditLinked(profile, platform)
        if (credit) return credit
      }
      // Rule 3
      return null
    },

    creditForInfluencer(influencerId: string): Credit | null {
      const own = memberById.get(influencerId)
      if (own) return selfCredit(own)
      const profile = linkedById.get(influencerId)
      return profile ? creditLinked(profile, profile.platform) : null
    },
  }
}

/** The campaign's members plus the other profiles of their persons. */
export async function loadCampaignRoster(campaignId: string): Promise<Roster> {
  const memberships = await prisma.campaignInfluencer.findMany({
    where: { campaignId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      createdAt: true,
      agreedFee: true,
      cost: true,
      influencer: {
        select: { id: true, username: true, platform: true, personId: true, followers: true, bio: true, website: true },
      },
    },
  })

  const members: RosterMember[] = memberships.map(ci => ({
    influencerId: ci.influencer.id,
    username: ci.influencer.username,
    platform: ci.influencer.platform,
    personId: ci.influencer.personId,
    followers: ci.influencer.followers,
    bio: ci.influencer.bio,
    website: ci.influencer.website,
    createdAt: ci.createdAt,
    hasFee: memberCost(ci) > 0,
  }))

  const personIds = Array.from(new Set(members.map(m => m.personId).filter((id): id is string => !!id)))
  const others = personIds.length === 0
    ? []
    : await prisma.influencer.findMany({
        where: { personId: { in: personIds }, id: { notIn: members.map(m => m.influencerId) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, username: true, platform: true, personId: true, followers: true },
      })

  const profiles: RosterProfile[] = others.map(p => ({
    influencerId: p.id,
    username: p.username,
    platform: p.platform,
    personId: p.personId,
    followers: p.followers,
  }))

  return buildRoster(members, profiles)
}

import { prisma } from '@/lib/db'
import type { Platform } from '@/generated/prisma/client'

/**
 * A CREATOR IS A PERSON WITH SEVERAL PROFILES (Nov 2026).
 *
 * Every Influencer row is a PROFILE (one account on one network). Profiles of
 * the same human share a Person through Influencer.personId. The column is
 * nullable and nothing is backfilled: a profile with no person is its own
 * implicit person, and a Person row is only created the first time a second
 * profile is linked.
 *
 * This module is the only place that writes personId. It never creates,
 * removes or moves a campaign membership and never touches Media: who is
 * credited for a publication is decided by src/lib/campaign-roster.ts. Every
 * change is one transaction and leaves a PersonLog row with the state before
 * and after, so it can be undone.
 */

/** Who did it. null = the system (a cron). */
export type Actor = { id: string; name: string } | null

export type LinkEvidence = 'scraped_owner' | 'pm_confirmed' | 'pm_confirmed_unverified' | 'autolink_video' | 'pm_manual'

/** Canonical form of a handle for comparisons: trimmed, no leading @, lowercase. Nothing else is removed. */
export function normalizeHandle(s: string): string {
  return String(s ?? '').trim().replace(/^@+/, '').trim().toLowerCase()
}

/** Identity key of the person behind a profile: her Person, else the profile itself. */
export function personKeyOf(i: { id: string; personId?: string | null }): string {
  return i.personId ?? `inf:${i.id}`
}

export class PersonLinkError extends Error {
  code: 'same_profile' | 'profile_has_other_person' | 'not_found'
  /** With 'profile_has_other_person': the person the profile already belongs to. */
  personId: string | null

  constructor(code: PersonLinkError['code'], message: string, personId: string | null = null) {
    super(message)
    this.name = 'PersonLinkError'
    this.code = code
    this.personId = personId
  }
}

interface ProfileRow {
  id: string
  username: string
  platform: Platform
  personId: string | null
  followers: number
}

const PROFILE_SELECT = { id: true, username: true, platform: true, personId: true, followers: true } as const
const SNAPSHOT_SELECT = { id: true, username: true, platform: true, personId: true, displayName: true } as const

const NETWORK_LABEL: Record<string, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' }

function describeProfile(p: { username: string; platform: string }): string {
  return `@${p.username} (${NETWORK_LABEL[p.platform] ?? p.platform})`
}

function snapshot(p: { id: string; username: string; platform: Platform; personId: string | null }) {
  return { id: p.id, username: p.username, platform: p.platform, personId: p.personId }
}

/**
 * Prisma's `mode: 'insensitive'` compiles to ILIKE, where `_` and `%` are
 * wildcards and `\` escapes them: 'maria_garcia' would also find
 * 'maria.garcia'. The value is escaped here and the rows are compared again in
 * code. (Same rule as escapeForInsensitiveEquals in src/lib/auth.ts; kept
 * local so this module does not pull the session code, which tests mock.)
 */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

/**
 * The profile to use when several rows differ only in casing (the unique key
 * is case-sensitive, so 'Ale_Ficticia' and 'ale_ficticia' can both exist): the one
 * written exactly as given, else one that already belongs to a person, else
 * the oldest. Deterministic.
 */
function pickExact(rows: Array<ProfileRow & { createdAt: Date }>, given: string): ProfileRow | null {
  if (rows.length === 0) return null
  const sorted = [...rows].sort((a, b) =>
    Number(b.username === given) - Number(a.username === given) ||
    Number(b.personId !== null) - Number(a.personId !== null) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  )
  const { id, username, platform, personId, followers } = sorted[0]
  return { id, username, platform, personId, followers }
}

/**
 * The member of `campaignId` that is ANOTHER profile of the same person as
 * `influencerId`, if any. A person is one creator: her second profile must
 * never become a second member of a campaign (it would count her twice); its
 * pieces are credited to the member she already has there.
 */
export async function memberOfSamePerson(
  campaignId: string,
  influencerId: string
): Promise<{ influencerId: string; username: string; platform: Platform } | null> {
  const profile = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { personId: true } })
  if (!profile?.personId) return null
  const member = await prisma.campaignInfluencer.findFirst({
    where: { campaignId, influencerId: { not: influencerId }, influencer: { personId: profile.personId } },
    select: { influencer: { select: { id: true, username: true, platform: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return member ? { influencerId: member.influencer.id, username: member.influencer.username, platform: member.influencer.platform } : null
}

/** Exact (case-insensitive, never pattern) lookup of one profile. */
export async function findInfluencerExact(
  platform: Platform,
  handle: string
): Promise<{ id: string; username: string; platform: Platform; personId: string | null; followers: number } | null> {
  const wanted = normalizeHandle(handle)
  if (!wanted) return null
  const lookalikes = await prisma.influencer.findMany({
    where: { platform, username: { equals: escapeIlike(wanted), mode: 'insensitive' } },
    select: { ...PROFILE_SELECT, createdAt: true },
  })
  const exact = lookalikes.filter(row => normalizeHandle(row.username) === wanted)
  return pickExact(exact, String(handle ?? '').trim().replace(/^@+/, '').trim())
}

/** Find it, or create a bare profile row (username as given, stamped with addedBy). Never scrapes. */
export async function findOrCreateInfluencerExact(
  platform: Platform,
  handle: string,
  actor: Actor
): Promise<{ id: string; username: string; platform: Platform; personId: string | null; followers: number; created: boolean }> {
  const username = String(handle ?? '').trim().replace(/^@+/, '').trim()
  if (!normalizeHandle(username)) throw new Error('findOrCreateInfluencerExact: empty handle')

  const found = await findInfluencerExact(platform, username)
  if (found) return { ...found, created: false }

  try {
    const created = await prisma.influencer.create({
      data: {
        username,
        platform,
        addedById: actor?.id ?? null,
        addedByName: actor?.name ?? null,
      },
      select: PROFILE_SELECT,
    })
    return { ...created, created: true }
  } catch (err) {
    // A concurrent request created the same profile between the lookup and the create
    if (!isUniqueViolation(err)) throw err
    const again = await findInfluencerExact(platform, username)
    if (!again) throw err
    return { ...again, created: false }
  }
}

/**
 * How to name the person a profile already belongs to, as "@user (Network)":
 * her profile that is in most campaigns, else her oldest one (never the
 * profile being asked about). null when she has no other profile.
 */
export async function describeMainProfileOfPerson(personId: string, exceptInfluencerId: string | null): Promise<string | null> {
  const profiles = await prisma.influencer.findMany({
    where: { personId, ...(exceptInfluencerId ? { id: { not: exceptInfluencerId } } : {}) },
    select: { id: true, username: true, platform: true, createdAt: true, _count: { select: { campaigns: true } } },
  })
  if (profiles.length === 0) return null
  profiles.sort((a, b) =>
    b._count.campaigns - a._count.campaigns ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  )
  return describeProfile(profiles[0])
}

/**
 * Declare that `profileInfluencerId` is another profile of the person behind
 * `memberInfluencerId`. One transaction: creates the Person when neither has
 * one, sets personId on both, writes a PersonLog row (before/after). Idempotent
 * when they already share a person. Refuses (PersonLinkError) when the profile
 * already belongs to a DIFFERENT person. Never touches memberships or media.
 */
export async function linkProfile(args: {
  memberInfluencerId: string
  profileInfluencerId: string
  actor: Actor
  evidence: LinkEvidence
  summary?: string
}): Promise<{ personId: string; alreadyLinked: boolean; logId: string | null }> {
  const { memberInfluencerId, profileInfluencerId, actor, evidence } = args
  if (!memberInfluencerId || !profileInfluencerId) {
    throw new PersonLinkError('not_found', 'Falta el perfil o la creadora que se quiere vincular.')
  }
  if (memberInfluencerId === profileInfluencerId) {
    throw new PersonLinkError('same_profile', 'Un perfil no se puede vincular consigo mismo.')
  }

  return prisma.$transaction(async tx => {
    // Both rows are locked, always in the same order, so two simultaneous links
    // of the same creator cannot each create a different Person for her.
    const ids = [memberInfluencerId, profileInfluencerId].sort()
    await tx.$queryRaw`SELECT id FROM influencers WHERE id IN (${ids[0]}, ${ids[1]}) ORDER BY id FOR UPDATE`

    const rows = await tx.influencer.findMany({ where: { id: { in: ids } }, select: SNAPSHOT_SELECT })
    const member = rows.find(r => r.id === memberInfluencerId)
    const profile = rows.find(r => r.id === profileInfluencerId)
    if (!member || !profile) {
      throw new PersonLinkError('not_found', 'No encuentro el perfil o la creadora que se quiere vincular.')
    }

    if (profile.personId && profile.personId === member.personId) {
      return { personId: profile.personId, alreadyLinked: true, logId: null }
    }
    if (profile.personId) {
      throw new PersonLinkError(
        'profile_has_other_person',
        `${describeProfile(profile)} ya es perfil de otra persona.`,
        profile.personId
      )
    }

    let personId = member.personId
    const personCreated = !personId
    if (!personId) {
      const person = await tx.person.create({
        data: {
          displayName: member.displayName?.trim() || member.username,
          createdById: actor?.id ?? null,
          createdByName: actor?.name ?? null,
        },
        select: { id: true },
      })
      personId = person.id
      await tx.influencer.update({ where: { id: member.id }, data: { personId } })
    }
    await tx.influencer.update({ where: { id: profile.id }, data: { personId } })

    const log = await tx.personLog.create({
      data: {
        action: 'link_profile',
        personId,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
        evidence,
        summary: args.summary?.trim() || `${describeProfile(profile)} añadido como perfil de ${describeProfile(member)}`,
        before: { member: snapshot(member), profile: snapshot(profile) },
        after: {
          member: { ...snapshot(member), personId },
          profile: { ...snapshot(profile), personId },
          personCreated,
        },
      },
      select: { id: true },
    })

    return { personId, alreadyLinked: false, logId: log.id }
  })
}

/** Undo of a link: clears the profile's personId (and the person's, if it is left with a single profile), logged. */
export async function unlinkProfile(args: {
  profileInfluencerId: string
  actor: Actor
  reason?: string
}): Promise<{ logId: string }> {
  const { profileInfluencerId, actor } = args
  const reason = args.reason?.trim() || null

  return prisma.$transaction(async tx => {
    const current = await tx.influencer.findUnique({ where: { id: profileInfluencerId }, select: { personId: true } })
    if (!current) throw new PersonLinkError('not_found', 'No encuentro ese perfil.')
    if (!current.personId) throw new PersonLinkError('not_found', 'Ese perfil no está vinculado a ninguna persona.')
    const personId = current.personId

    // Lock every profile of the person, then read them again under the lock
    await tx.$queryRaw`SELECT id FROM influencers WHERE "personId" = ${personId} ORDER BY id FOR UPDATE`
    const profiles = await tx.influencer.findMany({
      where: { personId },
      select: SNAPSHOT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const profile = profiles.find(p => p.id === profileInfluencerId)
    if (!profile) throw new PersonLinkError('not_found', 'Ese perfil no está vinculado a ninguna persona.')
    const others = profiles.filter(p => p.id !== profileInfluencerId)
    const person = await tx.person.findUnique({ where: { id: personId }, select: { id: true, displayName: true } })

    // A person of one profile is the implicit person again: the last profile
    // left is released too. The Person row is kept (nothing is ever deleted).
    const released = others.length === 1 ? [profile, others[0]] : [profile]
    await tx.influencer.updateMany({ where: { id: { in: released.map(p => p.id) } }, data: { personId: null } })

    // Publications this profile published that are credited to another profile
    // stay exactly where they are: unlinking never moves or detaches content.
    const creditedMedia = await tx.media.count({ where: { publishedByInfluencerId: profileInfluencerId } })

    // The link this undoes: the latest live one that added this profile. When
    // the person is left with no profile at all, every live link of hers is void.
    const dissolved = released.length === profiles.length
    const links = await tx.personLog.findMany({
      where: { personId, action: 'link_profile', undoneAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, after: true },
    })
    const undone =
      links.find(l => (l.after as { profile?: { id?: string } } | null)?.profile?.id === profileInfluencerId) ??
      (dissolved ? links[0] : undefined) ??
      null
    const voided = dissolved ? links.map(l => l.id) : undone ? [undone.id] : []

    const rest = others.map(describeProfile).join(', ')
    const log = await tx.personLog.create({
      data: {
        action: 'unlink_profile',
        personId,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
        evidence: null,
        summary: `${describeProfile(profile)} deja de ser perfil de ${rest || 'esa persona'}${reason ? `. Motivo: ${reason}` : ''}`,
        before: {
          profile: snapshot(profile),
          person: { id: personId, displayName: person?.displayName ?? null, profiles: profiles.map(snapshot) },
        },
        after: {
          profile: { ...snapshot(profile), personId: null },
          releasedProfileIds: released.map(p => p.id),
          personLeftWithoutProfiles: dissolved,
          creditedMediaKept: creditedMedia,
          reason,
        },
        undoOfId: undone?.id ?? null,
      },
      select: { id: true },
    })
    if (voided.length > 0) {
      await tx.personLog.updateMany({ where: { id: { in: voided } }, data: { undoneAt: new Date(), undoneById: actor?.id ?? null } })
    }

    return { logId: log.id }
  })
}

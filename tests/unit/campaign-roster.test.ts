import { describe, expect, it } from 'vitest'
import { buildRoster, type RosterMember, type RosterProfile } from '@/lib/campaign-roster'
import { normalizeHandle, personKeyOf } from '@/lib/person-profiles'

/**
 * Who is credited for a publication. Pure: no database, no network.
 * The names are the real shapes of «10.- Vileda - Micros Octubre».
 */

let seq = 0
function member(over: Partial<RosterMember> & Pick<RosterMember, 'influencerId' | 'username'>): RosterMember {
  seq += 1
  return {
    platform: 'INSTAGRAM',
    personId: null,
    followers: 1000,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    hasFee: false,
    ...over,
  }
}
function profile(over: Partial<RosterProfile> & Pick<RosterProfile, 'influencerId' | 'username'>): RosterProfile {
  return { platform: 'TIKTOK', personId: null, followers: 5000, ...over }
}

describe('handles and person keys', () => {
  it('normalises a handle without ever treating it as a pattern', () => {
    expect(normalizeHandle('  @Ale_Ficticia ')).toBe('ale_ficticia')
    expect(normalizeHandle('@@gema.ficticia_')).toBe('gema.ficticia_')
    expect(normalizeHandle('maria_garcia')).not.toBe(normalizeHandle('maria.garcia'))
    expect(normalizeHandle('')).toBe('')
  })

  it('a profile with no person is its own implicit person', () => {
    expect(personKeyOf({ id: 'inf1' })).toBe('inf:inf1')
    expect(personKeyOf({ id: 'inf1', personId: null })).toBe('inf:inf1')
    expect(personKeyOf({ id: 'inf1', personId: 'per9' })).toBe('per9')
  })
})

describe('roster crediting', () => {
  it('credits a member for her own profile', () => {
    const alez = member({ influencerId: 'ig-alez', username: 'ale_ficticia' })
    const roster = buildRoster([alez], [])

    const credit = roster.creditFor('INSTAGRAM', '@Ale_Ficticia')
    expect(credit).not.toBeNull()
    expect(credit!.self).toBe(true)
    expect(credit!.member.influencerId).toBe('ig-alez')
    expect(credit!.publisher).toEqual({ influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', personId: null, followers: 1000 })
    expect(roster.creditForInfluencer('ig-alez')!.self).toBe(true)
    expect(roster.members).toHaveLength(1)
  })

  it('credits the Instagram member for a video of her linked TikTok profile', () => {
    const alez = member({ influencerId: 'ig-alez', username: 'ale_ficticia', personId: 'per-alez', followers: 2382 })
    const tiktok = profile({ influencerId: 'tt-alez', username: 'ale_ficticia', personId: 'per-alez', followers: 29000 })
    const roster = buildRoster([alez], [tiktok])

    const credit = roster.creditFor('TIKTOK', 'ale_ficticia')
    expect(credit).toMatchObject({ self: false, member: { influencerId: 'ig-alez' }, publisher: { influencerId: 'tt-alez', platform: 'TIKTOK', followers: 29000 } })
    expect(roster.creditForInfluencer('tt-alez')).toMatchObject({ self: false, member: { influencerId: 'ig-alez' }, publisher: { influencerId: 'tt-alez' } })
    // Her TikTok handle may differ from her Instagram one
    const gladys = member({ influencerId: 'ig-gladys', username: 'gema.ficticia_', personId: 'per-gladys' })
    const gladysTt = profile({ influencerId: 'tt-gladys', username: 'gladysss', personId: 'per-gladys' })
    expect(buildRoster([alez, gladys], [tiktok, gladysTt]).creditFor('TIKTOK', 'gladysss')!.member.influencerId).toBe('ig-gladys')
  })

  it('credits the member for a second Instagram profile of the same person', () => {
    // The member row is @risas_inventadas; her real Instagram is @risas_inventadas_
    const anchor = member({ influencerId: 'ig-humor', username: 'risas_inventadas', personId: 'per-humor', followers: 19 })
    const real = profile({ influencerId: 'ig-humor-real', username: 'risas_inventadas_', platform: 'INSTAGRAM', personId: 'per-humor' })
    const roster = buildRoster([anchor], [real])

    expect(roster.creditFor('INSTAGRAM', 'risas_inventadas_')).toMatchObject({ self: false, member: { influencerId: 'ig-humor' }, publisher: { influencerId: 'ig-humor-real' } })
    expect(roster.creditFor('INSTAGRAM', 'risas_inventadas')).toMatchObject({ self: true, member: { influencerId: 'ig-humor' } })
  })

  it('credits nobody for a handle that is not a profile of any member', () => {
    const alez = member({ influencerId: 'ig-alez', username: 'ale_ficticia', personId: 'per-alez' })
    const stranger = profile({ influencerId: 'tt-stranger', username: 'someoneelse', personId: 'per-other' })
    const roster = buildRoster([alez], [stranger])

    expect(roster.creditFor('TIKTOK', 'someoneelse')).toBeNull()
    expect(roster.creditFor('INSTAGRAM', 'nobody')).toBeNull()
    expect(roster.creditForInfluencer('tt-stranger')).toBeNull()
    expect(roster.creditForInfluencer('missing')).toBeNull()
    expect(roster.creditFor('INSTAGRAM', '')).toBeNull()
    expect(roster.creditFor('INSTAGRAM', '   @ ')).toBeNull()
  })

  it('does not treat the same handle on another network as the same creator', () => {
    const alez = member({ influencerId: 'ig-alez', username: 'ale_ficticia' })
    // The TikTok row exists in the table but nobody linked it: no personId
    const sameName = profile({ influencerId: 'tt-alez', username: 'ale_ficticia', personId: null })

    expect(buildRoster([alez], []).creditFor('TIKTOK', 'ale_ficticia')).toBeNull()
    expect(buildRoster([alez], [sameName]).creditFor('TIKTOK', 'ale_ficticia')).toBeNull()
    expect(buildRoster([alez], [sameName]).creditForInfluencer('tt-alez')).toBeNull()
    expect(buildRoster([alez], []).creditFor('YOUTUBE', 'ale_ficticia')).toBeNull()
  })

  it('leaves a legacy double membership alone: each account keeps its own content', () => {
    // @dana_ejemplo_dos is a member twice in October (Instagram and TikTok)
    for (const personId of [null, 'per-diana']) {
      const ig = member({ influencerId: 'ig-diana', username: 'dana_ejemplo_dos', personId, hasFee: true })
      const tt = member({ influencerId: 'tt-diana', username: 'dana_ejemplo_dos', platform: 'TIKTOK', personId })
      const roster = buildRoster([ig, tt], [])

      expect(roster.creditFor('INSTAGRAM', 'dana_ejemplo_dos')).toMatchObject({ self: true, member: { influencerId: 'ig-diana' } })
      expect(roster.creditFor('TIKTOK', 'dana_ejemplo_dos')).toMatchObject({ self: true, member: { influencerId: 'tt-diana' } })
      expect(roster.creditForInfluencer('tt-diana')).toMatchObject({ self: true, member: { influencerId: 'tt-diana' } })
      expect(roster.members).toHaveLength(2)
    }
  })

  it('keeps a member credited to herself even when she is also passed as a profile', () => {
    const ig = member({ influencerId: 'ig-diana', username: 'dana_ejemplo_dos', personId: 'per-diana', hasFee: true })
    const tt = member({ influencerId: 'tt-diana', username: 'dana_ejemplo_dos', platform: 'TIKTOK', personId: 'per-diana' })
    const asProfile = profile({ influencerId: 'tt-diana', username: 'dana_ejemplo_dos', personId: 'per-diana' })
    const roster = buildRoster([ig, tt], [asProfile])

    expect(roster.creditFor('TIKTOK', 'dana_ejemplo_dos')).toMatchObject({ self: true, member: { influencerId: 'tt-diana' } })
    expect(roster.members).toHaveLength(2)
  })

  it('never confuses an underscore with a dot, nor a prefix with a handle', () => {
    const maria = member({ influencerId: 'ig-maria', username: 'maria_garcia', personId: 'per-maria' })
    const mariaTt = profile({ influencerId: 'tt-maria', username: 'maria_garcia', personId: 'per-maria' })
    const roster = buildRoster([maria], [mariaTt])

    expect(roster.creditFor('INSTAGRAM', 'maria_garcia')).not.toBeNull()
    expect(roster.creditFor('INSTAGRAM', 'maria.garcia')).toBeNull()
    expect(roster.creditFor('INSTAGRAM', 'mariaxgarcia')).toBeNull()
    expect(roster.creditFor('INSTAGRAM', 'maria_garci')).toBeNull()
    expect(roster.creditFor('INSTAGRAM', 'maria_garcia_')).toBeNull()
    expect(roster.creditFor('TIKTOK', 'maria.garcia')).toBeNull()
    expect(roster.creditFor('TIKTOK', 'maria_garcia')).toMatchObject({ member: { influencerId: 'ig-maria' } })
  })

  it('with several members of one person, prefers the member on the network of the publication', () => {
    // Two member rows of one person (legacy), and a third profile that is not a member
    const ig = member({ influencerId: 'ig-pili', username: 'tips_casa_demo_largo', personId: 'per-pili', hasFee: true })
    const tt = member({ influencerId: 'tt-pili', username: 'tips_casa_demo', platform: 'TIKTOK', personId: 'per-pili' })
    const tt2 = profile({ influencerId: 'tt-pili-2', username: 'pili_recetas', platform: 'TIKTOK', personId: 'per-pili' })
    const ig2 = profile({ influencerId: 'ig-pili-2', username: 'tips_casa_demo', platform: 'INSTAGRAM', personId: 'per-pili' })
    const yt = profile({ influencerId: 'yt-pili', username: 'pilihogar', platform: 'YOUTUBE', personId: 'per-pili' })

    for (const roster of [buildRoster([ig, tt], [tt2, ig2, yt]), buildRoster([tt, ig], [yt, ig2, tt2])]) {
      // A TikTok video goes to the TikTok member although the Instagram one has the fee
      expect(roster.creditFor('TIKTOK', 'pili_recetas')).toMatchObject({ self: false, member: { influencerId: 'tt-pili' } })
      expect(roster.creditForInfluencer('tt-pili-2')).toMatchObject({ member: { influencerId: 'tt-pili' } })
      // An Instagram reel goes to the Instagram member
      expect(roster.creditFor('INSTAGRAM', 'tips_casa_demo')).toMatchObject({ self: false, member: { influencerId: 'ig-pili' } })
      // No member on that network: the one with a fee
      expect(roster.creditFor('YOUTUBE', 'pilihogar')).toMatchObject({ self: false, member: { influencerId: 'ig-pili' } })
    }
  })

  it('with several members and no fee, credits the oldest membership', () => {
    const older = member({ influencerId: 'ig-a', username: 'cuenta_a', personId: 'per-x', createdAt: new Date('2026-09-01T00:00:00Z') })
    const newer = member({ influencerId: 'ig-b', username: 'cuenta_b', personId: 'per-x', createdAt: new Date('2026-10-01T00:00:00Z') })
    const tt = profile({ influencerId: 'tt-x', username: 'cuenta_tt', personId: 'per-x' })

    expect(buildRoster([newer, older], [tt]).creditFor('TIKTOK', 'cuenta_tt')!.member.influencerId).toBe('ig-a')
    expect(buildRoster([older, newer], [tt]).creditFor('TIKTOK', 'cuenta_tt')!.member.influencerId).toBe('ig-a')
    // A fee wins over age
    const paid = { ...newer, hasFee: true }
    expect(buildRoster([older, paid], [tt]).creditFor('TIKTOK', 'cuenta_tt')!.member.influencerId).toBe('ig-b')
    // Same network wins over fee and age
    const ttMember = member({ influencerId: 'tt-m', username: 'cuenta_m', platform: 'TIKTOK', personId: 'per-x', createdAt: new Date('2026-10-20T00:00:00Z') })
    expect(buildRoster([older, paid, ttMember], [tt]).creditFor('TIKTOK', 'cuenta_tt')!.member.influencerId).toBe('tt-m')
  })

  it('ignores a profile whose person has no member in the campaign', () => {
    const alez = member({ influencerId: 'ig-alez', username: 'ale_ficticia', personId: 'per-alez' })
    const unrelated = profile({ influencerId: 'tt-other', username: 'ale_ficticia', personId: 'per-someone-else' })

    expect(buildRoster([alez], [unrelated]).creditFor('TIKTOK', 'ale_ficticia')).toBeNull()
  })

  it('counts every member once, whatever is passed twice', () => {
    const alez = member({ influencerId: 'ig-alez', username: 'ale_ficticia', personId: 'per-alez' })
    const tiktok = profile({ influencerId: 'tt-alez', username: 'ale_ficticia', personId: 'per-alez' })
    const roster = buildRoster([alez, { ...alez }], [tiktok, { ...tiktok }])

    expect(roster.members).toHaveLength(1)
    expect(roster.creditFor('TIKTOK', 'ale_ficticia')!.member.influencerId).toBe('ig-alez')
  })
})

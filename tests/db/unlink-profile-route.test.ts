/**
 * POST /api/influencers/[id]/unlink-profile — the way out of a profile
 * registered on the wrong creator (review of delivery 1, 12 Nov 2026: the
 * library function existed, nothing called it, so a mistaken confirmation was
 * permanent until someone edited the database).
 *
 * Staff only, checked by the route itself. It clears the link (logged with who
 * did it and why) and NEVER moves, detaches or deletes content nor touches a
 * campaign membership. The network is not involved; the session is the test's.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ session: null as null | { id: string; email: string; name: string; role: string } }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => auth.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { POST } from '@/app/api/influencers/[id]/unlink-profile/route'
import { linkProfile } from '@/lib/person-profiles'

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

beforeEach(reset)
afterAll(reset)

async function unlink(profileId: string, body?: unknown) {
  const request = new NextRequest(`http://localhost/api/influencers/${profileId}/unlink-profile`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const response = await POST(request, { params: Promise.resolve({ id: profileId }) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (await response.json()) as any }
}

/** A creator with her TikTok registered on the WRONG Instagram member, and a video stored through that link. */
async function mistakenLink() {
  const pm = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: { name: 'Marca Demo - Octubre (test)', targetAccounts: ['marca.demo'], targetHashtags: [], targetKeywords: [], userId: pm.id },
  })
  const wrong = await prisma.influencer.create({ data: { username: 'creadora_equivocada', platform: 'INSTAGRAM' } })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: wrong.id, status: 'COMPLETED' } })
  const tiktok = await prisma.influencer.create({ data: { username: 'otra.persona', platform: 'TIKTOK' } })
  await linkProfile({ memberInfluencerId: wrong.id, profileInfluencerId: tiktok.id, actor: { id: pm.id, name: pm.name }, evidence: 'pm_confirmed' })
  const video = await prisma.media.create({
    data: { externalId: '7690000000000000801', platform: 'TIKTOK', mediaType: 'VIDEO', views: 900, influencerId: wrong.id, publishedByInfluencerId: tiktok.id, campaignId: campaign.id },
  })
  return { pm, campaign, wrong, tiktok, video }
}

describe('POST /api/influencers/[id]/unlink-profile', () => {
  it('is staff only, checked by the route: no session 401, a brand or a creator 403, and nothing changes', async () => {
    const { tiktok, wrong } = await mistakenLink()
    auth.session = null
    expect((await unlink(tiktok.id)).status).toBe(401)
    for (const role of ['BRAND', 'CREATOR']) {
      auth.session = { id: 'u-x', email: 'x@example.test', name: 'X', role }
      expect((await unlink(tiktok.id)).status, role).toBe(403)
    }
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).not.toBeNull()
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: wrong.id } })).personId).not.toBeNull()
    expect(await prisma.personLog.count({ where: { action: 'unlink_profile' } })).toBe(0)
  })

  it('unlinks, logs who and why, and leaves the content and the memberships exactly as they were', async () => {
    const { pm, tiktok, wrong, video } = await mistakenLink()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const membershipsBefore = await prisma.campaignInfluencer.findMany({ orderBy: { id: 'asc' } })
    const mediaBefore = await prisma.media.findMany({ orderBy: { id: 'asc' } })

    const res = await unlink(tiktok.id, { reason: '  Elegí la creadora equivocada  ' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ logId: expect.any(String), profile: { id: tiktok.id, username: 'otra.persona', platform: 'TIKTOK' } })

    // The two were one person; both are on their own again
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).toBeNull()
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: wrong.id } })).personId).toBeNull()
    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: res.body.logId } })
    expect(log).toMatchObject({ action: 'unlink_profile', actorId: pm.id, actorName: 'Laura PM' })
    expect(log.summary).toContain('Motivo: Elegí la creadora equivocada')
    expect(await prisma.personLog.count({ where: { action: 'link_profile', undoneAt: null } })).toBe(0)

    // Nothing moves: the stored video stays where it was
    expect(await prisma.campaignInfluencer.findMany({ orderBy: { id: 'asc' } })).toEqual(membershipsBefore)
    expect(await prisma.media.findMany({ orderBy: { id: 'asc' } })).toEqual(mediaBefore)
    expect((await prisma.media.findUniqueOrThrow({ where: { id: video.id } })).publishedByInfluencerId).toBe(tiktok.id)
  })

  it('answers 404 for an unknown profile and 409 for one that is not linked (also the second time)', async () => {
    const { pm, tiktok } = await mistakenLink()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'ADMIN' }
    expect(await unlink('no-such-profile')).toEqual({ status: 404, body: { error: 'No encuentro ese perfil.' } })
    expect((await unlink(tiktok.id)).status).toBe(200)
    expect(await unlink(tiktok.id)).toEqual({ status: 409, body: { error: 'Ese perfil no está vinculado a ninguna persona.' } })
    expect(await prisma.personLog.count({ where: { action: 'unlink_profile' } })).toBe(1)
  })
})

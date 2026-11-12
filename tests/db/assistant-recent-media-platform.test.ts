/**
 * TKOC AI (POST /api/ai/chat) is told the network of each recent PUBLICATION
 * (Media.platform), not the network of the creator row it is filed under
 * (review of delivery 1, 12 Nov 2026). Since delivery 1 a creator's TikTok
 * video is stored under her Instagram row: labelled with the row's network,
 * the assistant called it an Instagram piece.
 *
 * The model is never called: the Anthropic SDK is replaced by a stub that
 * keeps the system prompt it is given.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ system: null as unknown, session: null as null | { id: string; email: string; name: string; role: string } }))

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: async (params: { system: unknown }) => {
        sdk.system = params.system
        return { content: [{ type: 'text', text: 'De acuerdo.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }
      },
    }
  }
  return { default: Anthropic }
})
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => sdk.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { POST } from '@/app/api/ai/chat/route'
import { linkProfile } from '@/lib/person-profiles'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

const savedKey = process.env.ANTHROPIC_API_KEY

beforeEach(async () => {
  await reset()
  sdk.system = null
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used'
})
afterAll(async () => {
  await reset()
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedKey
  vi.unstubAllGlobals()
})

interface RecentPiece { influencer: string; platform: string; type: string; views: number }

/** The «Datos actuales» the assistant received in its system prompt. */
function platformDataSent(): { recentMedia: RecentPiece[] } {
  const blocks = sdk.system as Array<{ text: string }>
  const header = '# Datos actuales de la plataforma (JSON)\n'
  const text = blocks.map(b => b.text).find(t => t.includes(header))
  if (!text) throw new Error('the system prompt carried no platform data')
  return JSON.parse(text.slice(text.indexOf(header) + header.length))
}

describe('the assistant’s recent pieces', () => {
  it('carry the network of the publication: her TikTok video filed under her Instagram row is a TikTok piece', async () => {
    const pm = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
    sdk.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Marca Demo - Octubre (test)', status: 'ACTIVE',
        startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'),
        targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: pm.id,
      },
    })
    const alba = await prisma.influencer.create({ data: { username: 'alba_prueba', platform: 'INSTAGRAM', followers: 2100 } })
    await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: alba.id, status: 'COMPLETED' } })
    const albaTikTok = await prisma.influencer.create({ data: { username: 'alba.tiktok', platform: 'TIKTOK', followers: 31000 } })
    await linkProfile({ memberInfluencerId: alba.id, profileInfluencerId: albaTikTok.id, actor: null, evidence: 'pm_manual' })

    // Her own reel, and her TikTok video credited to her Instagram row
    await prisma.media.create({
      data: {
        externalId: '3745000000000000601', platform: 'INSTAGRAM', mediaType: 'REEL', permalink: 'https://www.instagram.com/reel/DfReelAlba01/',
        views: 1200, postedAt: new Date('2026-10-10T10:00:00Z'), source: 'apify', influencerId: alba.id, campaignId: campaign.id,
      },
    })
    await prisma.media.create({
      data: {
        externalId: '7690000000000000601', platform: 'TIKTOK', mediaType: 'VIDEO', permalink: 'https://www.tiktok.com/@alba.tiktok/video/7690000000000000601',
        views: 54000, postedAt: new Date('2026-10-12T10:00:00Z'), source: 'manual',
        influencerId: alba.id, publishedByInfluencerId: albaTikTok.id, campaignId: campaign.id,
      },
    })

    const response = await POST(new NextRequest('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '¿Qué ha publicado alba_prueba?' }] }),
    }))
    expect(response.status).toBe(200)

    const pieces = platformDataSent().recentMedia.map(p => ({ influencer: p.influencer, platform: p.platform, type: p.type, views: p.views }))
    expect(pieces).toEqual([
      { influencer: 'alba_prueba', platform: 'TIKTOK', type: 'VIDEO', views: 54000 },
      { influencer: 'alba_prueba', platform: 'INSTAGRAM', type: 'REEL', views: 1200 },
    ])
  })
})

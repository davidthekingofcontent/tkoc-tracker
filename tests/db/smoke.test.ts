import { describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'

describe('throwaway database', () => {
  it('has the schema and is empty', async () => {
    expect(await prisma.campaign.count()).toBe(0)
    expect(await prisma.influencer.count()).toBe(0)
  })
})

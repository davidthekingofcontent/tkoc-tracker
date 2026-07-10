/**
 * Brand Connect — invite link generation (ADMIN only)
 * POST { brandId } → { url } where url = BASE/brand-connect/{jwt}
 * The JWT (30d) carries { ownerUserId, brandId, brandName, purpose: 'brand_connect' }
 * and is verified server-side when the brand starts the OAuth flow.
 */

import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { getBaseUrl } from '@/lib/meta-oauth'

interface BrandData {
  id: string
  name: string
  website?: string
  logo?: string
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can generate brand connect links' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { brandId } = body
    if (!brandId || typeof brandId !== 'string' || !brandId.startsWith('brand_')) {
      return NextResponse.json({ error: 'Valid brandId is required' }, { status: 400 })
    }

    // Brands live as Setting rows key='brand_{id}' (the key IS the brandId).
    const setting = await prisma.setting.findUnique({ where: { key: brandId } })
    if (!setting) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 })
    }

    let brand: BrandData
    try {
      brand = JSON.parse(setting.value) as BrandData
    } catch {
      return NextResponse.json({ error: 'Corrupted brand data' }, { status: 500 })
    }
    if (!brand?.name) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 })
    }

    const secret = process.env.JWT_SECRET
    if (!secret) {
      return NextResponse.json({ error: 'JWT_SECRET not configured' }, { status: 500 })
    }

    const token = jwt.sign(
      {
        ownerUserId: session.id,
        brandId,
        brandName: brand.name,
        brandLogo: brand.logo || undefined,
        purpose: 'brand_connect',
      },
      secret,
      { expiresIn: '30d' }
    )

    const base = getBaseUrl(request)
    return NextResponse.json({ url: `${base}/brand-connect/${token}` })
  } catch (error) {
    console.error('[Brand connect invite] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

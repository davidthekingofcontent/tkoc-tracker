import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

// ============ TYPES ============

type PermissionType = 'spark_ads' | 'partnership_ads' | 'brandconnect'
type PermissionStatus = 'PENDING' | 'GRANTED' | 'REVOKED'

interface AdPermission {
  id: string
  creatorId: string
  campaignId: string
  platform: string
  permissionType: PermissionType
  authorizationCode: string | null
  status: PermissionStatus
  grantedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  createdAt: string
}

// ============ HELPERS ============

function generateAuthorizationCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let code = ''
  for (let i = 0; i < 32; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

function settingKey(campaignId: string, creatorId: string): string {
  return `ad_permissions_${campaignId}_${creatorId}`
}

async function getPermissions(campaignId: string, creatorId: string): Promise<AdPermission[]> {
  const key = settingKey(campaignId, creatorId)
  const setting = await prisma.setting.findUnique({ where: { key } })
  if (!setting) return []
  try {
    return JSON.parse(setting.value) as AdPermission[]
  } catch {
    return []
  }
}

async function savePermissions(campaignId: string, creatorId: string, permissions: AdPermission[]): Promise<void> {
  const key = settingKey(campaignId, creatorId)
  const value = JSON.stringify(permissions)
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

async function getAllPermissionsForCreator(creatorId: string): Promise<AdPermission[]> {
  const settings = await prisma.setting.findMany({
    where: { key: { startsWith: 'ad_permissions_', endsWith: `_${creatorId}` } },
  })
  const all: AdPermission[] = []
  for (const s of settings) {
    try {
      const perms = JSON.parse(s.value) as AdPermission[]
      all.push(...perms)
    } catch {
      // skip malformed entries
    }
  }
  return all
}

async function getAllPermissionsForCampaign(campaignId: string): Promise<AdPermission[]> {
  const settings = await prisma.setting.findMany({
    where: { key: { startsWith: `ad_permissions_${campaignId}_` } },
  })
  const all: AdPermission[] = []
  for (const s of settings) {
    try {
      const perms = JSON.parse(s.value) as AdPermission[]
      all.push(...perms)
    } catch {
      // skip malformed entries
    }
  }
  return all
}

// ============ GET ============

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const creatorId = searchParams.get('creatorId')
    const campaignId = searchParams.get('campaignId')

    // Get permissions for a specific creator+campaign pair
    if (creatorId && campaignId) {
      const permissions = await getPermissions(campaignId, creatorId)
      return NextResponse.json({ permissions })
    }

    // Get all permissions for a creator
    if (creatorId) {
      const permissions = await getAllPermissionsForCreator(creatorId)
      return NextResponse.json({ permissions })
    }

    // Get all permissions for a campaign (brand/admin view)
    if (campaignId) {
      const permissions = await getAllPermissionsForCampaign(campaignId)
      return NextResponse.json({ permissions })
    }

    return NextResponse.json({ error: 'creatorId or campaignId required' }, { status: 400 })
  } catch (error) {
    console.error('Ad permissions GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============ POST ============

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { creatorId, campaignId, platform, permissionType } = body as {
      creatorId: string
      campaignId: string
      platform: string
      permissionType: PermissionType
    }

    if (!creatorId || !campaignId || !platform || !permissionType) {
      return NextResponse.json(
        { error: 'creatorId, campaignId, platform, and permissionType are required' },
        { status: 400 }
      )
    }

    const validTypes: PermissionType[] = ['spark_ads', 'partnership_ads', 'brandconnect']
    if (!validTypes.includes(permissionType)) {
      return NextResponse.json(
        { error: 'permissionType must be spark_ads, partnership_ads, or brandconnect' },
        { status: 400 }
      )
    }

    // Load existing permissions
    const existing = await getPermissions(campaignId, creatorId)

    // Check for duplicate active permission
    const duplicate = existing.find(
      (p) => p.platform === platform && p.permissionType === permissionType && p.status !== 'REVOKED'
    )
    if (duplicate) {
      return NextResponse.json(
        { error: 'Permission already exists for this platform and type', permission: duplicate },
        { status: 409 }
      )
    }

    // Generate authorization code for TikTok Spark Ads
    let authorizationCode: string | null = null
    if (platform.toUpperCase() === 'TIKTOK' && permissionType === 'spark_ads') {
      authorizationCode = generateAuthorizationCode()
    }

    // Calculate expiry (30 days default for TikTok Spark Ads)
    let expiresAt: string | null = null
    if (permissionType === 'spark_ads') {
      const expiry = new Date()
      expiry.setDate(expiry.getDate() + 30)
      expiresAt = expiry.toISOString()
    }

    const newPermission: AdPermission = {
      id: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      creatorId,
      campaignId,
      platform: platform.toUpperCase(),
      permissionType,
      authorizationCode,
      status: 'GRANTED',
      grantedAt: new Date().toISOString(),
      revokedAt: null,
      expiresAt,
      createdAt: new Date().toISOString(),
    }

    existing.push(newPermission)
    await savePermissions(campaignId, creatorId, existing)

    return NextResponse.json({ permission: newPermission }, { status: 201 })
  } catch (error) {
    console.error('Ad permissions POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============ DELETE ============

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const permissionId = searchParams.get('permissionId')
    const creatorId = searchParams.get('creatorId')
    const campaignId = searchParams.get('campaignId')

    if (!permissionId || !creatorId || !campaignId) {
      return NextResponse.json(
        { error: 'permissionId, creatorId, and campaignId are required' },
        { status: 400 }
      )
    }

    const existing = await getPermissions(campaignId, creatorId)
    const permIndex = existing.findIndex((p) => p.id === permissionId)

    if (permIndex === -1) {
      return NextResponse.json({ error: 'Permission not found' }, { status: 404 })
    }

    // Revoke instead of hard delete for audit trail
    existing[permIndex] = {
      ...existing[permIndex],
      status: 'REVOKED',
      revokedAt: new Date().toISOString(),
    }

    await savePermissions(campaignId, creatorId, existing)

    return NextResponse.json({ permission: existing[permIndex] })
  } catch (error) {
    console.error('Ad permissions DELETE error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

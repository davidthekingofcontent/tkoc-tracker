import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// Keys we track in the settings table
const INTEGRATION_KEYS = [
  'apify_api_key',
  'instagram_connected',
  'tiktok_connected',
  'youtube_connected',
] as const

async function getSettingValue(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key } })
  return setting?.value ?? null
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

// GET — return current integration status
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Read all integration settings from DB
    const settings = await prisma.setting.findMany({
      where: { key: { in: [...INTEGRATION_KEYS] } },
    })

    const settingsMap: Record<string, string> = {}
    for (const s of settings) {
      settingsMap[s.key] = s.value
    }

    // Apify: check DB first, then env var
    const apifyKey = settingsMap['apify_api_key'] || process.env.APIFY_API_KEY || ''
    const apifyConnected = !!apifyKey

    // Platform connections from DB
    const instagramConnected = settingsMap['instagram_connected'] === 'true'
    const tiktokConnected = settingsMap['tiktok_connected'] === 'true'
    const youtubeConnected = settingsMap['youtube_connected'] === 'true'

    return NextResponse.json({
      integrations: {
        instagram: { connected: instagramConnected },
        tiktok: { connected: tiktokConnected },
        youtube: { connected: youtubeConnected },
        apify: { connected: apifyConnected, key: apifyKey },
      },
    })
  } catch (error) {
    console.error('Failed to load integrations:', error)
    return NextResponse.json({ error: 'Failed to load integrations' }, { status: 500 })
  }
}

// PUT — update a setting by key/value
export async function PUT(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { key, value } = body as { key: string; value: string }

    if (!key || value === undefined) {
      return NextResponse.json({ error: 'Missing key or value' }, { status: 400 })
    }

    // Validate key is one we allow
    const allowedKeys = [...INTEGRATION_KEYS]
    if (!allowedKeys.includes(key as typeof INTEGRATION_KEYS[number])) {
      return NextResponse.json({ error: 'Invalid setting key' }, { status: 400 })
    }

    await upsertSetting(key, value)

    return NextResponse.json({ success: true, key, value })
  } catch (error) {
    console.error('Failed to update integration:', error)
    return NextResponse.json({ error: 'Failed to update integration' }, { status: 500 })
  }
}

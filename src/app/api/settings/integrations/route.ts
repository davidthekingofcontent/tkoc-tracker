import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// Keys we track in the settings table
const INTEGRATION_KEYS = [
  'apify_api_key',
  'instagram_connected',
  'tiktok_connected',
  'youtube_connected',
  'youtube_api_key',
  'meta_app_id',
  'meta_app_secret',
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

    // Internal screen: staff only
    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const isAdmin = session.role === 'ADMIN'

    // SECRETS NEVER LEAVE THE SERVER. Until 12 Nov 2026 this answered any
    // logged-in user with the Apify and YouTube keys in full, including the
    // ones that only exist as environment variables. Now: `connected` says
    // whether a key exists (database or environment); the value itself is
    // returned only to an ADMIN and only when the ADMIN typed it in this
    // screen (stored in the database), never the environment secret.
    const apifyConnected = !!(settingsMap['apify_api_key'] || process.env.APIFY_API_KEY)
    const apifyKey = isAdmin ? (settingsMap['apify_api_key'] || '') : ''

    // Platform connections from DB
    const instagramConnected = settingsMap['instagram_connected'] === 'true'
    const tiktokConnected = settingsMap['tiktok_connected'] === 'true'
    const youtubeConnected = settingsMap['youtube_connected'] === 'true'

    // YouTube API key: same rule
    const youtubeKeyConfigured = !!(settingsMap['youtube_api_key'] || process.env.YOUTUBE_API_KEY)
    const youtubeApiKey = isAdmin ? (settingsMap['youtube_api_key'] || '') : ''

    return NextResponse.json({
      integrations: {
        instagram: { connected: instagramConnected },
        tiktok: { connected: tiktokConnected },
        youtube: { connected: youtubeConnected, apiKey: youtubeApiKey, keyConfigured: youtubeKeyConfigured },
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

    // Only ADMIN can modify integrations
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only administrators can manage integrations' }, { status: 403 })
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

    if ((key === 'apify_api_key' || key === 'youtube_api_key') && (typeof value !== 'string' || !value.trim())) {
      return NextResponse.json({ error: 'Empty key' }, { status: 400 })
    }

    await upsertSetting(key, typeof value === 'string' ? value.trim() : value)

    return NextResponse.json({ success: true, key })
  } catch (error) {
    console.error('Failed to update integration:', error)
    return NextResponse.json({ error: 'Failed to update integration' }, { status: 500 })
  }
}

/**
 * API Connection Test Endpoint
 * Tests whether configured API credentials are working.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/crypto'

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('auth-token')?.value
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const payload = verifyToken(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const platform = request.nextUrl.searchParams.get('platform')

    if (platform === 'youtube') {
      return testYouTubeConnection()
    }

    if (platform === 'meta') {
      return testMetaConnection(payload.userId)
    }

    return NextResponse.json({ error: 'Invalid platform. Use: youtube, meta' }, { status: 400 })
  } catch (error) {
    console.error('[Integration Test] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function testYouTubeConnection() {
  // Check for API key
  let apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) {
    const setting = await prisma.setting.findFirst({ where: { key: 'youtube_api_key' } })
    apiKey = setting?.value || undefined
  }

  if (!apiKey) {
    return NextResponse.json({
      success: false,
      message: 'YouTube API key not configured',
    })
  }

  // Test with a known channel
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=UC_x5XG1OV2P6uZZ5FSM9Ttw&key=${apiKey}`
    )

    if (res.ok) {
      const data = await res.json() as { items?: Array<{ snippet: { title: string } }> }
      const channelName = data.items?.[0]?.snippet?.title || 'Unknown'
      return NextResponse.json({
        success: true,
        message: `YouTube API connected successfully. Test channel: ${channelName}`,
        quotaUsed: 1,
      })
    }

    const errorBody = await res.text()
    return NextResponse.json({
      success: false,
      message: `YouTube API error: ${res.status}`,
      details: errorBody.slice(0, 200),
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      message: `YouTube API connection failed: ${error}`,
    })
  }
}

async function testMetaConnection(userId: string) {
  // Check for stored token
  const socialToken = await prisma.socialToken.findFirst({
    where: {
      userId,
      platform: 'INSTAGRAM',
      tokenType: 'page',
      isValid: true,
    },
  })

  if (!socialToken) {
    return NextResponse.json({
      success: false,
      message: 'Meta/Instagram not connected. Use "Connect with Facebook" to set up.',
    })
  }

  // Test the token
  try {
    const accessToken = decrypt(socialToken.accessToken)
    const res = await fetch(
      `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${accessToken}`
    )

    if (res.ok) {
      const data = await res.json() as { id: string; name: string }

      // Check token expiry
      const expiresIn = socialToken.expiresAt
        ? Math.round((new Date(socialToken.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null

      return NextResponse.json({
        success: true,
        message: `Meta connected as: ${data.name}`,
        igUserId: socialToken.platformUserId,
        pageId: socialToken.platformPageId,
        expiresInDays: expiresIn,
        scopes: socialToken.scopes,
      })
    }

    // Token may be expired
    const errorBody = await res.text()
    await prisma.socialToken.update({
      where: { id: socialToken.id },
      data: { isValid: false, lastError: `Test failed: ${res.status}` },
    })

    return NextResponse.json({
      success: false,
      message: `Meta token invalid (${res.status}). Please reconnect.`,
      details: errorBody.slice(0, 200),
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      message: `Meta connection test failed: ${error}`,
    })
  }
}

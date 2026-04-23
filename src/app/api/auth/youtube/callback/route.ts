/**
 * YouTube Analytics OAuth Callback
 * Handles the redirect from Google OAuth dialog.
 * Exchanges code for tokens, identifies channel, stores encrypted tokens.
 */

import { NextRequest, NextResponse } from 'next/server'
import { exchangeGoogleCode } from '@/lib/youtube-analytics'
import { encrypt } from '@/lib/crypto'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

    if (error) {
      console.warn('[YouTube OAuth] User denied access:', error)
      return NextResponse.redirect(`${baseUrl}/settings?youtube=denied`)
    }

    if (!code || !state) {
      return NextResponse.redirect(`${baseUrl}/settings?youtube=error&reason=missing_params`)
    }

    let userId: string
    let influencerId: string
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString())
      userId = stateData.userId
      influencerId = stateData.influencerId || ''
    } catch {
      return NextResponse.redirect(`${baseUrl}/settings?youtube=error&reason=invalid_state`)
    }

    const clientId = process.env.GOOGLE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      return NextResponse.redirect(`${baseUrl}/settings?youtube=error&reason=missing_config`)
    }

    const redirectUri = `${baseUrl}/api/auth/youtube/callback`

    // Exchange code for tokens
    const tokenData = await exchangeGoogleCode(code, clientId, clientSecret, redirectUri)
    if (!tokenData) {
      return NextResponse.redirect(`${baseUrl}/settings?youtube=error&reason=token_exchange_failed`)
    }

    // Get the user's YouTube channel ID
    let channelId = ''
    try {
      const channelRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',
        { headers: { Authorization: `Bearer ${tokenData.accessToken}` } }
      )
      if (channelRes.ok) {
        const channelData = await channelRes.json() as {
          items?: Array<{ id: string; snippet: { title: string } }>
        }
        channelId = channelData.items?.[0]?.id || ''
      }
    } catch {
      console.warn('[YouTube OAuth] Could not identify channel')
    }

    // Store token (linked to influencer if provided, otherwise to user)
    const scopes = tokenData.scope.split(' ')

    const existingYt = await prisma.socialToken.findFirst({
      where: { platform: 'YOUTUBE', userId, tokenType: 'user' },
    })

    const commonData = {
      accessToken: encrypt(tokenData.accessToken),
      refreshToken: tokenData.refreshToken ? encrypt(tokenData.refreshToken) : null,
      expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000),
      scopes,
      platformUserId: channelId,
      isValid: true,
      lastError: null,
      lastUsedAt: new Date(),
    }

    if (existingYt) {
      await prisma.socialToken.update({
        where: { id: existingYt.id },
        data: {
          ...commonData,
          ...(influencerId ? { influencerId } : {}),
        },
      })
    } else {
      await prisma.socialToken.create({
        data: {
          platform: 'YOUTUBE',
          tokenType: 'user',
          userId,
          ...(influencerId ? { influencerId } : {}),
          ...commonData,
        },
      })
    }

    // Update integration setting
    await prisma.setting.upsert({
      where: { key: 'youtube_connected' },
      create: { key: 'youtube_connected', value: 'true' },
      update: { value: 'true' },
    })

    return NextResponse.redirect(`${baseUrl}/settings?youtube=success`)
  } catch (error) {
    console.error('[YouTube OAuth] Callback error:', error)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    return NextResponse.redirect(`${baseUrl}/settings?youtube=error&reason=internal`)
  }
}

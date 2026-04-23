/**
 * Meta OAuth Callback
 * Handles the redirect from Facebook OAuth dialog.
 * Exchanges code for tokens, discovers IG Business Account, stores encrypted tokens.
 */

import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForToken, getLongLivedToken, discoverIGBusinessAccount, getPageAccessToken } from '@/lib/instagram-api'
import { encrypt } from '@/lib/crypto'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

    // Handle user denial
    if (error) {
      console.warn('[Meta OAuth] User denied access:', error)
      return NextResponse.redirect(`${baseUrl}/settings?meta=denied`)
    }

    if (!code || !state) {
      return NextResponse.redirect(`${baseUrl}/settings?meta=error&reason=missing_params`)
    }

    // Decode state
    let userId: string
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString())
      userId = stateData.userId
    } catch {
      return NextResponse.redirect(`${baseUrl}/settings?meta=error&reason=invalid_state`)
    }

    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      return NextResponse.redirect(`${baseUrl}/settings?meta=error&reason=missing_config`)
    }

    const redirectUri = `${baseUrl}/api/auth/meta/callback`

    // Step 1: Exchange code for short-lived token
    const shortLived = await exchangeCodeForToken(code, appId, appSecret, redirectUri)
    if (!shortLived) {
      return NextResponse.redirect(`${baseUrl}/settings?meta=error&reason=token_exchange_failed`)
    }

    // Step 2: Exchange for long-lived token (60 days)
    const longLived = await getLongLivedToken(shortLived.accessToken, appId, appSecret)
    const finalToken = longLived || shortLived
    const expiresIn = longLived?.expiresIn || shortLived.expiresIn || 5184000 // Default 60 days

    // Step 3: Discover IG Business Account
    const igAccount = await discoverIGBusinessAccount(finalToken.accessToken)

    // Step 4: Get page access token (longer-lived)
    let pageToken = finalToken.accessToken
    if (igAccount?.pageId) {
      const pt = await getPageAccessToken(finalToken.accessToken, igAccount.pageId)
      if (pt) pageToken = pt
    }

    // Step 5: Store encrypted token
    const scopes = [
      'instagram_basic',
      'instagram_creator_marketplace_discovery',
      'pages_manage_metadata',
      'pages_show_list',
      'business_management',
    ]

    const existingToken = await prisma.socialToken.findFirst({
      where: {
        platform: 'INSTAGRAM',
        userId,
        tokenType: 'page',
      },
    })

    if (existingToken) {
      await prisma.socialToken.update({
        where: { id: existingToken.id },
        data: {
          accessToken: encrypt(pageToken),
          expiresAt: new Date(Date.now() + expiresIn * 1000),
          scopes,
          platformUserId: igAccount?.igUserId || null,
          platformPageId: igAccount?.pageId || null,
          isValid: true,
          lastError: null,
          lastUsedAt: new Date(),
        },
      })
    } else {
      await prisma.socialToken.create({
        data: {
          platform: 'INSTAGRAM',
          tokenType: 'page',
          userId,
          accessToken: encrypt(pageToken),
          expiresAt: new Date(Date.now() + expiresIn * 1000),
          scopes,
          platformUserId: igAccount?.igUserId || null,
          platformPageId: igAccount?.pageId || null,
          isValid: true,
        },
      })
    }

    // Step 6: Update integration setting
    await prisma.setting.upsert({
      where: { key: 'instagram_connected' },
      create: { key: 'instagram_connected', value: 'true' },
      update: { value: 'true' },
    })

    const igUsername = igAccount?.username ? `&ig_username=${igAccount.username}` : ''
    return NextResponse.redirect(`${baseUrl}/settings?meta=success${igUsername}`)
  } catch (error) {
    console.error('[Meta OAuth] Callback error:', error)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    return NextResponse.redirect(`${baseUrl}/settings?meta=error&reason=internal`)
  }
}

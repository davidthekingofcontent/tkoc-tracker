/**
 * Meta OAuth — Brand callback
 * Validates state cookie, exchanges code, discovers pages/IG, creates SocialToken per page.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { encrypt } from '@/lib/encryption'
import {
  exchangeCodeForToken,
  getLongLivedToken,
  getUserPages,
  getIgProfileById,
} from '@/lib/meta-api'
import {
  decodeMetaState,
  getBaseUrl,
  META_STATE_COOKIE,
} from '@/lib/meta-oauth'

export async function GET(request: NextRequest) {
  const session = await getSession(request)
  const base = getBaseUrl(request)

  if (!session) {
    return NextResponse.redirect(`${base}/login`)
  }

  const url = request.nextUrl
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  const cookieValue = request.cookies.get(META_STATE_COOKIE)?.value
  const decodedState = decodeMetaState(cookieValue)

  // Clear state cookie on every callback to prevent replay.
  const clearCookie = (res: NextResponse) => {
    res.cookies.set(META_STATE_COOKIE, '', { path: '/', maxAge: 0 })
    return res
  }

  if (oauthError) {
    return clearCookie(
      NextResponse.redirect(`${base}/settings?tab=integrations&error=meta_denied`)
    )
  }

  if (!code || !stateParam || !decodedState) {
    return clearCookie(
      NextResponse.redirect(`${base}/settings?tab=integrations&error=meta_invalid_state`)
    )
  }

  if (decodedState.kind !== 'brand' || decodedState.nonce !== stateParam) {
    return clearCookie(
      NextResponse.redirect(`${base}/settings?tab=integrations&error=meta_state_mismatch`)
    )
  }

  if (decodedState.userId !== session.id) {
    return clearCookie(
      NextResponse.redirect(`${base}/settings?tab=integrations&error=meta_user_mismatch`)
    )
  }

  try {
    const redirectUri = decodedState.redirectUri
    const shortLived = await exchangeCodeForToken(code, redirectUri)
    const longLived = await getLongLivedToken(shortLived.access_token)

    const pages = await getUserPages(longLived.access_token)
    const igPages = pages.filter(p => p.instagram_business_account?.id)

    if (igPages.length === 0) {
      return clearCookie(
        NextResponse.redirect(`${base}/settings?tab=integrations&error=meta_no_ig_account`)
      )
    }

    const userToken = longLived.access_token
    const expiresAt = new Date(Date.now() + longLived.expires_in * 1000)

    for (const page of igPages) {
      const igId = page.instagram_business_account!.id

      // Upsert SocialToken keyed by (platform, userId, platformUserId).
      const existing = await prisma.socialToken.findFirst({
        where: {
          platform: 'INSTAGRAM',
          userId: session.id,
          platformUserId: igId,
          tokenType: 'brand',
        },
      })

      const commonData = {
        platform: 'INSTAGRAM' as const,
        tokenType: 'brand',
        userId: session.id,
        accessToken: encrypt(page.access_token),
        refreshToken: encrypt(userToken),
        expiresAt,
        scopes: [
          'instagram_basic',
          'instagram_manage_insights',
          'pages_show_list',
          'pages_read_engagement',
          'business_management',
        ],
        platformUserId: igId,
        platformPageId: page.id,
        isValid: true,
        lastError: null,
        lastUsedAt: new Date(),
      }

      let socialTokenId: string
      if (existing) {
        const updated = await prisma.socialToken.update({
          where: { id: existing.id },
          data: commonData,
        })
        socialTokenId = updated.id
      } else {
        const created = await prisma.socialToken.create({ data: commonData })
        socialTokenId = created.id
      }

      // Initial account snapshot
      try {
        const profile = await getIgProfileById(igId, page.access_token)
        await prisma.metaAccountSnapshot.create({
          data: {
            socialTokenId,
            igUsername: profile.username,
            igName: profile.name ?? null,
            igBiography: profile.biography ?? null,
            igWebsite: profile.website ?? null,
            igProfilePicUrl: profile.profile_picture_url ?? null,
            followersCount: profile.followers_count ?? 0,
            followsCount: profile.follows_count ?? 0,
            mediaCount: profile.media_count ?? 0,
          },
        })
      } catch (err) {
        console.error('[Meta brand callback] failed to capture initial snapshot', err instanceof Error ? err.message : err)
      }
    }

    return clearCookie(NextResponse.redirect(`${base}/settings?tab=integrations&connected=meta`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[Meta brand callback] error:', msg)
    return clearCookie(
      NextResponse.redirect(`${base}/settings?tab=integrations&error=meta_token_exchange_failed`)
    )
  }
}

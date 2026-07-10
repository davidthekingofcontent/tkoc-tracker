/**
 * Meta OAuth — Brand Connect callback (session-less)
 * Validates state cookie, re-verifies the invite JWT, exchanges code,
 * discovers pages/IG and creates SocialToken rows owned by the agency
 * owner (ownerUserId from the invite) with tokenType 'brand' — exactly
 * like the authenticated brand callback. Also stores the connected IG
 * username under Setting key='brand_ig_{brandId}' for future attribution.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { encrypt } from '@/lib/encryption'
import { verifyBrandConnectToken } from '@/lib/brand-connect'
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
  const base = getBaseUrl(request)
  const url = request.nextUrl
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  const cookieValue = request.cookies.get(META_STATE_COOKIE)?.value
  const decodedState = decodeMetaState(cookieValue)

  // Clear state cookie on every callback to prevent replay.
  const clear = (res: NextResponse) => {
    res.cookies.set(META_STATE_COOKIE, '', { path: '/', maxAge: 0 })
    return res
  }

  const inviteToken = decodedState?.invitationToken
  const redirectToLanding = (qs: string) =>
    NextResponse.redirect(
      `${base}/brand-connect/${inviteToken ? encodeURIComponent(inviteToken) : 'unknown'}?${qs}`
    )

  if (oauthError) {
    return clear(redirectToLanding('error=denied'))
  }

  if (!code || !stateParam || !decodedState || decodedState.kind !== 'brand_connect') {
    return clear(redirectToLanding('error=invalid_state'))
  }
  if (decodedState.nonce !== stateParam) {
    return clear(redirectToLanding('error=state_mismatch'))
  }
  if (!inviteToken) {
    return clear(redirectToLanding('error=missing_invite'))
  }

  // Re-verify invite JWT (signature + purpose + expiry) — the owner user id
  // comes from here, NOT from any session.
  const invite = verifyBrandConnectToken(inviteToken)
  if (!invite) {
    return clear(redirectToLanding('error=invalid_token'))
  }

  try {
    const redirectUri = decodedState.redirectUri
    const shortLived = await exchangeCodeForToken(code, redirectUri)
    const longLived = await getLongLivedToken(shortLived.access_token)

    const pages = await getUserPages(longLived.access_token)
    const igPages = pages.filter(p => p.instagram_business_account?.id)

    if (igPages.length === 0) {
      return clear(redirectToLanding('error=no_ig_account'))
    }

    const userToken = longLived.access_token
    const expiresAt = new Date(Date.now() + longLived.expires_in * 1000)
    let firstIgUsername: string | null = null

    for (const page of igPages) {
      const igId = page.instagram_business_account!.id

      // Upsert SocialToken keyed by (platform, userId, platformUserId).
      // userId = the agency owner from the invite: campaigns/materialization
      // key off campaign.userId which equals this user.
      const existing = await prisma.socialToken.findFirst({
        where: {
          platform: 'INSTAGRAM',
          userId: invite.ownerUserId,
          platformUserId: igId,
          tokenType: 'brand',
        },
      })

      const commonData = {
        platform: 'INSTAGRAM' as const,
        tokenType: 'brand',
        userId: invite.ownerUserId,
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
        if (!firstIgUsername && profile.username) {
          firstIgUsername = profile.username
        }
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
        console.error('[Meta brand-connect callback] failed to capture initial snapshot', err instanceof Error ? err.message : err)
      }
    }

    // SocialToken has no brandId column — record brand→IG attribution as a
    // Setting: key='brand_ig_{brandId}' value=igUsername.
    if (firstIgUsername) {
      try {
        await prisma.setting.upsert({
          where: { key: `brand_ig_${invite.brandId}` },
          update: { value: firstIgUsername },
          create: { key: `brand_ig_${invite.brandId}`, value: firstIgUsername },
        })
      } catch (err) {
        console.error('[Meta brand-connect callback] failed to store brand_ig setting', err instanceof Error ? err.message : err)
      }
    }

    return clear(
      NextResponse.redirect(`${base}/brand-connect/${encodeURIComponent(inviteToken)}?success=true`)
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[Meta brand-connect callback] error:', msg)
    return clear(redirectToLanding('error=exchange_failed'))
  }
}

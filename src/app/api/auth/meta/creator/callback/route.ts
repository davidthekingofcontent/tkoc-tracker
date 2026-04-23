/**
 * Meta OAuth — Creator callback
 * Public endpoint. Resolves invitation → CreatorProfile, stores SocialToken with creatorProfileId.
 */

import { NextRequest, NextResponse } from 'next/server'
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
  const base = getBaseUrl(request)
  const url = request.nextUrl
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  const cookieValue = request.cookies.get(META_STATE_COOKIE)?.value
  const decodedState = decodeMetaState(cookieValue)

  const clear = (res: NextResponse) => {
    res.cookies.set(META_STATE_COOKIE, '', { path: '/', maxAge: 0 })
    return res
  }

  const invitationToken = decodedState?.invitationToken
  const redirectToConnect = (qs: string) =>
    NextResponse.redirect(
      `${base}/creators/connect/${invitationToken || 'unknown'}?${qs}`
    )

  if (oauthError) {
    return clear(redirectToConnect('ig_error=denied'))
  }

  if (!code || !stateParam || !decodedState || decodedState.kind !== 'creator') {
    return clear(redirectToConnect('ig_error=invalid_state'))
  }
  if (decodedState.nonce !== stateParam) {
    return clear(redirectToConnect('ig_error=state_mismatch'))
  }
  if (!invitationToken) {
    return clear(redirectToConnect('ig_error=missing_invitation'))
  }

  // Re-resolve invitation
  const invitation = await prisma.invitation.findUnique({
    where: { token: invitationToken },
  })
  if (!invitation) {
    return clear(redirectToConnect('ig_error=invitation_not_found'))
  }

  try {
    const redirectUri = decodedState.redirectUri
    const shortLived = await exchangeCodeForToken(code, redirectUri)
    const longLived = await getLongLivedToken(shortLived.access_token)

    const pages = await getUserPages(longLived.access_token)
    const igPages = pages.filter(p => p.instagram_business_account?.id)
    if (igPages.length === 0) {
      return clear(redirectToConnect('ig_error=no_ig_business'))
    }

    // Take the first IG business account (creators typically have one).
    const page = igPages[0]
    const igId = page.instagram_business_account!.id
    const profile = await getIgProfileById(igId, page.access_token)

    // Resolve or create CreatorProfile. Match by existing CreatorPlatformProfile username first.
    let creatorProfileId: string | null = null
    const existingPlatformProfile = await prisma.creatorPlatformProfile.findUnique({
      where: { platform_username: { platform: 'INSTAGRAM', username: profile.username } },
    })
    if (existingPlatformProfile) {
      creatorProfileId = existingPlatformProfile.creatorId
    }

    if (!creatorProfileId) {
      const createdProfile = await prisma.creatorProfile.create({
        data: {
          displayName: profile.name || profile.username,
          primaryPlatform: 'INSTAGRAM',
          contactEmail: invitation.email,
          contactEmailSource: 'invitation',
          platformProfiles: {
            create: {
              platform: 'INSTAGRAM',
              username: profile.username,
              platformUserId: igId,
              followers: profile.followers_count ?? 0,
              following: profile.follows_count ?? 0,
              postsCount: profile.media_count ?? 0,
              bio: profile.biography || null,
              avatarUrl: profile.profile_picture_url || null,
              dataSource: 'api',
              lastScraped: new Date(),
              scrapeCount: 1,
            },
          },
        },
      })
      creatorProfileId = createdProfile.id
    } else {
      // Ensure we update the platform profile with fresh metrics
      await prisma.creatorPlatformProfile.update({
        where: { platform_username: { platform: 'INSTAGRAM', username: profile.username } },
        data: {
          platformUserId: igId,
          followers: profile.followers_count ?? 0,
          following: profile.follows_count ?? 0,
          postsCount: profile.media_count ?? 0,
          bio: profile.biography || null,
          avatarUrl: profile.profile_picture_url || null,
          dataSource: 'api',
          lastScraped: new Date(),
          scrapeCount: { increment: 1 },
        },
      })
    }

    const expiresAt = new Date(Date.now() + longLived.expires_in * 1000)

    // Upsert SocialToken (platform + creatorProfileId + platformUserId)
    const existingToken = await prisma.socialToken.findFirst({
      where: {
        platform: 'INSTAGRAM',
        creatorProfileId,
        platformUserId: igId,
        tokenType: 'creator',
      },
    })
    const commonData = {
      platform: 'INSTAGRAM' as const,
      tokenType: 'creator',
      creatorProfileId,
      accessToken: encrypt(page.access_token),
      refreshToken: encrypt(longLived.access_token),
      expiresAt,
      scopes: ['instagram_basic', 'instagram_manage_insights', 'pages_show_list'],
      platformUserId: igId,
      platformPageId: page.id,
      isValid: true,
      lastError: null,
      lastUsedAt: new Date(),
    }

    let socialTokenId: string
    if (existingToken) {
      const updated = await prisma.socialToken.update({
        where: { id: existingToken.id },
        data: commonData,
      })
      socialTokenId = updated.id
    } else {
      const created = await prisma.socialToken.create({ data: commonData })
      socialTokenId = created.id
    }

    // Initial snapshot
    try {
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
      console.error('[Meta creator callback] snapshot failed', err instanceof Error ? err.message : err)
    }

    // Mark invitation accepted (creator opted in by connecting IG).
    if (!invitation.accepted) {
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { accepted: true },
      })
    }

    return clear(
      NextResponse.redirect(`${base}/creators/connect/${invitationToken}?success=true`)
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error('[Meta creator callback] error:', msg)
    return clear(redirectToConnect('ig_error=exchange_failed'))
  }
}

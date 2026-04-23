/**
 * Meta Sync — shared logic for refreshing Meta/IG Business connection data.
 *
 * Called from:
 *   - /api/meta/sync/[connectionId] (manual)
 *   - /api/cron/meta-sync (periodic)
 */

import { prisma } from '@/lib/db'
import { decrypt, encrypt } from '@/lib/encryption'
import {
  getIgProfileById,
  getIgMedia,
  getIgMediaInsights,
  getIgStories,
  getIgAudienceInsights,
  getTaggedMedia,
  refreshLongLivedToken,
  MetaApiError,
} from '@/lib/meta-api'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface SyncResult {
  success: boolean
  snapshots: number
  media: number
  stories: number
  mentions: number
  error?: string
}

export async function syncMetaConnection(connectionId: string): Promise<SyncResult> {
  const result: SyncResult = { success: false, snapshots: 0, media: 0, stories: 0, mentions: 0 }

  const token = await prisma.socialToken.findUnique({ where: { id: connectionId } })
  if (!token) {
    return { ...result, error: 'Connection not found' }
  }
  if (token.platform !== 'INSTAGRAM') {
    return { ...result, error: 'Not a Meta/Instagram connection' }
  }
  if (!token.isValid) {
    return { ...result, error: 'Connection is marked invalid' }
  }
  if (!token.platformUserId) {
    return { ...result, error: 'Missing platformUserId (IG business id)' }
  }

  let pageAccessToken: string
  try {
    pageAccessToken = decrypt(token.accessToken)
  } catch {
    await prisma.socialToken.update({
      where: { id: connectionId },
      data: { isValid: false, lastError: 'Failed to decrypt access token' },
    })
    return { ...result, error: 'Failed to decrypt access token' }
  }

  // Proactive refresh: if within 7 days of expiry, refresh via user long-lived token.
  if (token.expiresAt && token.expiresAt.getTime() - Date.now() < SEVEN_DAYS_MS && token.refreshToken) {
    try {
      const userToken = decrypt(token.refreshToken)
      const refreshed = await refreshLongLivedToken(userToken)
      const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000)
      await prisma.socialToken.update({
        where: { id: connectionId },
        data: {
          refreshToken: encrypt(refreshed.access_token),
          expiresAt: newExpiresAt,
          lastError: null,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown refresh error'
      await prisma.socialToken.update({
        where: { id: connectionId },
        data: { lastError: `refresh_failed: ${msg}` },
      })
      // Keep trying the rest of the sync even if refresh failed.
    }
  }

  const igId = token.platformUserId

  // 1) Account snapshot
  try {
    const profile = await getIgProfileById(igId, pageAccessToken)
    await prisma.metaAccountSnapshot.create({
      data: {
        socialTokenId: connectionId,
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
    result.snapshots = 1
  } catch (err) {
    return markFailed(connectionId, err, result)
  }

  // 2) Media + insights
  try {
    const media = await getIgMedia(igId, pageAccessToken, 25)
    for (const m of media) {
      const insights = await getIgMediaInsights(m.id, m.media_type, pageAccessToken).catch(() => ({} as Record<string, number>))
      const likes = m.like_count ?? insights['likes'] ?? 0
      const comments = m.comments_count ?? insights['comments'] ?? 0
      await prisma.metaMedia.upsert({
        where: { socialTokenId_igMediaId: { socialTokenId: connectionId, igMediaId: m.id } },
        create: {
          socialTokenId: connectionId,
          igMediaId: m.id,
          mediaType: m.media_type,
          caption: m.caption ?? null,
          permalink: m.permalink ?? null,
          thumbnailUrl: m.thumbnail_url ?? null,
          mediaUrl: m.media_url ?? null,
          postedAt: m.timestamp ? new Date(m.timestamp) : null,
          likeCount: likes,
          commentsCount: comments,
          reach: insights['reach'] ?? null,
          impressions: insights['impressions'] ?? insights['plays'] ?? null,
          engagement: insights['engagement'] ?? insights['total_interactions'] ?? null,
          saved: insights['saved'] ?? null,
          shares: insights['shares'] ?? null,
          lastSyncedAt: new Date(),
        },
        update: {
          caption: m.caption ?? null,
          permalink: m.permalink ?? null,
          thumbnailUrl: m.thumbnail_url ?? null,
          mediaUrl: m.media_url ?? null,
          postedAt: m.timestamp ? new Date(m.timestamp) : null,
          likeCount: likes,
          commentsCount: comments,
          reach: insights['reach'] ?? null,
          impressions: insights['impressions'] ?? insights['plays'] ?? null,
          engagement: insights['engagement'] ?? insights['total_interactions'] ?? null,
          saved: insights['saved'] ?? null,
          shares: insights['shares'] ?? null,
          lastSyncedAt: new Date(),
        },
      })
      result.media++
    }
  } catch (err) {
    return markFailed(connectionId, err, result)
  }

  // 3) Stories (short-lived 24h)
  try {
    const stories = await getIgStories(igId, pageAccessToken)
    for (const s of stories) {
      const insights = await getIgMediaInsights(s.id, 'STORY', pageAccessToken).catch(() => ({} as Record<string, number>))
      await prisma.metaMedia.upsert({
        where: { socialTokenId_igMediaId: { socialTokenId: connectionId, igMediaId: s.id } },
        create: {
          socialTokenId: connectionId,
          igMediaId: s.id,
          mediaType: 'STORY',
          caption: s.caption ?? null,
          permalink: s.permalink ?? null,
          thumbnailUrl: s.thumbnail_url ?? null,
          mediaUrl: s.media_url ?? null,
          postedAt: s.timestamp ? new Date(s.timestamp) : null,
          likeCount: 0,
          commentsCount: 0,
          reach: insights['reach'] ?? null,
          impressions: insights['impressions'] ?? null,
          storyExits: insights['exits'] ?? null,
          storyReplies: insights['replies'] ?? null,
          storyTapsForward: insights['taps_forward'] ?? null,
          storyTapsBack: insights['taps_back'] ?? null,
          lastSyncedAt: new Date(),
        },
        update: {
          caption: s.caption ?? null,
          permalink: s.permalink ?? null,
          thumbnailUrl: s.thumbnail_url ?? null,
          mediaUrl: s.media_url ?? null,
          postedAt: s.timestamp ? new Date(s.timestamp) : null,
          reach: insights['reach'] ?? null,
          impressions: insights['impressions'] ?? null,
          storyExits: insights['exits'] ?? null,
          storyReplies: insights['replies'] ?? null,
          storyTapsForward: insights['taps_forward'] ?? null,
          storyTapsBack: insights['taps_back'] ?? null,
          lastSyncedAt: new Date(),
        },
      })
      result.stories++
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.error('[meta-sync] stories fetch failed', err instanceof Error ? err.message : err)
  }

  // 4) Audience insights (only meaningful for creator flow accounts)
  if (token.tokenType === 'creator') {
    try {
      const audience = await getIgAudienceInsights(igId, pageAccessToken)
      await prisma.metaAudienceInsight.create({
        data: {
          socialTokenId: connectionId,
          genderAge: audience.audience_gender_age,
          country: audience.audience_country,
          city: audience.audience_city,
          locale: audience.audience_locale,
          onlineFollowers: audience.online_followers,
        },
      })
    } catch (err) {
      console.error('[meta-sync] audience insights failed', err instanceof Error ? err.message : err)
    }
  }

  // 5) Mentions (brand flow — find content that tagged the brand's IG account)
  if (token.tokenType === 'brand') {
    try {
      const tagged = await getTaggedMedia(igId, pageAccessToken, 25)
      for (const t of tagged) {
        try {
          await prisma.metaStoryMention.upsert({
            where: {
              socialTokenId_mentionMediaId: {
                socialTokenId: connectionId,
                mentionMediaId: t.id,
              },
            },
            create: {
              socialTokenId: connectionId,
              mentionMediaId: t.id,
              mentionUsername: t.username || 'unknown',
              mentionedAt: t.timestamp ? new Date(t.timestamp) : new Date(),
            },
            update: {
              mentionUsername: t.username || 'unknown',
              mentionedAt: t.timestamp ? new Date(t.timestamp) : new Date(),
            },
          })
          result.mentions++
        } catch {
          // ignore dup/race
        }
      }
    } catch (err) {
      console.error('[meta-sync] mentions fetch failed', err instanceof Error ? err.message : err)
    }
  }

  await prisma.socialToken.update({
    where: { id: connectionId },
    data: { lastUsedAt: new Date(), lastError: null },
  })

  result.success = true
  return result
}

async function markFailed(connectionId: string, err: unknown, result: SyncResult): Promise<SyncResult> {
  const msg = err instanceof Error ? err.message : 'unknown error'
  const isAuth = err instanceof MetaApiError && (err.status === 401 || err.status === 403 || err.status === 190)
  await prisma.socialToken.update({
    where: { id: connectionId },
    data: {
      lastError: msg.slice(0, 500),
      isValid: isAuth ? false : undefined,
    },
  })
  return { ...result, error: msg }
}

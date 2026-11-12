/**
 * Recognising the public URL of a publication (Instagram post/reel, TikTok
 * video/photo, YouTube video/short). Pure: no database, no network. Moved out
 * of /api/campaigns/[id]/media/manual so it can be tested and shared with the
 * short-link resolver (src/lib/resolve-short-url.ts).
 */
import type { MediaType } from '@/generated/prisma/client'

export type UrlPlatform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

export interface ParsedPostUrl {
  platform: UrlPlatform
  /** URL-derived id: IG shortcode, TikTok video id, YouTube video id, IG story id */
  externalId: string
  mediaType: MediaType
  /** Clean permalink (no query string / hash) */
  canonicalUrl: string
  /** Substring that identifies this post inside any permalink variant */
  permalinkNeedle: string
  /** Username embedded in the URL, when the platform includes it */
  ownerHint: string | null
  /** Instagram story: no Apify, date from the snowflake, metrics from the PM */
  isStory?: boolean
  /** Publication time decoded from the story id; null when it can't be trusted */
  postedAtHint?: Date | null
}

export function parsePostUrl(input: string): ParsedPostUrl | null {
  let url: URL
  try {
    const trimmed = input.trim()
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname

  // Instagram: /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}, optionally
  // prefixed by /{username}/ (newer share links)
  if (host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am') {
    const m = path.match(/^\/(?:([A-Za-z0-9_.]+)\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/)
    if (!m) return null
    const [, owner, kind, code] = m
    const isReel = kind !== 'p'
    return {
      platform: 'INSTAGRAM',
      externalId: code,
      mediaType: isReel ? 'REEL' : 'POST',
      canonicalUrl: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`,
      permalinkNeedle: `/${code}`,
      ownerHint: owner && !['p', 'reel', 'reels', 'tv'].includes(owner) ? owner : null,
    }
  }

  // TikTok: /@user/video/{id} or /@user/photo/{id}. Short links (vm.tiktok.com,
  // tiktok.com/t/...) carry no id: they are not parsed here. The caller resolves
  // them to the real link first (src/lib/resolve-short-url.ts).
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const m = path.match(/^\/(?:@([A-Za-z0-9_.]+)\/)?(video|photo)\/(\d+)\/?/)
    if (!m) return null
    const [, owner, kind, id] = m
    return {
      platform: 'TIKTOK',
      externalId: id,
      mediaType: kind === 'photo' ? 'POST' : 'VIDEO',
      canonicalUrl: owner
        ? `https://www.tiktok.com/@${owner}/${kind}/${id}`
        : `https://www.tiktok.com/${kind}/${id}`,
      permalinkNeedle: `/${kind}/${id}`,
      ownerHint: owner || null,
    }
  }

  // YouTube: watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    let id: string | null = null
    let isShort = false
    if (host === 'youtu.be') {
      id = path.slice(1).split('/')[0] || null
    } else if (path === '/watch') {
      id = url.searchParams.get('v')
    } else {
      const m = path.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]+)/)
      if (m) {
        id = m[2]
        isShort = m[1] === 'shorts'
      }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null
    return {
      platform: 'YOUTUBE',
      externalId: id,
      mediaType: isShort ? 'SHORT' : 'VIDEO',
      canonicalUrl: isShort
        ? `https://www.youtube.com/shorts/${id}`
        : `https://www.youtube.com/watch?v=${id}`,
      permalinkNeedle: id,
      ownerHint: null,
    }
  }

  return null
}

export const PLATFORM_LABEL: Record<UrlPlatform, string> = {
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
}


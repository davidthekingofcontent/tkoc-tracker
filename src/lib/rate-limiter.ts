/**
 * In-memory rate limiter using sliding window approach.
 * Each API has its own limiter with configurable max requests and window duration.
 */

interface RateLimitWindow {
  timestamps: number[]
  /** Window length of the last check, so idle buckets can be swept. */
  windowMs?: number
}

/** Above this many buckets, expired ones are swept before adding more. */
const MAX_BUCKETS = 5_000

class RateLimiter {
  private windows = new Map<string, RateLimitWindow>()

  /**
   * Check if a request can proceed without exceeding the rate limit.
   * @param key - Unique identifier for the rate limit bucket (e.g., "youtube", "instagram:user123")
   * @param maxRequests - Maximum number of requests allowed in the window
   * @param windowMs - Window duration in milliseconds
   * @returns true if the request can proceed
   */
  canProceed(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now()
    const window = this.windows.get(key) || { timestamps: [] }

    // Remove expired timestamps
    window.timestamps = window.timestamps.filter(t => t > now - windowMs)

    if (window.timestamps.length >= maxRequests) {
      return false
    }

    // Public endpoints key buckets on caller-supplied values: never let the
    // map grow without bound
    if (!this.windows.has(key) && this.windows.size >= MAX_BUCKETS) this.sweep(now)

    window.timestamps.push(now)
    window.windowMs = windowMs
    this.windows.set(key, window)
    return true
  }

  /** Drop every bucket whose newest request is older than its own window. */
  private sweep(now: number): void {
    for (const [k, w] of this.windows) {
      const newest = w.timestamps.length > 0 ? w.timestamps[w.timestamps.length - 1] : 0
      if (now - newest > (w.windowMs ?? 60 * 60 * 1000)) this.windows.delete(k)
    }
    // Still full of live buckets (a flood): start over rather than grow
    if (this.windows.size >= MAX_BUCKETS) this.windows.clear()
  }

  /**
   * Wait until a request can proceed, then proceed.
   * Will poll every second until the rate limit window opens.
   */
  async waitAndProceed(key: string, maxRequests: number, windowMs: number): Promise<void> {
    while (!this.canProceed(key, maxRequests, windowMs)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  /**
   * Get the number of remaining requests in the current window.
   */
  remaining(key: string, maxRequests: number, windowMs: number): number {
    const now = Date.now()
    const window = this.windows.get(key)
    if (!window) return maxRequests

    const active = window.timestamps.filter(t => t > now - windowMs).length
    return Math.max(0, maxRequests - active)
  }

  /**
   * Get milliseconds until the next request can be made.
   * Returns 0 if a request can be made immediately.
   */
  retryAfter(key: string, maxRequests: number, windowMs: number): number {
    const now = Date.now()
    const window = this.windows.get(key)
    if (!window) return 0

    const active = window.timestamps.filter(t => t > now - windowMs)
    if (active.length < maxRequests) return 0

    // Return time until the oldest timestamp expires
    const oldest = Math.min(...active)
    return Math.max(0, oldest + windowMs - now)
  }
}

// Singleton instance
const limiter = new RateLimiter()

// ============ PRE-CONFIGURED LIMITERS ============

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

/** YouTube Data API — 10,000 units/day (tracked separately via quota counter in youtube-api.ts) */
export function canCallYouTubeSearch(): boolean {
  // Search costs 100 units; limit to ~90 searches/day to leave room
  return limiter.canProceed('youtube:search', 90, 24 * HOUR)
}

/** Instagram Graph API — 240 req/user/hour */
export function canCallInstagramAPI(userId: string): boolean {
  return limiter.canProceed(`instagram:${userId}`, 240, HOUR)
}

/** Instagram Creator Marketplace API — 240 req/user/hour */
export function canCallMarketplaceAPI(userId: string): boolean {
  return limiter.canProceed(`marketplace:${userId}`, 240, HOUR)
}

/** Facebook Creator Discovery API — 2,000 req/user/hour */
export function canCallFBDiscoveryAPI(userId: string): boolean {
  return limiter.canProceed(`fb_discovery:${userId}`, 2000, HOUR)
}

/** YouTube Analytics API — be conservative: 100 req/hour per channel */
export function canCallYouTubeAnalytics(channelId: string): boolean {
  return limiter.canProceed(`yt_analytics:${channelId}`, 100, HOUR)
}

/**
 * Best-effort client address for rate limiting public endpoints. Behind the
 * Railway proxy the real address is in x-real-ip; the LAST x-forwarded-for hop
 * is the one the proxy appended (the first can be forged by the caller).
 */
export function clientIp(headers: Headers): string {
  const real = headers.get('x-real-ip')?.trim()
  if (real) return real
  const hops = (headers.get('x-forwarded-for') || '').split(',').map(h => h.trim()).filter(Boolean)
  return hops.length > 0 ? hops[hops.length - 1] : 'unknown'
}

/** Generic rate limit check */
export function canProceed(key: string, maxRequests: number, windowMs: number): boolean {
  return limiter.canProceed(key, maxRequests, windowMs)
}

/** Get remaining requests for a bucket */
export function getRemaining(key: string, maxRequests: number, windowMs: number): number {
  return limiter.remaining(key, maxRequests, windowMs)
}

/** Get retry-after time in ms */
export function getRetryAfter(key: string, maxRequests: number, windowMs: number): number {
  return limiter.retryAfter(key, maxRequests, windowMs)
}

// ============ ERROR CLASSIFICATION ============

export type ApiErrorType = 'RATE_LIMITED' | 'TOKEN_EXPIRED' | 'TOKEN_REVOKED' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'API_ERROR'

/**
 * Classify an API error response for proper handling
 */
export function classifyApiError(status: number, body?: string): ApiErrorType {
  if (status === 429) return 'RATE_LIMITED'
  if (status === 401) {
    if (body?.includes('expired')) return 'TOKEN_EXPIRED'
    if (body?.includes('revoked') || body?.includes('invalid_grant')) return 'TOKEN_REVOKED'
    return 'TOKEN_EXPIRED'
  }
  if (status === 403) {
    if (body?.includes('quota') || body?.includes('rateLimitExceeded')) return 'RATE_LIMITED'
    return 'PERMISSION_DENIED'
  }
  if (status === 404) return 'NOT_FOUND'
  return 'API_ERROR'
}

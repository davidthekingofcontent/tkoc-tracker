'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface SpainFitLinkProps {
  username: string
  platform: string
}

/**
 * Lightweight badge that checks if an influencer has a linked CreatorProfile
 * with Spain Fit data. Shows a small clickable badge that links to the creator profile page.
 * Used in campaign influencer tables and other lists.
 */
export function SpainFitLink({ username, platform }: SpainFitLinkProps) {
  const [data, setData] = useState<{ id: string; level: string; score: number } | null>(null)

  useEffect(() => {
    // Quick lookup via the search API
    const controller = new AbortController()
    fetch('/api/discovery/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: username,
        platform: platform.toUpperCase(),
        limit: 1,
      }),
      signal: controller.signal,
    })
      .then(r => r.ok ? r.json() : null)
      .then(res => {
        if (res?.results?.length > 0) {
          const creator = res.results[0]
          if (creator.username === username && creator.spainFitLevel && creator.spainFitLevel !== 'unknown') {
            setData({ id: creator.id, level: creator.spainFitLevel, score: creator.spainFitScore || 0 })
          }
        }
      })
      .catch(() => {})
    return () => controller.abort()
  }, [username, platform])

  if (!data) return null

  const config: Record<string, { emoji: string; className: string }> = {
    confirmed: { emoji: '\uD83C\uDDEA\uD83C\uDDF8', className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
    probable: { emoji: '\uD83D\uDFE1', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
    partial: { emoji: '\uD83D\uDFE0', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
    hispanic_global: { emoji: '\uD83C\uDF0E', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    latam: { emoji: '\uD83C\uDF0E', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  }

  const c = config[data.level]
  if (!c) return null

  return (
    <Link
      href={`/creators/${data.id}`}
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold hover:opacity-80 transition-opacity ${c.className}`}
      title={`Spain Fit: ${data.level} (${Math.round(data.score)}/100)`}
    >
      {c.emoji} Spain Fit
    </Link>
  )
}

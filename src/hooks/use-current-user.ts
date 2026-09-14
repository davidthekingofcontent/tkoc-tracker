'use client'

import { useState, useEffect } from 'react'

export interface CurrentUser {
  id: string
  email: string
  name: string
  role: string
}

/**
 * The signed-in user from /api/auth/me (the session, not localStorage — the
 * header avatar and the dashboard greeting were hard-coded / read a key
 * that is missing after a cookie-only login). Same fetch pattern as useRole.
 */
export function useCurrentUser(): { user: CurrentUser | null; loading: boolean } {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user?.id) setUser(d.user as CurrentUser)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { user, loading }
}

/** "David Calamardo" → "DC"; empty when there is no usable name. */
export function initialsOf(name: string | null | undefined): string {
  return (name || '')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

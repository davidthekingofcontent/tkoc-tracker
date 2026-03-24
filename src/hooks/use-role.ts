'use client'

import { useState, useEffect } from 'react'

type UserRole = 'ADMIN' | 'EMPLOYEE' | 'BRAND' | 'CREATOR' | ''

interface UseRoleReturn {
  role: UserRole
  isAdmin: boolean
  isEmployee: boolean
  isBrand: boolean
  canEdit: boolean
  loading: boolean
}

export function useRole(): UseRoleReturn {
  const [role, setRole] = useState<UserRole>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user?.role) {
          setRole(d.user.role as UserRole)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const isAdmin = role === 'ADMIN'
  const isEmployee = role === 'EMPLOYEE'
  const isBrand = role === 'BRAND'
  const canEdit = role === 'ADMIN' || role === 'EMPLOYEE'

  return { role, isAdmin, isEmployee, isBrand, canEdit, loading }
}

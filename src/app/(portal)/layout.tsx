'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Megaphone, Moon, Sun, LogOut, Building2 } from 'lucide-react'
import { useTheme } from '@/components/theme-provider'
import { proxyImg } from '@/lib/proxy-image'

// ---------------------------------------------------------------------------
// Brand portal layout — minimal client-facing chrome: NO agency sidebar.
// Simple top bar (<header>, hidden automatically by the report's print CSS)
// with the brand logo/name, the TKOC Intelligence wordmark, a theme toggle
// and a logout button (same cookie-clearing pattern as the sidebar).
// ---------------------------------------------------------------------------

function BrandLogo({ src, name }: { src?: string | null; name: string }) {
  const [error, setError] = useState(false)
  const url = src ? proxyImg(src) : ''
  if (!url || error) {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/40">
        <Building2 className="h-4 w-4 text-purple-600 dark:text-purple-400" />
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={name}
      className="h-8 w-8 shrink-0 rounded-lg bg-white object-contain dark:bg-gray-800"
      onError={() => setError(true)}
    />
  )
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { theme, toggleTheme } = useTheme()
  const [brandName, setBrandName] = useState<string>('')
  const [brandLogo, setBrandLogo] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/overview')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled || !data) return
        if (typeof data.brandName === 'string') setBrandName(data.brandName)
        if (typeof data.brandLogo === 'string' && data.brandLogo) setBrandLogo(data.brandLogo)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleLogout = () => {
    document.cookie = 'token=; path=/; max-age=0'
    localStorage.removeItem('user')
    router.push('/login')
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          {/* Brand identity */}
          <Link href="/portal" className="flex min-w-0 items-center gap-3">
            <BrandLogo src={brandLogo} name={brandName || 'Marca'} />
            <span className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">
              {brandName || 'Portal de cliente'}
            </span>
          </Link>

          {/* Wordmark + actions */}
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <span className="hidden text-sm font-bold tracking-tight text-gray-900 dark:text-gray-100 sm:inline">
              TKOC <span className="text-purple-600 dark:text-purple-400">Intelligence</span>
            </span>
            <span className="sm:hidden">
              <Megaphone className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            </span>
            <button
              onClick={toggleTheme}
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              onClick={handleLogout}
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              title="Cerrar sesión"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>

      <footer className="no-print border-t border-gray-200 py-4 text-center text-xs text-gray-400 dark:border-gray-800 dark:text-gray-500 print:hidden">
        Informe elaborado por TKOC Intelligence — The King of Content
      </footer>
    </div>
  )
}

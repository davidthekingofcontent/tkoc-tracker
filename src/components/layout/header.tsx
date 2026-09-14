"use client"

import { Search, User } from "lucide-react"
import { useI18n } from '@/i18n/context'
import { LanguageToggle } from '@/components/ui/language-toggle'
import { NotificationsBell } from '@/components/notifications-bell'
import { useCurrentUser, initialsOf } from '@/hooks/use-current-user'

export function Header() {
  const { t } = useI18n()
  const { user } = useCurrentUser()
  // Initials from the session user (was a hard-coded "DC"); email letter, then a generic icon, when there is no name
  const initials = initialsOf(user?.name) || (user?.email?.[0]?.toUpperCase() ?? '')

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      {/* Search Bar */}
      <div className="relative w-full max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder={t.nav.searchPlaceholder}
          className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-4 text-sm text-gray-900 placeholder-gray-400 outline-none transition-colors focus:border-purple-500 focus:bg-white focus:ring-1 focus:ring-purple-500"
        />
      </div>

      <div className="flex items-center gap-3">
        {/* Language Toggle */}
        <LanguageToggle />

        {/* Notifications: the real bell (unread count, list, mark as read) — the old one here was decorative */}
        <NotificationsBell placement="down" />

        {/* User Avatar */}
        <button
          className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-100 text-sm font-semibold text-purple-700 transition-colors hover:bg-purple-200"
          title={user?.name || user?.email || undefined}
          aria-label={user?.name || user?.email || undefined}
        >
          {initials || <User className="h-4 w-4" />}
        </button>
      </div>
    </header>
  )
}

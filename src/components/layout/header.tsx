"use client"

import { Search, Bell } from "lucide-react"
import { cn } from "@/lib/utils"
import { useI18n } from '@/i18n/context'
import { LanguageToggle } from '@/components/ui/language-toggle'

export function Header() {
  const { t } = useI18n()

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

        {/* Notification Bell */}
        <button className="relative flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700">
          <Bell className="h-4.5 w-4.5" />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-purple-600" />
        </button>

        {/* User Avatar */}
        <button className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-100 text-sm font-semibold text-purple-700 transition-colors hover:bg-purple-200">
          DC
        </button>
      </div>
    </header>
  )
}

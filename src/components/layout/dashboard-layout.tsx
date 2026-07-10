"use client"

import { useState, useEffect } from "react"
import { usePathname } from "next/navigation"
import { Menu, X } from "lucide-react"
import { Sidebar } from "./sidebar"
import { Header } from "./header"
import { AIChatWidget } from "@/components/ai-chat"
import { ViewModeProvider } from "@/components/view-mode-provider"

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const pathname = usePathname()

  // Close the drawer whenever the route changes (user tapped a nav link)
  useEffect(() => {
    setMobileNavOpen(false)
  }, [pathname])

  return (
    <ViewModeProvider>
      <div className="flex min-h-screen bg-gray-50 dark:bg-gray-950">
        {/* Desktop sidebar — hidden on mobile */}
        <div className="hidden lg:block">
          <Sidebar />
        </div>

        {/* Mobile drawer + overlay */}
        {mobileNavOpen && (
          <div className="lg:hidden">
            <div
              className="fixed inset-0 z-40 bg-black/50"
              onClick={() => setMobileNavOpen(false)}
            />
            <div className="fixed inset-y-0 left-0 z-50">
              <Sidebar />
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="absolute right-[-44px] top-3 z-50 rounded-lg bg-white dark:bg-gray-800 p-2 shadow-lg text-gray-600 dark:text-gray-300"
                aria-label="Cerrar menú"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        )}

        <div className="ml-0 lg:ml-[260px] flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar with hamburger */}
          <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 lg:hidden">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="rounded-lg p-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              aria-label="Abrir menú"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="text-base font-bold tracking-tight text-gray-900 dark:text-gray-100">
              TKOC <span className="text-purple-600 dark:text-purple-400">Intelligence</span>
            </span>
          </div>

          <Header />
          <main className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 p-4 sm:p-6">
            {children}
          </main>
        </div>
        <AIChatWidget />
      </div>
    </ViewModeProvider>
  )
}

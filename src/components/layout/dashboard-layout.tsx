"use client"

import { Sidebar } from "./sidebar"
import { Header } from "./header"
import { AIChatWidget } from "@/components/ai-chat"
import { ViewModeProvider } from "@/components/view-mode-provider"

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ViewModeProvider>
      <div className="flex min-h-screen bg-gray-50 dark:bg-gray-950">
        <Sidebar />
        <div className="ml-[260px] flex flex-1 flex-col">
          <Header />
          <main className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 p-6">
            {children}
          </main>
        </div>
        <AIChatWidget />
      </div>
    </ViewModeProvider>
  )
}

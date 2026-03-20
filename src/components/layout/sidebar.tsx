"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  LayoutDashboard,
  Megaphone,
  Search,
  Compass,
  List,
  Users,
  UserCheck,
  Settings,
  ChevronDown,
  ChevronRight,
  Pin,
  LogOut,
  BarChart3,
  Calendar,
  Building2,
  Moon,
  Sun,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { NotificationsBell } from '@/components/notifications-bell'
import { useI18n } from '@/i18n/context'
import { useTheme } from '@/components/theme-provider'

interface NavItem {
  key: string
  icon: typeof LayoutDashboard
  href: string
}

const navItems: NavItem[] = [
  { key: "home", icon: LayoutDashboard, href: "/dashboard" },
  { key: "campaigns", icon: Megaphone, href: "/campaigns" },
  { key: "analyzeProfiles", icon: Search, href: "/analyze" },
  { key: "findCreators", icon: Compass, href: "/discover" },
  { key: "lookalikes", icon: UserCheck, href: "/lookalikes" },
  { key: "lists", icon: List, href: "/lists" },
  { key: "contacts", icon: Users, href: "/contacts" },
  { key: "brands", icon: Building2, href: "/brands" },
  { key: "calendar", icon: Calendar, href: "/calendar" },
  { key: "compare", icon: BarChart3, href: "/compare" },
  { key: "settings", icon: Settings, href: "/settings" },
]

interface SidebarCampaign {
  id: string
  name: string
  status: string
}

interface SidebarList {
  id: string
  name: string
  _count: { items: number }
}

interface UserData {
  name: string
  email: string
  role: string
}

function getNavLabel(key: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (key) {
    case 'home': return t.nav.home
    case 'campaigns': return t.nav.campaigns
    case 'analyzeProfiles': return t.nav.analyzeProfiles
    case 'findCreators': return t.nav.findCreators
    case 'lookalikes': return t.nav.lookalikes
    case 'lists': return t.lists.title
    case 'contacts': return t.contacts.title
    case 'brands': return t.nav.brands
    case 'calendar': return t.nav.calendar
    case 'compare': return 'Comparar'
    case 'settings': return t.settings.title
    default: return key
  }
}

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { t } = useI18n()
  const { theme, toggleTheme } = useTheme()
  const [listsOpen, setListsOpen] = useState(true)
  const [campaignsOpen, setCampaignsOpen] = useState(true)
  const [campaigns, setCampaigns] = useState<SidebarCampaign[]>([])
  const [lists, setLists] = useState<SidebarList[]>([])
  const [user, setUser] = useState<UserData>({ name: 'User', email: '', role: 'ADMIN' })

  useEffect(() => {
    // Load user from localStorage
    try {
      const userData = localStorage.getItem('user')
      if (userData) {
        const parsed = JSON.parse(userData)
        setUser({
          name: parsed.name || 'User',
          email: parsed.email || '',
          role: parsed.role || 'ADMIN',
        })
      }
    } catch {}

    // Fetch recent campaigns
    fetch('/api/campaigns?limit=5')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.campaigns) {
          setCampaigns(data.campaigns.slice(0, 5).map((c: SidebarCampaign) => ({
            id: c.id,
            name: c.name,
            status: c.status,
          })))
        }
      })
      .catch(() => {})

    // Fetch lists
    fetch('/api/lists')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.lists) {
          setLists(data.lists.slice(0, 5))
        }
      })
      .catch(() => {})
  }, [])

  const handleLogout = () => {
    document.cookie = 'token=; path=/; max-age=0'
    localStorage.removeItem('user')
    router.push('/login')
  }

  const initials = user.name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-[260px] flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b border-gray-200 dark:border-gray-700 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/40">
          <Megaphone className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        </div>
        <span className="text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100">
          TKOC <span className="text-purple-600 dark:text-purple-400">Tracker</span>
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              (item.href === '/' && pathname === '/') ||
              (item.href !== '/' && (pathname === item.href || pathname?.startsWith(item.href + "/")))
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "border-l-2 border-purple-600 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                    : "border-l-2 border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
                )}
              >
                <item.icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isActive
                      ? "text-purple-600 dark:text-purple-400"
                      : "text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300"
                  )}
                />
                {getNavLabel(item.key, t)}
              </Link>
            )
          })}
        </div>

        {/* Lists */}
        {lists.length > 0 && (
          <div className="mt-6">
            <button
              onClick={() => setListsOpen(!listsOpen)}
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600"
            >
              <span>{t.lists.title}</span>
              {listsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
            <div
              className={cn(
                "space-y-0.5 overflow-hidden transition-all duration-200",
                listsOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
              )}
            >
              {lists.map((list) => (
                <Link
                  key={list.id}
                  href={`/lists/${list.id}`}
                  className="group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
                >
                  <Pin className="h-3.5 w-3.5 shrink-0 text-gray-400 group-hover:text-gray-500" />
                  <span className="truncate">{list.name}</span>
                  <span className="ml-auto text-xs text-gray-400">
                    {list._count?.items || 0}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Recent Campaigns */}
        {campaigns.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setCampaignsOpen(!campaignsOpen)}
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600"
            >
              <span>{t.nav.recentCampaigns}</span>
              {campaignsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
            <div
              className={cn(
                "space-y-0.5 overflow-hidden transition-all duration-200",
                campaignsOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
              )}
            >
              {campaigns.map((campaign) => (
                <Link
                  key={campaign.id}
                  href={`/campaigns/${campaign.id}`}
                  className="group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
                >
                  <Megaphone className="h-3.5 w-3.5 shrink-0 text-gray-400 group-hover:text-gray-500" />
                  <span className="truncate">{campaign.name}</span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                      campaign.status === "ACTIVE"
                        ? "bg-green-50 text-green-700"
                        : campaign.status === "PAUSED"
                          ? "bg-yellow-50 text-yellow-700"
                          : "bg-gray-100 text-gray-500"
                    )}
                  >
                    {campaign.status.toLowerCase()}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* User Profile */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-3">
        <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/40 text-sm font-semibold text-purple-700 dark:text-purple-300">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {user.name}
            </p>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">
              {user.email}
            </p>
          </div>
          <NotificationsBell />
          <button
            onClick={toggleTheme}
            className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            onClick={handleLogout}
            className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            title={t.auth.logout}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}

"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/utils"
import {
  Megaphone,
  UserSearch,
  Users,
  ListChecks,
  TrendingUp,
  Eye,
  BarChart3,
  Activity,
  ArrowUpRight,
  Clock,
  Loader2,
} from "lucide-react"

const quickActions = [
  {
    title: "Create Campaign",
    description: "Track influencer mentions and content performance",
    icon: Megaphone,
    href: "/campaigns/new",
  },
  {
    title: "Analyze Profile",
    description: "Look up any creator's stats and audience insights",
    icon: UserSearch,
    href: "/analyze",
  },
  {
    title: "Find Creators",
    description: "Discover influencers matching your criteria",
    icon: Users,
    href: "/discover",
  },
  {
    title: "Manage Lists",
    description: "Organize creators into custom lists",
    icon: ListChecks,
    href: "/lists",
  },
]

interface DashboardStats {
  activeCampaigns: number
  totalCampaigns: number
  totalInfluencers: number
  totalReach: number
  avgEngagementRate: number
}

interface RecentCampaign {
  id: string
  name: string
  status: string
  _count: { influencers: number; media: number }
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

export default function DashboardPage() {
  const [greeting, setGreeting] = useState("Good morning")
  const [userName, setUserName] = useState("there")
  const [isLoading, setIsLoading] = useState(true)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [recentCampaigns, setRecentCampaigns] = useState<RecentCampaign[]>([])

  useEffect(() => {
    setGreeting(getGreeting())

    // Get user name from localStorage
    try {
      const userData = localStorage.getItem('user')
      if (userData) {
        const user = JSON.parse(userData)
        setUserName(user.name?.split(' ')[0] || 'there')
      }
    } catch {}

    // Fetch dashboard stats
    async function fetchDashboard() {
      try {
        const res = await fetch('/api/dashboard')
        if (res.ok) {
          const data = await res.json()
          setStats(data.stats)
          setRecentCampaigns(data.recentCampaigns || [])
        }
      } catch (err) {
        console.error('Error fetching dashboard:', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchDashboard()
  }, [])

  const statCards = stats
    ? [
        { label: "Active Campaigns", value: stats.activeCampaigns, icon: Megaphone, format: "number" },
        { label: "Total Influencers", value: stats.totalInfluencers, icon: Users, format: "number" },
        { label: "Total Reach", value: stats.totalReach, icon: TrendingUp, format: "number" },
        { label: "Avg Engagement Rate", value: stats.avgEngagementRate, icon: BarChart3, format: "percent" },
      ]
    : []

  return (
    <div className="space-y-8">
      {/* Welcome Section */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">
          {greeting}, <span className="text-purple-600">{userName}</span>
        </h1>
        <p className="mt-1 text-gray-500">
          Here&apos;s what&apos;s happening with your campaigns today.
        </p>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {quickActions.map((action) => (
          <Link
            key={action.title}
            href={action.href}
            className={cn(
              "group rounded-xl border border-gray-200 bg-white p-5 shadow-sm",
              "transition-all hover:border-purple-300 hover:shadow-md"
            )}
          >
            <div className="flex items-start gap-4">
              <div className="rounded-lg bg-purple-50 p-2.5 text-purple-600 transition-colors group-hover:bg-purple-100">
                <action.icon className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900 group-hover:text-purple-600 transition-colors">
                  {action.title}
                </h3>
                <p className="mt-1 text-sm text-gray-500">{action.description}</p>
              </div>
              <ArrowUpRight className="h-4 w-4 text-gray-400 transition-colors group-hover:text-purple-600" />
            </div>
          </Link>
        ))}
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm animate-pulse">
                <div className="space-y-3">
                  <div className="h-4 w-24 rounded bg-gray-200" />
                  <div className="h-8 w-16 rounded bg-gray-200" />
                </div>
              </div>
            ))
          : statCards.map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">{stat.label}</span>
                  <stat.icon className="h-4 w-4 text-gray-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-gray-900">
                  {stat.format === "percent"
                    ? `${stat.value}%`
                    : formatNumber(stat.value)}
                </p>
              </div>
            ))}
      </div>

      {/* Recent Campaigns */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Activity className="h-5 w-5 text-purple-600" />
            Recent Campaigns
          </h2>
          <Link
            href="/campaigns"
            className="text-sm text-purple-600 hover:text-purple-500 transition-colors"
          >
            View all
          </Link>
        </div>
        <div className="divide-y divide-gray-200">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-6 py-4 animate-pulse">
                <div className="h-8 w-8 rounded-full bg-gray-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 rounded bg-gray-200" />
                  <div className="h-3 w-24 rounded bg-gray-200" />
                </div>
              </div>
            ))
          ) : recentCampaigns.length === 0 ? (
            <div className="px-6 py-12 text-center text-gray-500">
              No campaigns yet. Create your first campaign to get started.
            </div>
          ) : (
            recentCampaigns.map((campaign) => (
              <Link
                key={campaign.id}
                href={`/campaigns/${campaign.id}`}
                className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition-colors"
              >
                <div className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full",
                  campaign.status === 'ACTIVE' && "bg-purple-50 text-purple-600",
                  campaign.status === 'PAUSED' && "bg-yellow-50 text-yellow-600",
                  campaign.status === 'ARCHIVED' && "bg-gray-100 text-gray-500",
                )}>
                  <Megaphone className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{campaign.name}</p>
                  <p className="mt-0.5 flex items-center gap-3 text-xs text-gray-400">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {campaign._count.influencers} influencers
                    </span>
                    <span className="flex items-center gap-1">
                      <Eye className="h-3 w-3" />
                      {campaign._count.media} media
                    </span>
                  </p>
                </div>
                <span className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  campaign.status === 'ACTIVE' && "bg-green-50 text-green-700",
                  campaign.status === 'PAUSED' && "bg-yellow-50 text-yellow-700",
                  campaign.status === 'ARCHIVED' && "bg-gray-100 text-gray-500",
                )}>
                  {campaign.status.toLowerCase()}
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

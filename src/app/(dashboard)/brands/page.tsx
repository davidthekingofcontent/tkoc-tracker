"use client"

import { useState, useEffect, useMemo } from "react"
import { cn, formatNumber, formatCurrency } from "@/lib/utils"
import { useI18n } from "@/i18n/context"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Building2,
  Megaphone,
  DollarSign,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  BarChart3,
  Users,
  Eye,
  Heart,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react"

interface BrandCampaign {
  id: string
  name: string
  status: string
  type: string
  influencerCount: number
  mediaCount: number
  platforms: string[]
  startDate: string
  endDate: string | null
}

interface BrandData {
  brandName: string
  campaignCount: number
  totalInfluencers: number
  totalMedia: number
  totalReach: number
  totalEngagements: number
  totalViews: number
  totalCost: number
  totalEMV: number
  avgEngagementRate: number
  roi: number
  topPlatforms: string[]
  campaigns: BrandCampaign[]
}

interface Totals {
  totalBrands: number
  totalCampaigns: number
  totalSpend: number
  totalEMV: number
}

const platformColors: Record<string, string> = {
  INSTAGRAM: "bg-pink-50 text-pink-700 border-pink-200",
  TIKTOK: "bg-cyan-50 text-cyan-700 border-cyan-200",
  YOUTUBE: "bg-red-50 text-red-700 border-red-200",
}

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-yellow-50 text-yellow-700",
  ARCHIVED: "bg-gray-100 text-gray-500",
}

export default function BrandDashboardPage() {
  const { t, locale } = useI18n()
  const [brands, setBrands] = useState<BrandData[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [expandedBrand, setExpandedBrand] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<"emv" | "campaigns" | "spend" | "reach">("emv")

  const labels = useMemo(() => {
    if (locale === "es") {
      return {
        title: "Dashboard por Marca",
        subtitle: "Analiza el rendimiento de tus campanas agrupadas por marca",
        totalBrands: "Total Marcas",
        totalCampaigns: "Total Campanas",
        totalSpend: "Inversion Total",
        totalEMV: "EMV Total",
        brand: "Marca",
        campaigns: "Campanas",
        influencers: "Influencers",
        media: "Media",
        reach: "Alcance",
        engagements: "Interacciones",
        views: "Vistas",
        cost: "Coste",
        emv: "EMV",
        engRate: "Tasa Eng.",
        roi: "ROI",
        platforms: "Plataformas",
        noBrands: "Sin marcas todavia",
        noBrandsDesc: "Crea campanas con cuentas objetivo para ver el dashboard por marca.",
        sortBy: "Ordenar por",
        emvLabel: "EMV",
        campaignsLabel: "Campanas",
        spendLabel: "Inversion",
        reachLabel: "Alcance",
        brandComparison: "Comparativa de Marcas por EMV",
        campaignName: "Nombre de Campana",
        status: "Estado",
        type: "Tipo",
        startDate: "Inicio",
        endDate: "Fin",
        noEndDate: "Sin fin",
      }
    }
    return {
      title: "Brand Dashboard",
      subtitle: "Analyze campaign performance grouped by brand",
      totalBrands: "Total Brands",
      totalCampaigns: "Total Campaigns",
      totalSpend: "Total Spend",
      totalEMV: "Total EMV",
      brand: "Brand",
      campaigns: "Campaigns",
      influencers: "Influencers",
      media: "Media",
      reach: "Reach",
      engagements: "Engagements",
      views: "Views",
      cost: "Cost",
      emv: "EMV",
      engRate: "Eng. Rate",
      roi: "ROI",
      platforms: "Platforms",
      noBrands: "No brands yet",
      noBrandsDesc: "Create campaigns with target accounts to see the brand dashboard.",
      sortBy: "Sort by",
      emvLabel: "EMV",
      campaignsLabel: "Campaigns",
      spendLabel: "Spend",
      reachLabel: "Reach",
      brandComparison: "Brand Comparison by EMV",
      campaignName: "Campaign Name",
      status: "Status",
      type: "Type",
      startDate: "Start",
      endDate: "End",
      noEndDate: "No end date",
    }
  }, [locale])

  useEffect(() => {
    async function fetchBrands() {
      try {
        const res = await fetch("/api/dashboard/brands")
        if (res.ok) {
          const data = await res.json()
          setBrands(data.brands || [])
          setTotals(data.totals || null)
        }
      } catch (err) {
        console.error("Error fetching brand dashboard:", err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchBrands()
  }, [])

  const sortedBrands = useMemo(() => {
    const sorted = [...brands]
    switch (sortBy) {
      case "emv":
        sorted.sort((a, b) => b.totalEMV - a.totalEMV)
        break
      case "campaigns":
        sorted.sort((a, b) => b.campaignCount - a.campaignCount)
        break
      case "spend":
        sorted.sort((a, b) => b.totalCost - a.totalCost)
        break
      case "reach":
        sorted.sort((a, b) => b.totalReach - a.totalReach)
        break
    }
    return sorted
  }, [brands, sortBy])

  // Find the max EMV for bar chart scaling
  const maxEMV = useMemo(() => {
    if (brands.length === 0) return 1
    return Math.max(...brands.map((b) => b.totalEMV), 1)
  }, [brands])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          {labels.title}
        </h1>
        <p className="mt-1 text-gray-500 dark:text-gray-400">
          {labels.subtitle}
        </p>
      </div>

      {/* Overview Cards */}
      {totals && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: labels.totalBrands,
              value: totals.totalBrands.toString(),
              icon: Building2,
              color: "text-purple-600",
              bg: "bg-purple-50 dark:bg-purple-900/30",
            },
            {
              label: labels.totalCampaigns,
              value: totals.totalCampaigns.toString(),
              icon: Megaphone,
              color: "text-blue-600",
              bg: "bg-blue-50 dark:bg-blue-900/30",
            },
            {
              label: labels.totalSpend,
              value: formatCurrency(totals.totalSpend),
              icon: DollarSign,
              color: "text-orange-600",
              bg: "bg-orange-50 dark:bg-orange-900/30",
            },
            {
              label: labels.totalEMV,
              value: formatCurrency(totals.totalEMV),
              icon: TrendingUp,
              color: "text-green-600",
              bg: "bg-green-50 dark:bg-green-900/30",
            },
          ].map((card) => (
            <Card key={card.label} variant="elevated" className="dark:bg-gray-800 dark:border-gray-700">
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">{card.label}</span>
                  <div className={cn("rounded-lg p-2", card.bg)}>
                    <card.icon className={cn("h-4 w-4", card.color)} />
                  </div>
                </div>
                <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {card.value}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {brands.length === 0 ? (
        <Card variant="elevated" className="dark:bg-gray-800 dark:border-gray-700">
          <CardContent>
            <div className="py-12 text-center">
              <Building2 className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
              <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
                {labels.noBrands}
              </h3>
              <p className="mt-2 text-gray-500 dark:text-gray-400">
                {labels.noBrandsDesc}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* EMV Bar Chart */}
          <Card variant="elevated" className="dark:bg-gray-800 dark:border-gray-700">
            <CardContent>
              <h2 className="mb-6 text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-purple-600" />
                {labels.brandComparison}
              </h2>
              <div className="space-y-3">
                {sortedBrands.slice(0, 10).map((brand, index) => {
                  const percentage = maxEMV > 0 ? (brand.totalEMV / maxEMV) * 100 : 0
                  return (
                    <div key={brand.brandName} className="flex items-center gap-3">
                      <span className="w-6 text-right text-xs font-medium text-gray-400 dark:text-gray-500">
                        {index + 1}
                      </span>
                      <span className="w-28 truncate text-sm font-medium text-gray-700 dark:text-gray-300">
                        {brand.brandName}
                      </span>
                      <div className="flex-1">
                        <div className="h-7 w-full rounded-lg bg-gray-100 dark:bg-gray-700 overflow-hidden">
                          <div
                            className="h-full rounded-lg bg-gradient-to-r from-purple-500 to-purple-600 transition-all duration-500 flex items-center justify-end pr-2"
                            style={{ width: `${Math.max(percentage, 3)}%` }}
                          >
                            {percentage > 20 && (
                              <span className="text-xs font-medium text-white">
                                {formatCurrency(brand.totalEMV)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {percentage <= 20 && (
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                          {formatCurrency(brand.totalEMV)}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Sort Controls */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">{labels.sortBy}:</span>
            {(["emv", "campaigns", "spend", "reach"] as const).map((key) => (
              <Button
                key={key}
                variant={sortBy === key ? "primary" : "secondary"}
                size="sm"
                onClick={() => setSortBy(key)}
                className={cn(
                  sortBy === key
                    ? "bg-purple-600 text-white hover:bg-purple-700"
                    : "text-gray-600 dark:text-gray-400"
                )}
              >
                {labels[`${key}Label` as keyof typeof labels] || key}
              </Button>
            ))}
          </div>

          {/* Brand Table/Grid */}
          <div className="space-y-3">
            {sortedBrands.map((brand) => {
              const isExpanded = expandedBrand === brand.brandName
              return (
                <Card
                  key={brand.brandName}
                  variant="elevated"
                  className={cn(
                    "transition-all dark:bg-gray-800 dark:border-gray-700",
                    isExpanded && "ring-2 ring-purple-200 dark:ring-purple-800"
                  )}
                >
                  <CardContent>
                    {/* Brand Row */}
                    <button
                      onClick={() =>
                        setExpandedBrand(isExpanded ? null : brand.brandName)
                      }
                      className="w-full text-left"
                    >
                      <div className="flex items-center gap-4">
                        {/* Brand Icon */}
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/40">
                          <Building2 className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                        </div>

                        {/* Brand Name + Platforms */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
                              {brand.brandName}
                            </h3>
                            <div className="flex gap-1">
                              {brand.topPlatforms.map((p) => (
                                <Badge
                                  key={p}
                                  variant={p.toLowerCase() as "instagram" | "tiktok" | "youtube"}
                                  className="text-[10px]"
                                >
                                  {p}
                                </Badge>
                              ))}
                            </div>
                          </div>
                          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                            {brand.campaignCount} {labels.campaigns.toLowerCase()} &middot;{" "}
                            {brand.totalInfluencers} {labels.influencers.toLowerCase()} &middot;{" "}
                            {brand.totalMedia} {labels.media.toLowerCase()}
                          </p>
                        </div>

                        {/* Key Metrics */}
                        <div className="hidden lg:flex items-center gap-6">
                          <div className="text-right">
                            <p className="text-xs text-gray-400 dark:text-gray-500">{labels.reach}</p>
                            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                              {formatNumber(brand.totalReach)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-400 dark:text-gray-500">{labels.engRate}</p>
                            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                              {brand.avgEngagementRate}%
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-400 dark:text-gray-500">{labels.cost}</p>
                            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                              {formatCurrency(brand.totalCost)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-400 dark:text-gray-500">{labels.emv}</p>
                            <p className="text-sm font-semibold text-purple-600 dark:text-purple-400">
                              {formatCurrency(brand.totalEMV)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-400 dark:text-gray-500">{labels.roi}</p>
                            <p
                              className={cn(
                                "flex items-center gap-0.5 text-sm font-semibold",
                                brand.roi >= 0
                                  ? "text-green-600 dark:text-green-400"
                                  : "text-red-600 dark:text-red-400"
                              )}
                            >
                              {brand.roi >= 0 ? (
                                <ArrowUpRight className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowDownRight className="h-3.5 w-3.5" />
                              )}
                              {brand.roi}%
                            </p>
                          </div>
                        </div>

                        {/* Expand Icon */}
                        <div className="shrink-0 text-gray-400">
                          {isExpanded ? (
                            <ChevronDown className="h-5 w-5" />
                          ) : (
                            <ChevronRight className="h-5 w-5" />
                          )}
                        </div>
                      </div>

                      {/* Mobile Metrics */}
                      <div className="mt-3 grid grid-cols-3 gap-3 lg:hidden">
                        <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 p-2 text-center">
                          <p className="text-[10px] text-gray-400">{labels.reach}</p>
                          <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                            {formatNumber(brand.totalReach)}
                          </p>
                        </div>
                        <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 p-2 text-center">
                          <p className="text-[10px] text-gray-400">{labels.emv}</p>
                          <p className="text-xs font-semibold text-purple-600">
                            {formatCurrency(brand.totalEMV)}
                          </p>
                        </div>
                        <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 p-2 text-center">
                          <p className="text-[10px] text-gray-400">{labels.roi}</p>
                          <p
                            className={cn(
                              "text-xs font-semibold",
                              brand.roi >= 0 ? "text-green-600" : "text-red-600"
                            )}
                          >
                            {brand.roi}%
                          </p>
                        </div>
                      </div>
                    </button>

                    {/* Expanded: Campaign List */}
                    {isExpanded && (
                      <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
                        {/* Detail metrics row */}
                        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <div className="rounded-lg bg-purple-50 dark:bg-purple-900/20 p-3">
                            <div className="flex items-center gap-1.5">
                              <Eye className="h-3.5 w-3.5 text-purple-500" />
                              <span className="text-xs text-purple-600 dark:text-purple-400">
                                {labels.views}
                              </span>
                            </div>
                            <p className="mt-1 text-lg font-bold text-purple-700 dark:text-purple-300">
                              {formatNumber(brand.totalViews)}
                            </p>
                          </div>
                          <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 p-3">
                            <div className="flex items-center gap-1.5">
                              <Heart className="h-3.5 w-3.5 text-blue-500" />
                              <span className="text-xs text-blue-600 dark:text-blue-400">
                                {labels.engagements}
                              </span>
                            </div>
                            <p className="mt-1 text-lg font-bold text-blue-700 dark:text-blue-300">
                              {formatNumber(brand.totalEngagements)}
                            </p>
                          </div>
                          <div className="rounded-lg bg-green-50 dark:bg-green-900/20 p-3">
                            <div className="flex items-center gap-1.5">
                              <Users className="h-3.5 w-3.5 text-green-500" />
                              <span className="text-xs text-green-600 dark:text-green-400">
                                {labels.influencers}
                              </span>
                            </div>
                            <p className="mt-1 text-lg font-bold text-green-700 dark:text-green-300">
                              {brand.totalInfluencers}
                            </p>
                          </div>
                          <div className="rounded-lg bg-orange-50 dark:bg-orange-900/20 p-3">
                            <div className="flex items-center gap-1.5">
                              <DollarSign className="h-3.5 w-3.5 text-orange-500" />
                              <span className="text-xs text-orange-600 dark:text-orange-400">
                                {labels.cost}
                              </span>
                            </div>
                            <p className="mt-1 text-lg font-bold text-orange-700 dark:text-orange-300">
                              {formatCurrency(brand.totalCost)}
                            </p>
                          </div>
                        </div>

                        {/* Campaign table */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-gray-200 dark:border-gray-700">
                                <th className="pb-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                                  {labels.campaignName}
                                </th>
                                <th className="pb-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                                  {labels.status}
                                </th>
                                <th className="pb-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400">
                                  {labels.influencers}
                                </th>
                                <th className="pb-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400">
                                  {labels.media}
                                </th>
                                <th className="pb-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                                  {labels.platforms}
                                </th>
                                <th className="pb-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                                  {labels.startDate}
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                              {brand.campaigns.map((campaign) => (
                                <tr
                                  key={campaign.id}
                                  className="hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer transition-colors"
                                  onClick={() => {
                                    window.location.href = `/campaigns/${campaign.id}`
                                  }}
                                >
                                  <td className="py-2.5 pr-4">
                                    <span className="font-medium text-gray-900 dark:text-gray-100">
                                      {campaign.name}
                                    </span>
                                  </td>
                                  <td className="py-2.5 pr-4">
                                    <span
                                      className={cn(
                                        "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
                                        statusColors[campaign.status] || "bg-gray-100 text-gray-500"
                                      )}
                                    >
                                      {campaign.status.toLowerCase()}
                                    </span>
                                  </td>
                                  <td className="py-2.5 text-center text-gray-600 dark:text-gray-400">
                                    {campaign.influencerCount}
                                  </td>
                                  <td className="py-2.5 text-center text-gray-600 dark:text-gray-400">
                                    {campaign.mediaCount}
                                  </td>
                                  <td className="py-2.5 pr-4">
                                    <div className="flex gap-1">
                                      {campaign.platforms.map((p) => (
                                        <span
                                          key={p}
                                          className={cn(
                                            "inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                            platformColors[p] || "bg-gray-50 text-gray-500"
                                          )}
                                        >
                                          {p.slice(0, 2)}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="py-2.5 text-gray-500 dark:text-gray-400 text-xs">
                                    {new Date(campaign.startDate).toLocaleDateString(
                                      locale === "es" ? "es-ES" : "en-US",
                                      { month: "short", day: "numeric", year: "numeric" }
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

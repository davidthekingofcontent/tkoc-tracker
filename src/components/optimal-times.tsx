'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import { formatNumber } from '@/lib/utils'
import { Clock, Calendar, Loader2, BarChart3 } from 'lucide-react'

interface OptimalTimesProps {
  influencerId: string
}

interface OptimalTimesData {
  bestDays: { day: string; avgEngagement: number }[]
  bestHours: { hour: number; avgEngagement: number }[]
  bestSlots: { day: string; hour: number; avgEngagement: number }[]
  heatmap: { day: number; hour: number; posts: number; avgEngagement: number }[]
}

const DAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LABELS_ES = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab']

const DAY_FULL_EN: Record<string, string> = {
  Sunday: 'Sunday', Monday: 'Monday', Tuesday: 'Tuesday', Wednesday: 'Wednesday',
  Thursday: 'Thursday', Friday: 'Friday', Saturday: 'Saturday',
}
const DAY_FULL_ES: Record<string, string> = {
  Sunday: 'Domingo', Monday: 'Lunes', Tuesday: 'Martes', Wednesday: 'Miercoles',
  Thursday: 'Jueves', Friday: 'Viernes', Saturday: 'Sabado',
}

export function OptimalTimes({ influencerId }: OptimalTimesProps) {
  const { t, locale } = useI18n()
  const [data, setData] = useState<OptimalTimesData | null>(null)
  const [loading, setLoading] = useState(true)

  const dayLabels = locale === 'es' ? DAY_LABELS_ES : DAY_LABELS_EN
  const dayFull = locale === 'es' ? DAY_FULL_ES : DAY_FULL_EN

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true)
        const res = await fetch(`/api/influencers/${influencerId}/optimal-times`)
        if (res.ok) {
          const json = await res.json()
          setData(json)
        }
      } catch (err) {
        console.error('Error fetching optimal times:', err)
      } finally {
        setLoading(false)
      }
    }
    if (influencerId) fetchData()
  }, [influencerId])

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
        <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>{t.common.loading}</span>
        </div>
      </div>
    )
  }

  if (!data || data.heatmap.length === 0) {
    return null
  }

  // Build heatmap grid
  const maxEngagement = Math.max(...data.heatmap.map(h => h.avgEngagement), 1)

  function getColor(engagement: number): string {
    if (engagement === 0) return 'bg-gray-50'
    const intensity = engagement / maxEngagement
    if (intensity > 0.75) return 'bg-purple-500'
    if (intensity > 0.5) return 'bg-purple-400'
    if (intensity > 0.25) return 'bg-purple-200'
    return 'bg-purple-100'
  }

  function getTextColor(engagement: number): string {
    const intensity = engagement / maxEngagement
    return intensity > 0.5 ? 'text-white' : 'text-gray-600'
  }

  // Build a lookup map for heatmap
  const heatmapLookup = new Map<string, { posts: number; avgEngagement: number }>()
  for (const h of data.heatmap) {
    heatmapLookup.set(`${h.day}-${h.hour}`, { posts: h.posts, avgEngagement: h.avgEngagement })
  }

  // Calculate posting frequency
  const totalPosts = data.heatmap.reduce((sum, h) => sum + h.posts, 0)
  const activeDays = new Set(data.heatmap.map(h => h.day))
  const topDays = data.bestDays.slice(0, 3).map(d => dayFull[d.day] || d.day)

  // Display hours: only show a subset for compactness (every 3 hours)
  const displayHours = [0, 3, 6, 9, 12, 15, 18, 21]

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6 space-y-5">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-50">
          <Clock className="h-4 w-4 text-purple-600" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900">
          {locale === 'es' ? 'Mejores Horarios de Publicacion' : 'Optimal Posting Times'}
        </h3>
      </div>

      {/* Top 3 recommended slots */}
      {data.bestSlots.length > 0 && (
        <div className="space-y-2">
          {data.bestSlots.slice(0, 3).map((slot, idx) => (
            <div
              key={idx}
              className="flex items-center gap-3 rounded-lg bg-purple-50 px-3 py-2"
            >
              <Calendar className="h-4 w-4 text-purple-500 shrink-0" />
              <span className="text-sm text-gray-700">
                {dayFull[slot.day] || slot.day}{' '}
                {locale === 'es' ? 'a las' : 'at'}{' '}
                {slot.hour.toString().padStart(2, '0')}:00
              </span>
              <span className="ml-auto text-xs font-medium text-purple-600">
                {locale === 'es' ? 'Eng. medio' : 'Avg eng.'}: {formatNumber(slot.avgEngagement)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Heatmap */}
      <div className="overflow-x-auto">
        <div className="min-w-[400px]">
          {/* Header row with hours */}
          <div className="flex items-center gap-0.5 mb-0.5">
            <div className="w-10 shrink-0" />
            {displayHours.map(h => (
              <div key={h} className="flex-1 text-center text-[10px] text-gray-400 font-medium">
                {h.toString().padStart(2, '0')}
              </div>
            ))}
          </div>
          {/* Rows for each day */}
          {[1, 2, 3, 4, 5, 6, 0].map(dayIdx => {
            return (
              <div key={dayIdx} className="flex items-center gap-0.5 mb-0.5">
                <div className="w-10 shrink-0 text-[10px] text-gray-500 font-medium text-right pr-1">
                  {dayLabels[dayIdx]}
                </div>
                {displayHours.map(hour => {
                  const cell = heatmapLookup.get(`${dayIdx}-${hour}`)
                  const engagement = cell?.avgEngagement ?? 0
                  return (
                    <div
                      key={hour}
                      className={`flex-1 aspect-square rounded-sm ${getColor(engagement)} flex items-center justify-center cursor-default transition-colors`}
                      title={`${dayLabels[dayIdx]} ${hour}:00 — ${cell ? `${cell.posts} posts, avg eng: ${formatNumber(engagement)}` : 'No data'}`}
                    >
                      {cell && cell.posts > 0 && (
                        <span className={`text-[8px] font-medium ${getTextColor(engagement)}`}>
                          {cell.posts}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
          {/* Legend */}
          <div className="flex items-center gap-2 mt-2 justify-end">
            <span className="text-[10px] text-gray-400">{locale === 'es' ? 'Bajo' : 'Low'}</span>
            <div className="flex gap-0.5">
              <div className="w-3 h-3 rounded-sm bg-gray-50 border border-gray-200" />
              <div className="w-3 h-3 rounded-sm bg-purple-100" />
              <div className="w-3 h-3 rounded-sm bg-purple-200" />
              <div className="w-3 h-3 rounded-sm bg-purple-400" />
              <div className="w-3 h-3 rounded-sm bg-purple-500" />
            </div>
            <span className="text-[10px] text-gray-400">{locale === 'es' ? 'Alto' : 'High'}</span>
          </div>
        </div>
      </div>

      {/* Posting frequency summary */}
      <div className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2">
        <BarChart3 className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
        <p className="text-xs text-gray-600">
          {locale === 'es'
            ? `Este creador publica ~${totalPosts} veces, principalmente los ${topDays.join(', ')}`
            : `This creator posts ~${totalPosts} times, mainly on ${topDays.join(', ')}`
          }
          {activeDays.size > 0 && (
            <span className="text-gray-400">
              {' '}({locale === 'es' ? `activo ${activeDays.size} dias/semana` : `active ${activeDays.size} days/week`})
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import Link from "next/link"
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Users,
  ExternalLink,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n/context"

interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  type: string
  status: string
  color: string
  influencerCount: number
}

interface TooltipState {
  event: CalendarEvent
  x: number
  y: number
}

function getTypeLabel(type: string, locale: string): string {
  const labels: Record<string, Record<string, string>> = {
    SOCIAL_LISTENING: { en: "Social Listening", es: "Social Listening" },
    INFLUENCER_TRACKING: {
      en: "Influencer Tracking",
      es: "Seguimiento de Influencers",
    },
    UGC: { en: "UGC", es: "UGC" },
  }
  return labels[type]?.[locale] || type
}

function getStatusLabel(status: string, locale: string): string {
  const labels: Record<string, Record<string, string>> = {
    ACTIVE: { en: "Active", es: "Activa" },
    PAUSED: { en: "Paused", es: "Pausada" },
    ARCHIVED: { en: "Archived", es: "Archivada" },
  }
  return labels[status]?.[locale] || status
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year: number, month: number): number {
  // Returns 0=Mon, 1=Tue, ..., 6=Sun
  const day = new Date(year, month, 1).getDay()
  return day === 0 ? 6 : day - 1
}

const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const MONTH_NAMES_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
]

const DAY_NAMES_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const DAY_NAMES_ES = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"]

export default function CalendarPage() {
  const { t, locale } = useI18n()
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  const monthNames = locale === "es" ? MONTH_NAMES_ES : MONTH_NAMES_EN
  const dayNames = locale === "es" ? DAY_NAMES_ES : DAY_NAMES_EN

  const calendarText = useMemo(() => {
    if (locale === "es") {
      return {
        title: "Calendario",
        subtitle: "Vista mensual de tus campanas",
        today: "Hoy",
        noEvents: "Sin eventos este mes",
        influencers: "influencers",
        viewCampaign: "Ver campana",
        type: "Tipo",
        status: "Estado",
      }
    }
    return {
      title: "Calendar",
      subtitle: "Monthly view of your campaigns",
      today: "Today",
      noEvents: "No events this month",
      influencers: "influencers",
      viewCampaign: "View campaign",
      type: "Type",
      status: "Status",
    }
  }, [locale])

  useEffect(() => {
    setLoading(true)
    fetch("/api/calendar")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.events) {
          setEvents(data.events)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Close tooltip on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        tooltipRef.current &&
        !tooltipRef.current.contains(e.target as Node)
      ) {
        setTooltip(null)
      }
    }
    if (tooltip) {
      document.addEventListener("mousedown", handleClick)
      return () => document.removeEventListener("mousedown", handleClick)
    }
  }, [tooltip])

  const goToPrevMonth = useCallback(() => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
    setTooltip(null)
  }, [])

  const goToNextMonth = useCallback(() => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
    setTooltip(null)
  }, [])

  const goToToday = useCallback(() => {
    setCurrentDate(new Date())
    setTooltip(null)
  }, [])

  // Build grid
  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)
  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7

  const cells: Array<{ day: number | null; date: Date | null }> = []
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - firstDay + 1
    if (dayNum < 1 || dayNum > daysInMonth) {
      cells.push({ day: null, date: null })
    } else {
      cells.push({ day: dayNum, date: new Date(year, month, dayNum) })
    }
  }

  const today = new Date()
  const isToday = (day: number | null) =>
    day !== null &&
    today.getFullYear() === year &&
    today.getMonth() === month &&
    today.getDate() === day

  // Determine which events overlap a given day
  function getEventsForDay(day: number): CalendarEvent[] {
    const dayStart = new Date(year, month, day)
    const dayEnd = new Date(year, month, day, 23, 59, 59, 999)
    return events.filter((ev) => {
      const evStart = new Date(ev.start)
      const evEnd = new Date(ev.end)
      return evStart <= dayEnd && evEnd >= dayStart
    })
  }

  // Determine bar rendering info for an event on a given day
  function getBarInfo(
    event: CalendarEvent,
    day: number,
    cellIndex: number
  ): {
    isStart: boolean
    isEnd: boolean
    isStartOfRow: boolean
    isEndOfRow: boolean
  } {
    const evStart = new Date(event.start)
    const evEnd = new Date(event.end)
    const cellDate = new Date(year, month, day)

    const isStart =
      evStart.getFullYear() === cellDate.getFullYear() &&
      evStart.getMonth() === cellDate.getMonth() &&
      evStart.getDate() === cellDate.getDate()

    const isEnd =
      evEnd.getFullYear() === cellDate.getFullYear() &&
      evEnd.getMonth() === cellDate.getMonth() &&
      evEnd.getDate() === cellDate.getDate()

    const colIndex = cellIndex % 7
    const isStartOfRow = colIndex === 0
    const isEndOfRow = colIndex === 6

    return { isStart, isEnd, isStartOfRow, isEndOfRow }
  }

  function handleEventClick(event: CalendarEvent, e: React.MouseEvent) {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setTooltip({
      event,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8,
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {calendarText.title}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {calendarText.subtitle}
          </p>
        </div>
      </div>

      {/* Calendar Card */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
        {/* Month Navigation */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div className="flex items-center gap-4">
            <button
              onClick={goToPrevMonth}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 min-w-[200px] text-center">
              {monthNames[month]} {year}
            </h2>
            <button
              onClick={goToNextMonth}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={goToToday}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            {calendarText.today}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-32">
            <div className="flex items-center gap-3 text-gray-500">
              <CalendarIcon className="h-5 w-5 animate-pulse" />
              <span>{t.common.loading}</span>
            </div>
          </div>
        ) : (
          <div className="p-4">
            {/* Day headers */}
            <div className="grid grid-cols-7 mb-1">
              {dayNames.map((name) => (
                <div
                  key={name}
                  className="py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
                >
                  {name}
                </div>
              ))}
            </div>

            {/* Calendar grid */}
            <div className="grid grid-cols-7 border-t border-l border-gray-200 dark:border-gray-700">
              {cells.map((cell, idx) => {
                const dayEvents = cell.day ? getEventsForDay(cell.day) : []
                return (
                  <div
                    key={idx}
                    className={cn(
                      "relative min-h-[100px] border-r border-b border-gray-200 dark:border-gray-700 p-1.5",
                      cell.day === null &&
                        "bg-gray-50 dark:bg-gray-800/50",
                      isToday(cell.day) && "bg-purple-50/50 dark:bg-purple-900/10"
                    )}
                  >
                    {cell.day !== null && (
                      <>
                        <span
                          className={cn(
                            "inline-flex h-7 w-7 items-center justify-center rounded-full text-sm",
                            isToday(cell.day)
                              ? "bg-purple-600 text-white font-semibold"
                              : "text-gray-700 dark:text-gray-300"
                          )}
                        >
                          {cell.day}
                        </span>

                        {/* Event bars */}
                        <div className="mt-1 space-y-0.5">
                          {dayEvents.slice(0, 3).map((ev) => {
                            const info = getBarInfo(ev, cell.day!, idx)
                            return (
                              <button
                                key={ev.id}
                                onClick={(e) => handleEventClick(ev, e)}
                                className={cn(
                                  "block w-full text-left text-[11px] font-medium text-white px-1.5 py-0.5 truncate transition-opacity hover:opacity-80",
                                  info.isStart || info.isStartOfRow
                                    ? "rounded-l-md"
                                    : "",
                                  info.isEnd || info.isEndOfRow
                                    ? "rounded-r-md"
                                    : ""
                                )}
                                style={{ backgroundColor: ev.color }}
                                title={ev.title}
                              >
                                {(info.isStart || info.isStartOfRow) && ev.title}
                              </button>
                            )
                          })}
                          {dayEvents.length > 3 && (
                            <span className="block text-[10px] text-gray-500 dark:text-gray-400 px-1">
                              +{dayEvents.length - 3}
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Legend */}
            <div className="mt-4 flex flex-wrap items-center gap-4 px-2">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-sm bg-blue-500" />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {getTypeLabel("SOCIAL_LISTENING", locale)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-sm bg-purple-500" />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {getTypeLabel("INFLUENCER_TRACKING", locale)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-sm bg-amber-500" />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {getTypeLabel("UGC", locale)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tooltip / Popover */}
      {tooltip && (
        <div
          ref={tooltipRef}
          className="fixed z-50 w-72 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-xl"
          style={{
            left: Math.min(
              tooltip.x - 144,
              typeof window !== "undefined" ? window.innerWidth - 300 : tooltip.x
            ),
            top: tooltip.y,
          }}
        >
          <div className="p-4">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: tooltip.event.color }}
                />
                <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100 line-clamp-2">
                  {tooltip.event.title}
                </h3>
              </div>
              <button
                onClick={() => setTooltip(null)}
                className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  {calendarText.type}
                </span>
                <span className="text-gray-900 dark:text-gray-100 font-medium">
                  {getTypeLabel(tooltip.event.type, locale)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  {calendarText.status}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    tooltip.event.status === "ACTIVE"
                      ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                      : tooltip.event.status === "PAUSED"
                      ? "bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                  )}
                >
                  {getStatusLabel(tooltip.event.status, locale)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500 dark:text-gray-400 flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {calendarText.influencers}
                </span>
                <span className="text-gray-900 dark:text-gray-100 font-medium">
                  {tooltip.event.influencerCount}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>
                  {new Date(tooltip.event.start).toLocaleDateString(
                    locale === "es" ? "es-ES" : "en-US",
                    { month: "short", day: "numeric" }
                  )}
                </span>
                <span>-</span>
                <span>
                  {new Date(tooltip.event.end).toLocaleDateString(
                    locale === "es" ? "es-ES" : "en-US",
                    { month: "short", day: "numeric", year: "numeric" }
                  )}
                </span>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
              <Link
                href={`/campaigns/${tooltip.event.id}`}
                className="flex items-center justify-center gap-2 w-full rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {calendarText.viewCampaign}
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

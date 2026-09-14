"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  BookOpen,
  Search,
  Printer,
  Lightbulb,
  LifeBuoy,
  ChevronRight,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n/context"
import { MANUAL_SECTIONS, type ManualSection } from "@/lib/manual-content"

// ─── Search helpers ────────────────────────────────────────────

/** Lowercase without accents so "envio" finds "Envío" and "estadisticas" finds "estadísticas". */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
}

function sectionText(s: ManualSection): string {
  const parts: string[] = [s.title, s.summary, ...s.steps, ...(s.tips || [])]
  for (const t of s.troubleshooting || []) parts.push(t.problem, ...t.doWhat)
  return normalize(parts.join(" \n "))
}

// ─── Print rules ───────────────────────────────────────────────
// The dashboard chrome (sidebar, header, floating chat) is hidden on paper and
// every card stays whole on its page. `.no-print` marks the page's own chrome.

const PRINT_CSS = `
@media print {
  aside, header, .fixed, .no-print { display: none !important; }
  .manual-card { break-inside: avoid; page-break-inside: avoid; box-shadow: none !important; }
  .manual-card + .manual-card { margin-top: 12px; }
  a[href^="#"] { text-decoration: none; color: inherit; }
}
`

// ─── Building blocks ───────────────────────────────────────────

function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2 my-3 ml-1">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
          <span className="flex items-center justify-center h-5 w-5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs font-bold shrink-0 mt-0.5">
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

function TipBox({ tips }: { tips: string[] }) {
  return (
    <div className="rounded-lg border p-4 flex gap-3 my-4 bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 text-purple-800 dark:text-purple-200">
      <Lightbulb className="h-5 w-5 shrink-0 mt-0.5" />
      <ul className="space-y-1.5 text-sm leading-relaxed">
        {tips.map((tip, i) => (
          <li key={i}>{tip}</li>
        ))}
      </ul>
    </div>
  )
}

function Troubleshooting({ items }: { items: NonNullable<ManualSection["troubleshooting"]> }) {
  return (
    <div className="space-y-3 mt-4">
      {items.map((item, i) => (
        <div
          key={i}
          className="manual-card rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10 p-4"
        >
          <p className="flex items-start gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <LifeBuoy className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <span>{item.problem}</span>
          </p>
          <ol className="mt-2 ml-6 space-y-1.5">
            {item.doWhat.map((action, j) => (
              <li key={j} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                <span className="text-xs font-bold text-amber-700 dark:text-amber-400 mt-0.5 shrink-0">{j + 1}.</span>
                <span>{action}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}

function SectionCard({ section, index }: { section: ManualSection; index: number }) {
  return (
    <section
      id={section.id}
      className="manual-card scroll-mt-24 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden"
    >
      <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-start gap-4">
          <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-sm font-bold shrink-0">
            {index + 1}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              <a href={`#${section.id}`} className="hover:underline">{section.title}</a>
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">{section.summary}</p>
          </div>
        </div>
      </div>
      <div className="px-6 pb-6 pt-2">
        <StepList steps={section.steps} />
        {section.tips && section.tips.length > 0 && <TipBox tips={section.tips} />}
        {section.troubleshooting && section.troubleshooting.length > 0 && (
          <Troubleshooting items={section.troubleshooting} />
        )}
      </div>
    </section>
  )
}

// ═══════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════

export default function ManualPage() {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  // Section a dimmed TOC entry was clicked on while a filter hid it: the filter is
  // cleared first and the scroll happens once the section is back in the DOM.
  const pendingTargetRef = useRef<string | null>(null)

  // Normalised text per section, computed once (the manual is static data).
  const searchable = useMemo(
    () => MANUAL_SECTIONS.map(s => ({ section: s, text: sectionText(s) })),
    []
  )

  const q = normalize(query.trim())
  const visible = useMemo(() => {
    if (!q) return MANUAL_SECTIONS.map((section, index) => ({ section, index }))
    const terms = q.split(/\s+/).filter(Boolean)
    return searchable
      .map(({ section, text }, index) => ({ section, index, hit: terms.every(t => text.includes(t)) }))
      .filter(x => x.hit)
      .map(({ section, index }) => ({ section, index }))
  }, [q, searchable])

  const visibleIds = useMemo(() => new Set(visible.map(v => v.section.id)), [visible])

  useEffect(() => {
    if (q) return
    const id = pendingTargetRef.current
    if (!id) return
    pendingTargetRef.current = null
    document.getElementById(id)?.scrollIntoView()
    window.history.replaceState(null, "", `#${id}`)
  }, [q])

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="rounded-lg bg-purple-100 dark:bg-purple-900/30 p-2 text-purple-600">
              <BookOpen className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t.manual.title}</h1>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 ml-12">{t.manual.intro}</p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="no-print inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          <Printer className="h-4 w-4" />
          {t.manual.print}
        </button>
      </div>

      {/* Search */}
      <div className="no-print relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t.manual.searchPlaceholder}
          aria-label={t.manual.searchLabel}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 py-2.5 pl-9 pr-9 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t.manual.clearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {q && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {visible.length === 0
              ? t.manual.noResults
              : t.manual.resultsCount
                  .replace("{n}", String(visible.length))
                  .replace("{total}", String(MANUAL_SECTIONS.length))
                  .replace("{q}", query.trim())}
          </p>
        )}
      </div>

      {/* Table of contents */}
      <nav
        aria-label={t.manual.tocLabel}
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm p-5"
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">{t.manual.toc}</p>
        <ol className="grid gap-1.5 sm:grid-cols-2">
          {MANUAL_SECTIONS.map((s, i) => {
            const dimmed = q.length > 0 && !visibleIds.has(s.id)
            return (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  onClick={dimmed ? (e => {
                    // The section is filtered out of the DOM: clear the filter, then scroll.
                    e.preventDefault()
                    pendingTargetRef.current = s.id
                    setQuery("")
                  }) : undefined}
                  className={cn(
                    "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors",
                    dimmed
                      ? "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                      : "text-gray-700 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-700 dark:hover:text-purple-300"
                  )}
                >
                  <span className="w-5 text-right text-xs font-bold text-purple-600 dark:text-purple-400 shrink-0">{i + 1}.</span>
                  <span className="truncate">{s.title}</span>
                  <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-gray-300 group-hover:text-purple-500 no-print" />
                </a>
              </li>
            )
          })}
        </ol>
      </nav>

      {/* Sections */}
      {visible.map(({ section, index }) => (
        <SectionCard key={section.id} section={section} index={index} />
      ))}

      {/* Footer */}
      <div className="text-center py-6">
        <p className="text-xs text-gray-400 dark:text-gray-500">{t.manual.footer}</p>
      </div>
    </div>
  )
}

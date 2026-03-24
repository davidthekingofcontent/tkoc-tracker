'use client'

import React, { useState, useCallback, useRef } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/utils'
import { useI18n } from '@/i18n/context'
import {
  Megaphone,
  Eye,
  EyeOff,
  FileText,
  FileSpreadsheet,
  Upload,
  X,
  Loader2,
  Users,
  BarChart3,
  Image as ImageIcon,
  Lightbulb,
  Target,
} from 'lucide-react'

// ============ TYPES ============

interface InfluencerData {
  id: string
  username: string
  displayName: string | null
  platform: string
  followers: number
  engagementRate: number | null
  avgLikes: number | null
  avgComments: number | null
  avgViews: number | null
  status?: string
  cost?: number | null
  agreedFee?: number | null
}

interface MediaData {
  id: string
  mediaType: string
  caption: string | null
  thumbnailUrl: string | null
  permalink: string | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  views: number | null
  reach: number | null
  platform: string | null
  postedAt: string | null
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
  }
}

interface CampaignForReport {
  id: string
  name: string
  type: string
  status: string
  platforms: string[]
  targetHashtags: string[]
  targetAccounts: string[]
  startDate: string | null
  endDate: string | null
  country: string | null
  influencers: { influencer: InfluencerData; status: string; cost: number | null; agreedFee: number | null }[]
  media: MediaData[]
}

interface OverviewForReport {
  totalReach: number
  totalImpressions: number | null
  totalEngagements: number
  engagementRate: number
  totalViews: number
  profilesPosted: number
  totalMedia: number
  emvBasic: number
  emvExtended: number
  totalCost: number
}

type SectionId = 'overview' | 'influencers' | 'media' | 'insights' | 'recommendations'

interface ReportPreviewModalProps {
  open: boolean
  onClose: () => void
  campaign: CampaignForReport
  overview: OverviewForReport | null
}

// ============ SECTION ICON MAP ============

const sectionIcons: Record<SectionId, React.ReactNode> = {
  overview: <BarChart3 className="h-4 w-4" />,
  influencers: <Users className="h-4 w-4" />,
  media: <ImageIcon className="h-4 w-4" />,
  insights: <Lightbulb className="h-4 w-4" />,
  recommendations: <Target className="h-4 w-4" />,
}

// ============ COMPONENT ============

export function ReportPreviewModal({ open, onClose, campaign, overview }: ReportPreviewModalProps) {
  const { t, locale } = useI18n()

  // Translations
  const rt = locale === 'es' ? reportTranslations.es : reportTranslations.en

  // Editable fields
  const [title, setTitle] = useState(campaign.name)
  const [summary, setSummary] = useState('')
  const [notes, setNotes] = useState('')
  const [coverImage, setCoverImage] = useState<string | null>(null)
  const [coverFileName, setCoverFileName] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Section visibility
  const [visibleSections, setVisibleSections] = useState<Record<SectionId, boolean>>({
    overview: true,
    influencers: true,
    media: true,
    insights: true,
    recommendations: true,
  })

  // Export state
  const [isExporting, setIsExporting] = useState(false)

  // Reset state when modal opens with new campaign
  React.useEffect(() => {
    if (open) {
      setTitle(campaign.name)
      setSummary('')
      setNotes('')
      setCoverImage(null)
      setCoverFileName(null)
      setVisibleSections({
        overview: true,
        influencers: true,
        media: true,
        insights: true,
        recommendations: true,
      })
    }
  }, [open, campaign.name])

  const toggleSection = useCallback((section: SectionId) => {
    setVisibleSections(prev => ({ ...prev, [section]: !prev[section] }))
  }, [])

  const handleCoverUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCoverFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      setCoverImage(reader.result as string)
    }
    reader.readAsDataURL(file)
  }, [])

  const removeCoverImage = useCallback(() => {
    setCoverImage(null)
    setCoverFileName(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const handleExport = useCallback(async (format: 'pdf' | 'csv' | 'json') => {
    setIsExporting(true)
    try {
      const activeSections = Object.entries(visibleSections)
        .filter(([, visible]) => visible)
        .map(([id]) => id)

      const body: Record<string, unknown> = {
        format,
        title,
        summary: summary || undefined,
        notes: notes || undefined,
        sections: activeSections,
      }

      if (coverImage) {
        body.coverImageBase64 = coverImage
      }

      const res = await fetch(`/api/campaigns/${campaign.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        throw new Error('Export failed')
      }

      // Download the file
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ext = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'json'
      const safeName = campaign.name.replace(/[^a-zA-Z0-9]/g, '_')
      a.download = `${safeName}_report.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      onClose()
    } catch (err) {
      console.error('Export error:', err)
    } finally {
      setIsExporting(false)
    }
  }, [campaign.id, campaign.name, title, summary, notes, visibleSections, coverImage, onClose])

  // Computed stats
  const ov = overview || {
    totalReach: 0,
    totalImpressions: 0,
    totalEngagements: 0,
    engagementRate: 0,
    totalViews: 0,
    profilesPosted: 0,
    totalMedia: 0,
    emvBasic: 0,
    emvExtended: 0,
    totalCost: 0,
  }

  const topMedia = [...campaign.media]
    .sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)))
    .slice(0, 5)

  return (
    <Modal open={open} onClose={onClose} className="max-w-4xl max-h-[90vh] flex flex-col">
      <ModalHeader onClose={onClose}>
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-purple-600" />
          <span className="font-bold text-purple-600">TKOC</span>
          <span className="text-gray-500 font-normal text-sm">Intelligence</span>
          <span className="mx-2 text-gray-300">|</span>
          <span>{rt.reportPreview}</span>
        </div>
      </ModalHeader>

      <ModalBody className="overflow-y-auto flex-1 space-y-6">
        {/* ============ EDITABLE HEADER ============ */}
        <div className="space-y-4">
          {/* Cover Image Upload */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {rt.coverImage}
              <span className="text-gray-400 text-xs ml-1">({rt.optional})</span>
            </label>
            {coverImage ? (
              <div className="relative rounded-lg overflow-hidden h-32 bg-gray-100 dark:bg-gray-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={coverImage} alt="Cover" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                  <button
                    onClick={removeCoverImage}
                    className="rounded-full bg-white/90 p-2 text-gray-700 hover:bg-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <span className="absolute bottom-2 left-2 text-xs text-white bg-black/50 px-2 py-0.5 rounded">
                  {coverFileName}
                </span>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-20 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center gap-2 text-sm text-gray-500 hover:border-purple-400 hover:text-purple-500 transition-colors"
              >
                <Upload className="h-4 w-4" />
                {rt.uploadCover}
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleCoverUpload}
            />
          </div>

          {/* Report Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {rt.reportTitle}
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none"
            />
          </div>

          {/* Executive Summary */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {rt.executiveSummary}
              <span className="text-gray-400 text-xs ml-1">({rt.optional})</span>
            </label>
            <textarea
              value={summary}
              onChange={e => setSummary(e.target.value)}
              rows={3}
              placeholder={rt.summaryPlaceholder}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none resize-none"
            />
          </div>
        </div>

        {/* ============ SECTIONS TOGGLE ============ */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            {rt.reportSections}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {(Object.keys(visibleSections) as SectionId[]).map(section => (
              <button
                key={section}
                onClick={() => toggleSection(section)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  visibleSections[section]
                    ? 'border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-600 dark:bg-purple-900/30 dark:text-purple-300'
                    : 'border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500'
                }`}
              >
                {visibleSections[section] ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" />
                )}
                {sectionIcons[section]}
                {rt.sections[section]}
              </button>
            ))}
          </div>
        </div>

        {/* ============ PREVIEW ============ */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
          {/* Report Header */}
          <div className="bg-gradient-to-r from-purple-600 to-purple-800 px-6 py-4">
            <div className="flex items-center gap-2 mb-2">
              <Megaphone className="h-5 w-5 text-white" />
              <span className="text-white font-bold text-sm">TKOC Intelligence</span>
            </div>
            <h2 className="text-xl font-bold text-white">{title || campaign.name}</h2>
            {summary && (
              <p className="text-purple-100 text-sm mt-2 line-clamp-3">{summary}</p>
            )}
            <div className="flex items-center gap-4 mt-3 text-purple-200 text-xs">
              {campaign.startDate && (
                <span>
                  {new Date(campaign.startDate).toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US')}
                  {campaign.endDate && ` - ${new Date(campaign.endDate).toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US')}`}
                </span>
              )}
              <span>{campaign.platforms.join(', ')}</span>
              <span className="uppercase">{campaign.status}</span>
            </div>
          </div>

          {/* Campaign Overview KPIs */}
          {visibleSections.overview && (
            <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-purple-500" />
                {rt.sections.overview}
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiCard label={rt.kpi.reach} value={formatNumber(ov.totalReach)} />
                <KpiCard label={rt.kpi.impressions} value={formatNumber(ov.totalImpressions || 0)} />
                <KpiCard label={rt.kpi.engagements} value={formatNumber(ov.totalEngagements)} />
                <KpiCard label={rt.kpi.engRate} value={`${ov.engagementRate.toFixed(2)}%`} />
                <KpiCard label={rt.kpi.views} value={formatNumber(ov.totalViews)} />
                <KpiCard label={rt.kpi.media} value={String(ov.totalMedia)} />
                <KpiCard label={rt.kpi.emv} value={`$${formatNumber(ov.emvExtended)}`} />
                <KpiCard label={rt.kpi.cost} value={`$${formatNumber(ov.totalCost)}`} />
              </div>
            </div>
          )}

          {/* Influencer Performance */}
          {visibleSections.influencers && campaign.influencers.length > 0 && (
            <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3 flex items-center gap-2">
                <Users className="h-4 w-4 text-purple-500" />
                {rt.sections.influencers}
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                      <th className="pb-2 pr-3 font-medium">{rt.table.influencer}</th>
                      <th className="pb-2 pr-3 font-medium">{rt.table.platform}</th>
                      <th className="pb-2 pr-3 font-medium text-right">{rt.table.followers}</th>
                      <th className="pb-2 pr-3 font-medium text-right">{rt.table.engRate}</th>
                      <th className="pb-2 font-medium text-right">{rt.table.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaign.influencers.slice(0, 10).map(ci => (
                      <tr key={ci.influencer.id} className="border-b border-gray-50 dark:border-gray-800">
                        <td className="py-1.5 pr-3 text-gray-900 dark:text-white font-medium">
                          @{ci.influencer.username}
                        </td>
                        <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-400 capitalize">
                          {ci.influencer.platform.toLowerCase()}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">
                          {formatNumber(ci.influencer.followers)}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">
                          {ci.influencer.engagementRate != null
                            ? `${ci.influencer.engagementRate.toFixed(2)}%`
                            : '-'}
                        </td>
                        <td className="py-1.5 text-right">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            ci.status === 'CONFIRMED'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : ci.status === 'PENDING'
                              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                          }`}>
                            {ci.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {campaign.influencers.length > 10 && (
                  <p className="text-xs text-gray-400 mt-2">
                    +{campaign.influencers.length - 10} {rt.more}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Media Highlights */}
          {visibleSections.media && topMedia.length > 0 && (
            <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3 flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-purple-500" />
                {rt.sections.media}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {topMedia.map(m => (
                  <div
                    key={m.id}
                    className="flex items-start gap-3 rounded-lg border border-gray-100 dark:border-gray-700 p-2"
                  >
                    {m.thumbnailUrl && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={m.thumbnailUrl}
                        alt=""
                        className="h-12 w-12 rounded object-cover flex-shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                        @{m.influencer.username}
                      </p>
                      <p className="text-[10px] text-gray-500 truncate">
                        {m.caption?.substring(0, 60) || m.mediaType}
                      </p>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
                        <span>{formatNumber(m.likes || 0)} {rt.kpi.likes}</span>
                        <span>{formatNumber(m.comments || 0)} {rt.kpi.comments}</span>
                        <span>{formatNumber(m.views || 0)} {rt.kpi.viewsShort}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Key Insights */}
          {visibleSections.insights && (
            <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2 flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-purple-500" />
                {rt.sections.insights}
              </h3>
              <div className="space-y-1.5">
                {generateInsights(campaign, ov, rt).map((insight, i) => (
                  <p key={i} className="text-xs text-gray-600 dark:text-gray-400 flex items-start gap-2">
                    <span className="text-purple-400 mt-0.5">&#8226;</span>
                    {insight}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {visibleSections.recommendations && (
            <div className="px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2 flex items-center gap-2">
                <Target className="h-4 w-4 text-purple-500" />
                {rt.sections.recommendations}
              </h3>
              <div className="space-y-1.5">
                {generateRecommendations(campaign, ov, rt).map((rec, i) => (
                  <p key={i} className="text-xs text-gray-600 dark:text-gray-400 flex items-start gap-2">
                    <span className="text-green-500 mt-0.5">&#10003;</span>
                    {rec}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {rt.notes}
            <span className="text-gray-400 text-xs ml-1">({rt.optional})</span>
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder={rt.notesPlaceholder}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none resize-none"
          />
        </div>
      </ModalBody>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={isExporting}>
          {rt.cancel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleExport('csv')}
          disabled={isExporting}
        >
          {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 text-green-500" />}
          {rt.exportCSV}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => handleExport('pdf')}
          disabled={isExporting}
        >
          {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          {rt.exportPDF}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ============ KPI CARD ============

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2">
      <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-sm font-bold text-gray-900 dark:text-white mt-0.5">{value}</p>
    </div>
  )
}

// ============ AUTO-GENERATED INSIGHTS ============

function generateInsights(
  campaign: CampaignForReport,
  ov: OverviewForReport,
  rt: typeof reportTranslations.en
): string[] {
  const insights: string[] = []

  if (ov.totalMedia > 0) {
    insights.push(
      rt.insightTemplates.totalContent
        .replace('{count}', String(ov.totalMedia))
        .replace('{influencers}', String(ov.profilesPosted))
    )
  }

  if (ov.engagementRate > 3) {
    insights.push(rt.insightTemplates.highEngagement.replace('{rate}', ov.engagementRate.toFixed(2)))
  } else if (ov.engagementRate > 0) {
    insights.push(rt.insightTemplates.normalEngagement.replace('{rate}', ov.engagementRate.toFixed(2)))
  }

  if (ov.totalReach > 0) {
    insights.push(rt.insightTemplates.reachAchieved.replace('{reach}', formatNumber(ov.totalReach)))
  }

  if (ov.emvExtended > 0 && ov.totalCost > 0) {
    const roi = (ov.emvExtended / ov.totalCost).toFixed(1)
    insights.push(rt.insightTemplates.emvRoi.replace('{roi}', roi))
  }

  const platforms = [...new Set(campaign.media.map(m => m.influencer?.platform).filter(Boolean))]
  if (platforms.length > 1) {
    insights.push(rt.insightTemplates.multiPlatform.replace('{platforms}', platforms.join(', ')))
  }

  return insights.length > 0 ? insights : [rt.insightTemplates.noData]
}

// ============ AUTO-GENERATED RECOMMENDATIONS ============

function generateRecommendations(
  campaign: CampaignForReport,
  ov: OverviewForReport,
  rt: typeof reportTranslations.en
): string[] {
  const recs: string[] = []

  if (ov.engagementRate < 2 && ov.totalMedia > 0) {
    recs.push(rt.recTemplates.boostEngagement)
  }

  if (campaign.influencers.length < 5) {
    recs.push(rt.recTemplates.expandRoster)
  }

  const hasVideo = campaign.media.some(m => m.mediaType === 'REEL' || m.mediaType === 'VIDEO')
  if (!hasVideo && campaign.media.length > 0) {
    recs.push(rt.recTemplates.addVideo)
  }

  if (ov.totalCost > 0 && ov.emvExtended > 0 && ov.emvExtended / ov.totalCost < 1) {
    recs.push(rt.recTemplates.optimizeBudget)
  }

  recs.push(rt.recTemplates.trackConsistently)

  return recs
}

// ============ TRANSLATIONS ============

const reportTranslations = {
  en: {
    reportPreview: 'Report Preview',
    coverImage: 'Cover Image',
    optional: 'optional',
    uploadCover: 'Upload cover image',
    reportTitle: 'Report Title',
    executiveSummary: 'Executive Summary',
    summaryPlaceholder: 'Write a brief summary of the campaign results and highlights...',
    reportSections: 'Report Sections',
    notes: 'Additional Notes',
    notesPlaceholder: 'Add any additional notes for the report...',
    cancel: 'Cancel',
    exportPDF: 'Export PDF',
    exportCSV: 'Export CSV',
    more: 'more',
    sections: {
      overview: 'Campaign Overview',
      influencers: 'Influencer Performance',
      media: 'Media Highlights',
      insights: 'Key Insights',
      recommendations: 'Recommendations',
    },
    kpi: {
      reach: 'Reach',
      impressions: 'Impressions',
      engagements: 'Engagements',
      engRate: 'Eng. Rate',
      views: 'Views',
      media: 'Media',
      emv: 'EMV',
      cost: 'Cost',
      likes: 'likes',
      comments: 'comments',
      viewsShort: 'views',
    },
    table: {
      influencer: 'Influencer',
      platform: 'Platform',
      followers: 'Followers',
      engRate: 'Eng. Rate',
      status: 'Status',
    },
    insightTemplates: {
      totalContent: 'The campaign generated {count} pieces of content from {influencers} creators.',
      highEngagement: 'Engagement rate of {rate}% is above industry average (typically 1-3%).',
      normalEngagement: 'Engagement rate of {rate}% is within industry benchmarks.',
      reachAchieved: 'Total reach of {reach} across all content.',
      emvRoi: 'EMV-to-cost ratio of {roi}x indicates strong return on investment.',
      multiPlatform: 'Content distributed across multiple platforms: {platforms}.',
      noData: 'Track the campaign to generate performance insights.',
    },
    recTemplates: {
      boostEngagement: 'Consider content with stronger calls-to-action to improve engagement rates.',
      expandRoster: 'Expand the influencer roster to increase reach and content diversity.',
      addVideo: 'Incorporate video content (Reels/Shorts) for higher engagement potential.',
      optimizeBudget: 'Review budget allocation to improve EMV-to-cost ratio.',
      trackConsistently: 'Continue tracking regularly to capture all campaign content.',
    },
  },
  es: {
    reportPreview: 'Vista Previa del Informe',
    coverImage: 'Imagen de Portada',
    optional: 'opcional',
    uploadCover: 'Subir imagen de portada',
    reportTitle: 'Titulo del Informe',
    executiveSummary: 'Resumen Ejecutivo',
    summaryPlaceholder: 'Escribe un breve resumen de los resultados y aspectos destacados de la campana...',
    reportSections: 'Secciones del Informe',
    notes: 'Notas Adicionales',
    notesPlaceholder: 'Agrega notas adicionales para el informe...',
    cancel: 'Cancelar',
    exportPDF: 'Exportar PDF',
    exportCSV: 'Exportar CSV',
    more: 'mas',
    sections: {
      overview: 'Resumen de Campana',
      influencers: 'Rendimiento de Influencers',
      media: 'Contenido Destacado',
      insights: 'Insights Clave',
      recommendations: 'Recomendaciones',
    },
    kpi: {
      reach: 'Alcance',
      impressions: 'Impresiones',
      engagements: 'Interacciones',
      engRate: 'Tasa Eng.',
      views: 'Vistas',
      media: 'Contenido',
      emv: 'EMV',
      cost: 'Costo',
      likes: 'likes',
      comments: 'comentarios',
      viewsShort: 'vistas',
    },
    table: {
      influencer: 'Influencer',
      platform: 'Plataforma',
      followers: 'Seguidores',
      engRate: 'Tasa Eng.',
      status: 'Estado',
    },
    insightTemplates: {
      totalContent: 'La campana genero {count} piezas de contenido de {influencers} creadores.',
      highEngagement: 'Tasa de engagement de {rate}% esta por encima del promedio de la industria (tipicamente 1-3%).',
      normalEngagement: 'Tasa de engagement de {rate}% esta dentro de los benchmarks de la industria.',
      reachAchieved: 'Alcance total de {reach} en todo el contenido.',
      emvRoi: 'Ratio EMV/costo de {roi}x indica un fuerte retorno de inversion.',
      multiPlatform: 'Contenido distribuido en multiples plataformas: {platforms}.',
      noData: 'Rastrea la campana para generar insights de rendimiento.',
    },
    recTemplates: {
      boostEngagement: 'Considera contenido con llamados a la accion mas fuertes para mejorar las tasas de engagement.',
      expandRoster: 'Amplia el roster de influencers para aumentar el alcance y diversidad del contenido.',
      addVideo: 'Incorpora contenido de video (Reels/Shorts) para mayor potencial de engagement.',
      optimizeBudget: 'Revisa la asignacion de presupuesto para mejorar el ratio EMV/costo.',
      trackConsistently: 'Continua rastreando regularmente para capturar todo el contenido de la campana.',
    },
  },
}

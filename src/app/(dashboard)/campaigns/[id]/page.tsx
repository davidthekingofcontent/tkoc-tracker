'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { Avatar } from '@/components/ui/avatar'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { formatNumber } from '@/lib/utils'
import { useI18n } from '@/i18n/context'
import { calculateCPM, type CPMResult, type Platform as CPMPlatform } from '@/lib/cpm-calculator'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { CampaignNotesButton } from '@/components/campaign-notes'
import { InfluencerHistoryButton } from '@/components/influencer-history'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal'
import { StoriesTracker } from '@/components/stories-tracker'
import {
  ArrowLeft,
  Users,
  Image,
  Eye,
  BarChart3,
  Heart,
  TrendingUp,
  Loader2,
  Instagram,
  Youtube,
  Download,
  Radar,
  CheckCircle2,
  AlertCircle,
  X,
  ChevronUp,
  ChevronDown,
  Plus,
  UserPlus,
  Clock,
  Film,
  Globe,
  MapPin,
  Settings2,
  Save,
  Kanban,
  DollarSign,
  Gift,
  Video,
  Link2,
  ExternalLink,
  Package,
  Truck,
  FileText,
  Paperclip,
  ChevronRight,
  Copy,
  Upload,
  Trash2,
  File,
} from 'lucide-react'

interface CampaignInfluencer {
  id: string
  cost: number | null
  agreedFee: number | null
  notes: string | null
  status: string
  portfolioUrl: string | null
  contentDelivered: boolean
  shippingName: string | null
  shippingAddress1: string | null
  shippingAddress2: string | null
  shippingCity: string | null
  shippingPostCode: string | null
  shippingCountry: string | null
  shippingPhone: string | null
  shippingEmail: string | null
  shippingProduct: string | null
  shippingQty: number | null
  shippingComments: string | null
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
    followers: number
    engagementRate: number | null
    avgLikes: number | null
    avgComments: number | null
    avgViews: number | null
    standardFee: number | null
  }
}

interface CampaignMedia {
  id: string
  mediaType: string
  caption: string | null
  thumbnailUrl: string | null
  permalink: string | null
  likes: number | null
  comments: number | null
  shares: number | null
  views: number | null
  reach: number | null
  postedAt: string | null
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
  }
}

interface CampaignData {
  id: string
  name: string
  type: string
  status: string
  paymentType: string
  platforms: string[]
  targetAccounts: string[]
  targetHashtags: string[]
  startDate: string | null
  endDate: string | null
  country: string | null
  briefText: string | null
  briefFiles: string[]
  influencers: CampaignInfluencer[]
  media: CampaignMedia[]
}

interface Overview {
  totalReach: number
  totalImpressions: number
  totalEngagements: number
  engagementRate: number
  mediaValue: number
  totalViews: number
  profilesPosted: number
  totalMedia: number
  emvBasic: number
  emvExtended: number
  totalCost: number
}

interface TimelinePoint {
  date: string
  posts: number
  likes: number
  comments: number
  views: number
  reach: number
  engagements: number
}

// Dynamic import for Recharts (client-side only)
const RechartsArea = dynamic(
  () => import('recharts').then(mod => {
    const { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = mod
    return function ChartWrapper({ data, title, dataKeys }: {
      data: TimelinePoint[]
      title: string
      dataKeys: { key: string; color: string; name: string }[]
    }) {
      return (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-700">{title}</h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <defs>
                {dataKeys.map(dk => (
                  <linearGradient key={dk.key} id={`grad_${dk.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={dk.color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={dk.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#9ca3af' }}
                tickFormatter={(v: string) => {
                  const d = new Date(v)
                  return `${d.getDate()}/${d.getMonth() + 1}`
                }}
              />
              <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={(v: number) => {
                if (v >= 1000000) return `${(v/1000000).toFixed(1)}M`
                if (v >= 1000) return `${(v/1000).toFixed(1)}K`
                return v.toString()
              }} />
              <Tooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid #e5e7eb',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,.1)',
                  fontSize: '12px',
                }}
                labelFormatter={(v) => new Date(String(v)).toLocaleDateString()}
                formatter={(value) => {
                  const num = Number(value)
                  if (num >= 1000000) return [`${(num/1000000).toFixed(1)}M`, '']
                  if (num >= 1000) return [`${(num/1000).toFixed(1)}K`, '']
                  return [num.toString(), '']
                }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              {dataKeys.map(dk => (
                <Area
                  key={dk.key}
                  type="monotone"
                  dataKey={dk.key}
                  name={dk.name}
                  stroke={dk.color}
                  strokeWidth={2}
                  fill={`url(#grad_${dk.key})`}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )
    }
  }),
  { ssr: false, loading: () => <div className="h-[300px] rounded-xl border border-gray-200 bg-white animate-pulse" /> }
)

type SortField = 'followers' | 'engagement'
type SortDirection = 'asc' | 'desc'

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform) {
    case 'INSTAGRAM': return <Instagram className="h-3.5 w-3.5" />
    case 'YOUTUBE': return <Youtube className="h-3.5 w-3.5" />
    case 'TIKTOK': return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z"/></svg>
    default: return null
  }
}

const platformBadge = (platform: string) => {
  switch (platform) {
    case 'INSTAGRAM': return 'instagram' as const
    case 'YOUTUBE': return 'youtube' as const
    case 'TIKTOK': return 'tiktok' as const
    default: return 'default' as const
  }
}

function SortIndicator({ field, sortField, sortDirection }: { field: SortField; sortField: SortField | null; sortDirection: SortDirection }) {
  if (sortField !== field) {
    return <ChevronDown className="ml-1 inline h-3 w-3 text-gray-300" />
  }
  return sortDirection === 'asc'
    ? <ChevronUp className="ml-1 inline h-3 w-3 text-purple-600" />
    : <ChevronDown className="ml-1 inline h-3 w-3 text-purple-600" />
}

function sortInfluencers(
  influencers: CampaignInfluencer[],
  sortField: SortField | null,
  sortDirection: SortDirection
): CampaignInfluencer[] {
  if (!sortField) return influencers
  return [...influencers].sort((a, b) => {
    let aVal: number
    let bVal: number
    if (sortField === 'followers') {
      aVal = a.influencer?.followers || 0
      bVal = b.influencer?.followers || 0
    } else {
      aVal = a.influencer?.engagementRate || 0
      bVal = b.influencer?.engagementRate || 0
    }
    return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
  })
}

export default function CampaignDetailPage() {
  const params = useParams()
  const { t, locale } = useI18n()
  const campaignId = params.id as string
  const [campaign, setCampaign] = useState<CampaignData | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [timeline, setTimeline] = useState<TimelinePoint[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isTracking, setIsTracking] = useState(false)
  const [trackingResult, setTrackingResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // Sort state
  const [reportSortField, setReportSortField] = useState<SortField | null>(null)
  const [reportSortDirection, setReportSortDirection] = useState<SortDirection>('desc')
  const [influencerSortField, setInfluencerSortField] = useState<SortField | null>(null)
  const [influencerSortDirection, setInfluencerSortDirection] = useState<SortDirection>('desc')

  // Add influencer state
  const [addInfluencerUsername, setAddInfluencerUsername] = useState('')
  const [isAddingInfluencer, setIsAddingInfluencer] = useState(false)
  const [addInfluencerResult, setAddInfluencerResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // Load more media state
  const [mediaOffset, setMediaOffset] = useState(0)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMoreMedia, setHasMoreMedia] = useState(false)

  // Media sort state
  const [mediaSortBy, setMediaSortBy] = useState<'recent' | 'likes' | 'comments' | 'views'>('recent')

  // CPM fee editing
  const [editingFee, setEditingFee] = useState<Record<string, string>>({})
  const [savingFee, setSavingFee] = useState<string | null>(null)

  // Edit campaign modal
  const [showEditModal, setShowEditModal] = useState(false)
  const [editForm, setEditForm] = useState({
    name: '',
    startDate: '',
    endDate: '',
    country: '',
    targetHashtags: '',
    targetAccounts: '',
    status: '',
  })
  const [isSaving, setIsSaving] = useState(false)

  // Brief state
  const [showBriefEditor, setShowBriefEditor] = useState(false)
  const [briefText, setBriefText] = useState('')
  const [isSavingBrief, setIsSavingBrief] = useState(false)
  const [isUploadingFiles, setIsUploadingFiles] = useState(false)
  const [isDeletingFile, setIsDeletingFile] = useState<string | null>(null)

  // Shipping modal
  const [shippingModal, setShippingModal] = useState<string | null>(null) // influencerId
  const [shippingForm, setShippingForm] = useState<Record<string, string>>({})
  const [isSavingShipping, setIsSavingShipping] = useState(false)

  // Export dropdown state
  const [showExportDropdown, setShowExportDropdown] = useState(false)

  // Save as Template state
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [isSavingTemplate, setIsSavingTemplate] = useState(false)
  const [templateResult, setTemplateResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  async function fetchCampaign() {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`)
      if (res.ok) {
        const data = await res.json()
        setCampaign(data.campaign)
        setOverview(data.overview)
        setTimeline(data.timeline || [])
        // If exactly 20 media items, there may be more
        const mediaCount = data.campaign?.media?.length || 0
        setMediaOffset(mediaCount)
        setHasMoreMedia(mediaCount >= 50)
      }
    } catch (err) {
      console.error('Error fetching campaign:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchCampaign()
  }, [campaignId])

  async function handleTrackNow() {
    setIsTracking(true)
    setTrackingResult(null)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/track`, {
        method: 'POST',
      })
      const data = await res.json()

      if (res.ok) {
        const storiesMsg = data.results.storiesCaptured > 0 ? `, ${data.results.storiesCaptured} stories` : ''
        setTrackingResult({
          type: 'success',
          message: `${data.results.postsFound} ${t.campaignDetail.postsFound}, ${data.results.influencersFound} ${t.campaignDetail.influencersFound}${storiesMsg}`,
        })
        await fetchCampaign()
      } else {
        setTrackingResult({
          type: 'error',
          message: data.error || 'Tracking failed',
        })
      }
    } catch {
      setTrackingResult({
        type: 'error',
        message: 'Network error',
      })
    } finally {
      setIsTracking(false)
    }
  }

  async function handleAddInfluencer() {
    const username = addInfluencerUsername.trim().replace(/^@/, '')
    if (!username) return

    setIsAddingInfluencer(true)
    setAddInfluencerResult(null)

    try {
      // Step 1: Analyze/scrape the influencer
      const platform = (campaign?.platforms && campaign.platforms.length > 0) ? campaign.platforms[0] : 'INSTAGRAM'
      const analyzeRes = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, platform }),
      })
      const analyzeData = await analyzeRes.json()

      if (!analyzeRes.ok) {
        setAddInfluencerResult({
          type: 'error',
          message: analyzeData.error || 'Failed to find influencer',
        })
        return
      }

      const influencerId = analyzeData.influencer?.id || analyzeData.id
      if (!influencerId) {
        setAddInfluencerResult({
          type: 'error',
          message: 'Could not resolve influencer ID',
        })
        return
      }

      // Step 2: Add to campaign
      const addRes = await fetch(`/api/campaigns/${campaignId}/influencers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId }),
      })
      const addData = await addRes.json()

      if (addRes.ok) {
        setAddInfluencerResult({
          type: 'success',
          message: t.campaignDetail.addedSuccess,
        })
        setAddInfluencerUsername('')
        await fetchCampaign()
      } else if (addRes.status === 409) {
        setAddInfluencerResult({
          type: 'error',
          message: t.campaignDetail.alreadyAdded,
        })
      } else {
        setAddInfluencerResult({
          type: 'error',
          message: addData.error || 'Failed to add influencer',
        })
      }
    } catch {
      setAddInfluencerResult({
        type: 'error',
        message: 'Network error',
      })
    } finally {
      setIsAddingInfluencer(false)
    }
  }

  async function handleLoadMoreMedia() {
    if (!campaign) return
    setIsLoadingMore(true)
    try {
      const newOffset = mediaOffset
      const res = await fetch(`/api/campaigns/${campaignId}?mediaOffset=${newOffset}&mediaLimit=50`)
      if (res.ok) {
        const data = await res.json()
        const newMedia: CampaignMedia[] = data.campaign?.media || []
        if (newMedia.length > 0) {
          setCampaign(prev => {
            if (!prev) return prev
            return {
              ...prev,
              media: [...prev.media, ...newMedia],
            }
          })
          setMediaOffset(newOffset + newMedia.length)
          setHasMoreMedia(newMedia.length >= 50)
        } else {
          setHasMoreMedia(false)
        }
      }
    } catch (err) {
      console.error('Error loading more media:', err)
    } finally {
      setIsLoadingMore(false)
    }
  }

  function toggleReportSort(field: SortField) {
    if (reportSortField === field) {
      setReportSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setReportSortField(field)
      setReportSortDirection('desc')
    }
  }

  async function handleSaveFee(campaignInfluencerId: string, influencerId: string, fee: string) {
    setSavingFee(campaignInfluencerId)
    try {
      await fetch(`/api/campaigns/${campaignId}/influencers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId, cost: fee, agreedFee: parseFloat(fee) || 0 }),
      })
      await fetchCampaign()
    } catch { /* ignore */ }
    setSavingFee(null)
  }

  function getCPMForInfluencer(ci: CampaignInfluencer): CPMResult {
    return calculateCPM({
      fee: ci.cost || null,
      avgViews: ci.influencer?.avgViews || 0,
      platform: (ci.influencer?.platform || 'INSTAGRAM') as CPMPlatform,
      followers: ci.influencer?.followers || 0,
    }, locale as 'en' | 'es')
  }

  function toggleInfluencerSort(field: SortField) {
    if (influencerSortField === field) {
      setInfluencerSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setInfluencerSortField(field)
      setInfluencerSortDirection('desc')
    }
  }

  function openEditModal() {
    if (!campaign) return
    setEditForm({
      name: campaign.name,
      startDate: campaign.startDate ? new Date(campaign.startDate).toISOString().split('T')[0] : '',
      endDate: campaign.endDate ? new Date(campaign.endDate).toISOString().split('T')[0] : '',
      country: campaign.country || '',
      targetHashtags: targetHashtags.join(', '),
      targetAccounts: targetAccounts.join(', '),
      status: campaign.status,
    })
    setShowEditModal(true)
  }

  async function handleSaveCampaign() {
    setIsSaving(true)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name,
          status: editForm.status,
          startDate: editForm.startDate || null,
          endDate: editForm.endDate || null,
          country: editForm.country || null,
          targetHashtags: editForm.targetHashtags ? editForm.targetHashtags.split(',').map(s => s.trim()).filter(Boolean) : [],
          targetAccounts: editForm.targetAccounts ? editForm.targetAccounts.split(',').map(s => s.trim()).filter(Boolean) : [],
        }),
      })
      if (res.ok) {
        setShowEditModal(false)
        await fetchCampaign()
      }
    } catch { /* ignore */ }
    setIsSaving(false)
  }

  async function handleSaveBrief() {
    setIsSavingBrief(true)
    try {
      await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefText }),
      })
      await fetchCampaign()
      setShowBriefEditor(false)
    } catch { /* ignore */ }
    setIsSavingBrief(false)
  }

  async function handleBriefFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    setIsUploadingFiles(true)
    try {
      const formData = new FormData()
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i])
      }

      const res = await fetch(`/api/campaigns/${campaignId}/brief-files`, {
        method: 'POST',
        body: formData,
      })

      if (res.ok) {
        await fetchCampaign()
      } else {
        const data = await res.json()
        alert(data.error || 'Upload failed')
      }
    } catch {
      alert('Upload failed')
    }
    setIsUploadingFiles(false)
    // Reset input
    e.target.value = ''
  }

  async function handleDeleteBriefFile(filePath: string) {
    setIsDeletingFile(filePath)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/brief-files`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      })
      if (res.ok) {
        await fetchCampaign()
      }
    } catch { /* ignore */ }
    setIsDeletingFile(null)
  }

  function getFileIcon(fileName: string) {
    const ext = fileName.split('.').pop()?.toLowerCase()
    if (ext === 'pdf') return '📄'
    if (ext === 'doc' || ext === 'docx') return '📝'
    if (ext === 'xls' || ext === 'xlsx') return '📊'
    if (ext === 'ppt' || ext === 'pptx') return '📑'
    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext || '')) return '🖼️'
    return '📎'
  }

  function getFileDisplayName(filePath: string) {
    const fileName = filePath.split('/').pop() || filePath
    // Remove the timestamp suffix (_1234567890)
    return fileName.replace(/_\d{13}(?=\.\w+$)/, '')
  }

  async function handleSaveShipping(influencerId: string) {
    setIsSavingShipping(true)
    try {
      await fetch(`/api/campaigns/${campaignId}/influencers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          influencerId,
          shippingName: shippingForm.shippingName || '',
          shippingAddress1: shippingForm.shippingAddress1 || '',
          shippingAddress2: shippingForm.shippingAddress2 || '',
          shippingCity: shippingForm.shippingCity || '',
          shippingPostCode: shippingForm.shippingPostCode || '',
          shippingCountry: shippingForm.shippingCountry || '',
          shippingPhone: shippingForm.shippingPhone || '',
          shippingEmail: shippingForm.shippingEmail || '',
          shippingProduct: shippingForm.shippingProduct || '',
          shippingQty: shippingForm.shippingQty || '1',
          shippingComments: shippingForm.shippingComments || '',
        }),
      })
      await fetchCampaign()
      setShippingModal(null)
    } catch { /* ignore */ }
    setIsSavingShipping(false)
  }

  function openShippingModal(ci: CampaignInfluencer) {
    setShippingForm({
      shippingName: ci.shippingName || ci.influencer.displayName || ci.influencer.username || '',
      shippingAddress1: ci.shippingAddress1 || '',
      shippingAddress2: ci.shippingAddress2 || '',
      shippingCity: ci.shippingCity || '',
      shippingPostCode: ci.shippingPostCode || '',
      shippingCountry: ci.shippingCountry || '',
      shippingPhone: ci.shippingPhone || '',
      shippingEmail: ci.shippingEmail || '',
      shippingProduct: ci.shippingProduct || '',
      shippingQty: ci.shippingQty?.toString() || '1',
      shippingComments: ci.shippingComments || '',
    })
    setShippingModal(ci.influencer.id)
  }

  function openTemplateModal() {
    setTemplateName(campaign ? `${campaign.name} Template` : 'Template')
    setTemplateResult(null)
    setShowTemplateModal(true)
  }

  async function handleSaveTemplate() {
    if (!campaign || !templateName.trim()) return
    setIsSavingTemplate(true)
    setTemplateResult(null)
    try {
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: templateName.trim(),
          type: campaign.type,
          platforms: campaign.platforms,
          country: campaign.country,
          paymentType: campaign.paymentType,
          targetAccounts: campaign.targetAccounts,
          targetHashtags: campaign.targetHashtags,
          briefText: campaign.briefText,
        }),
      })
      if (res.ok) {
        setTemplateResult({ type: 'success', message: locale === 'es' ? 'Plantilla guardada correctamente' : 'Template saved successfully' })
        setTimeout(() => {
          setShowTemplateModal(false)
          setTemplateResult(null)
        }, 1500)
      } else {
        const data = await res.json()
        setTemplateResult({ type: 'error', message: data.error || 'Failed to save template' })
      }
    } catch {
      setTemplateResult({ type: 'error', message: 'Network error' })
    } finally {
      setIsSavingTemplate(false)
    }
  }

  // Derived data (must be before any conditional returns to respect Rules of Hooks)
  const influencers = campaign?.influencers || []
  const media = campaign?.media || []
  const platforms = campaign?.platforms || []
  const targetAccounts = campaign?.targetAccounts || []
  const targetHashtags = campaign?.targetHashtags || []

  const stories = media.filter(m => m.mediaType === 'STORY')
  const nonStoryMedia = media.filter(m => m.mediaType !== 'STORY')

  const totalReach = overview?.totalReach || influencers.reduce((s, ci) => s + (ci.influencer?.followers || 0), 0)
  const totalEngagements = overview?.totalEngagements || 0
  const totalMedia = overview?.totalMedia || media.length
  const isActive = campaign?.status === 'ACTIVE'
  const isEmpty = media.length === 0 && influencers.length === 0

  const sortedReportInfluencers = useMemo(
    () => sortInfluencers(influencers, reportSortField, reportSortDirection),
    [influencers, reportSortField, reportSortDirection]
  )

  const sortedInfluencers = useMemo(
    () => sortInfluencers(influencers, influencerSortField, influencerSortDirection),
    [influencers, influencerSortField, influencerSortDirection]
  )

  const sortedMedia = useMemo(() => {
    if (mediaSortBy === 'recent') return nonStoryMedia
    return [...nonStoryMedia].sort((a, b) => {
      if (mediaSortBy === 'likes') return (b.likes || 0) - (a.likes || 0)
      if (mediaSortBy === 'comments') return (b.comments || 0) - (a.comments || 0)
      if (mediaSortBy === 'views') return (b.views || 0) - (a.views || 0)
      return 0
    })
  }, [nonStoryMedia, mediaSortBy])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500">{t.common.loading}</span>
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-500">{t.common.noResults}</p>
        <Link href="/campaigns" className="mt-4 text-purple-600 hover:underline">
          {t.common.back}
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/campaigns">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
              {t.common.back}
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{campaign.name}</h1>
              <Badge variant={campaign.status === 'ACTIVE' ? 'active' : campaign.status === 'PAUSED' ? 'paused' : 'archived'}>
                {campaign.status === 'ACTIVE' ? t.common.active : campaign.status === 'PAUSED' ? t.common.paused : t.common.archived}
              </Badge>
              {campaign.paymentType === 'GIFTED' ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-pink-200 bg-pink-50 px-2.5 py-0.5 text-xs font-medium text-pink-700">
                  <Gift className="h-3 w-3" />
                  {locale === 'es' ? 'Gifted' : 'Gifted'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                  <DollarSign className="h-3 w-3" />
                  {locale === 'es' ? 'Pago' : 'Paid'}
                </span>
              )}
              <button
                onClick={openEditModal}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                title={t.common.edit}
              >
                <Settings2 className="h-4 w-4" />
              </button>
              <button
                onClick={openTemplateModal}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-purple-100 hover:text-purple-600 transition-colors"
                title={locale === 'es' ? 'Guardar como plantilla' : 'Save as Template'}
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
              <span>{campaign.type === 'UGC' ? (locale === 'es' ? 'Campaña UGC' : 'UGC Campaign') : campaign.type === 'INFLUENCER_TRACKING' ? t.campaigns.influencerTracking : t.campaigns.socialListening}</span>
              {campaign.type === 'SOCIAL_LISTENING' && (
                <>
                  <span>&middot;</span>
                  <span className="inline-flex items-center gap-1 text-green-600 font-medium">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    {t.campaigns.alwaysOn || 'Always On'}
                  </span>
                </>
              )}
              {campaign.type === 'INFLUENCER_TRACKING' && (campaign.startDate || campaign.endDate) && (
                <>
                  <span>&middot;</span>
                  <span>
                    {campaign.startDate && new Date(campaign.startDate).toLocaleDateString()}
                    {campaign.startDate && campaign.endDate && ' - '}
                    {campaign.endDate && new Date(campaign.endDate).toLocaleDateString()}
                  </span>
                </>
              )}
              {platforms.length > 0 && (
                <>
                  <span>&middot;</span>
                  <span>{platforms.map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(', ')}</span>
                </>
              )}
              {campaign.country && (
                <>
                  <span>&middot;</span>
                  <span className="inline-flex items-center gap-1">
                    <Globe className="h-3 w-3" />
                    {campaign.country}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isActive && (
            <Button
              variant="primary"
              size="lg"
              onClick={handleTrackNow}
              disabled={isTracking}
            >
              {isTracking ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t.campaignDetail.tracking}
                </>
              ) : (
                <>
                  <Radar className="h-5 w-5" />
                  {t.campaignDetail.trackNow}
                </>
              )}
            </Button>
          )}
          <div className="relative">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowExportDropdown(prev => !prev)}
            >
              <Download className="h-4 w-4" />
              {t.campaignDetail.exportReport || 'Export Report'}
              <ChevronDown className="h-3 w-3 ml-1" />
            </Button>
            {showExportDropdown && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowExportDropdown(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                  <a
                    href={`/api/campaigns/${campaign.id}/export?format=pdf`}
                    download
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => setShowExportDropdown(false)}
                  >
                    <FileText className="h-4 w-4 text-red-500" />
                    {t.campaignDetail.exportPDF || 'Export PDF'}
                  </a>
                  <a
                    href={`/api/campaigns/${campaign.id}/export?format=csv`}
                    download
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => setShowExportDropdown(false)}
                  >
                    <FileText className="h-4 w-4 text-green-500" />
                    {t.campaignDetail.exportCSV || 'Export CSV'}
                  </a>
                  <a
                    href={`/api/campaigns/${campaign.id}/export?format=json`}
                    download
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => setShowExportDropdown(false)}
                  >
                    <FileText className="h-4 w-4 text-blue-500" />
                    {t.campaignDetail.exportJSON || 'Export JSON'}
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tracking status banner */}
      {isTracking && (
        <div className="flex items-center gap-3 rounded-xl border border-purple-200 bg-purple-50 px-4 py-3">
          <Loader2 className="h-5 w-5 animate-spin text-purple-600" />
          <div>
            <p className="text-sm font-medium text-purple-800">{t.campaignDetail.tracking}</p>
            <p className="text-xs text-purple-600">{t.campaignDetail.trackingDesc}</p>
          </div>
        </div>
      )}

      {/* Tracking result */}
      {trackingResult && !isTracking && (
        <div className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
          trackingResult.type === 'success'
            ? 'border-green-200 bg-green-50'
            : 'border-red-200 bg-red-50'
        }`}>
          <div className="flex items-center gap-3">
            {trackingResult.type === 'success' ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-600" />
            )}
            <div>
              <p className={`text-sm font-medium ${
                trackingResult.type === 'success' ? 'text-green-800' : 'text-red-800'
              }`}>
                {trackingResult.type === 'success' ? t.campaignDetail.trackingComplete : 'Error'}
              </p>
              <p className={`text-xs ${
                trackingResult.type === 'success' ? 'text-green-600' : 'text-red-600'
              }`}>
                {trackingResult.message}
              </p>
            </div>
          </div>
          <button onClick={() => setTrackingResult(null)} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Tracking info */}
      {(targetAccounts.length > 0 || targetHashtags.length > 0) && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-4">
            {targetAccounts.length > 0 && (
              <div>
                <span className="text-xs font-medium text-gray-500 uppercase">{t.campaigns.trackingAccounts}</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {targetAccounts.map(a => (
                    <Badge key={a} variant="default">{a}</Badge>
                  ))}
                </div>
              </div>
            )}
            {targetHashtags.length > 0 && (
              <div>
                <span className="text-xs font-medium text-gray-500 uppercase">{t.campaigns.trackingHashtags}</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {targetHashtags.map(h => (
                    <Badge key={h} variant="default">{h}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Campaign Brief Section */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <button
          onClick={() => {
            if (!showBriefEditor) {
              setBriefText(campaign.briefText || '')
            }
            setShowBriefEditor(!showBriefEditor)
          }}
          className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors rounded-xl"
        >
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-purple-600" />
            <div>
              <h3 className="text-sm font-semibold text-gray-900">
                {locale === 'es' ? 'Brief de la Campaña' : 'Campaign Brief'}
              </h3>
              {campaign.briefText && !showBriefEditor && (
                <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">{campaign.briefText}</p>
              )}
              {campaign.briefFiles && campaign.briefFiles.length > 0 && !showBriefEditor && (
                <p className="mt-0.5 text-xs text-purple-500">
                  📎 {campaign.briefFiles.length} {locale === 'es' ? 'archivo(s) adjunto(s)' : 'attached file(s)'}
                </p>
              )}
              {!campaign.briefText && (!campaign.briefFiles || campaign.briefFiles.length === 0) && !showBriefEditor && (
                <p className="mt-0.5 text-xs text-gray-400 italic">
                  {locale === 'es' ? 'No hay brief todavía. Haz click para añadir texto o archivos.' : 'No brief yet. Click to add text or files.'}
                </p>
              )}
            </div>
          </div>
          <ChevronRight className={`h-4 w-4 text-gray-400 transition-transform ${showBriefEditor ? 'rotate-90' : ''}`} />
        </button>

        {showBriefEditor && (
          <div className="border-t border-gray-200 px-5 py-4 space-y-4">
            {/* Text editor */}
            <textarea
              value={briefText}
              onChange={(e) => setBriefText(e.target.value)}
              placeholder={locale === 'es'
                ? 'Describe el objetivo de la campaña, requisitos de contenido, tono, hashtags, menciones obligatorias, fechas de entrega...'
                : 'Describe the campaign objective, content requirements, tone, hashtags, mandatory mentions, delivery dates...'}
              rows={6}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 resize-y"
            />

            {/* Attached files */}
            {campaign.briefFiles && campaign.briefFiles.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {locale === 'es' ? 'Archivos adjuntos' : 'Attached files'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {campaign.briefFiles.map((file, i) => (
                    <div key={i} className="group inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 pl-3 pr-1 py-1.5 text-xs text-gray-600">
                      <span className="text-sm">{getFileIcon(file)}</span>
                      <a href={file} target="_blank" rel="noopener noreferrer"
                        className="hover:text-purple-600 hover:underline max-w-[200px] truncate">
                        {getFileDisplayName(file)}
                      </a>
                      <a href={file} download target="_blank" rel="noopener noreferrer"
                        className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
                        title={locale === 'es' ? 'Descargar' : 'Download'}>
                        <Download className="h-3 w-3" />
                      </a>
                      <button
                        onClick={() => handleDeleteBriefFile(file)}
                        disabled={isDeletingFile === file}
                        className="p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-600"
                        title={locale === 'es' ? 'Eliminar' : 'Delete'}>
                        {isDeletingFile === file
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Trash2 className="h-3 w-3" />
                        }
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Upload button + action buttons */}
            <div className="flex items-center justify-between">
              <label className={`inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500 cursor-pointer hover:border-purple-400 hover:text-purple-600 hover:bg-purple-50 transition-colors ${isUploadingFiles ? 'opacity-50 pointer-events-none' : ''}`}>
                {isUploadingFiles
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Upload className="h-4 w-4" />
                }
                {isUploadingFiles
                  ? (locale === 'es' ? 'Subiendo...' : 'Uploading...')
                  : (locale === 'es' ? 'Subir PDF, Word, Excel, imagen...' : 'Upload PDF, Word, Excel, image...')
                }
                <input
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp"
                  onChange={handleBriefFileUpload}
                  className="hidden"
                  disabled={isUploadingFiles}
                />
              </label>

              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowBriefEditor(false)}>
                  {t.common.cancel}
                </Button>
                <Button variant="primary" size="sm" onClick={handleSaveBrief} disabled={isSavingBrief}>
                  {isSavingBrief ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {t.common.save}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue={campaign.type === 'UGC' ? 'creators' : 'report'}>
        <TabsList>
          {campaign.type !== 'UGC' && (
            <>
              <TabsTrigger value="report">{t.campaigns.report}</TabsTrigger>
              <TabsTrigger value="media">{t.campaigns.mediaTab} ({nonStoryMedia.length})</TabsTrigger>
              <TabsTrigger value="stories">
                <Film className="h-3.5 w-3.5" />
                {t.campaignDetail.storiesTab || 'Stories'} ({stories.length})
              </TabsTrigger>
            </>
          )}
          {campaign.type === 'UGC' ? (
            <TabsTrigger value="creators">
              <Video className="h-3.5 w-3.5" />
              {locale === 'es' ? 'Creadores' : 'Creators'} ({influencers.length})
            </TabsTrigger>
          ) : (
            <TabsTrigger value="influencers">{t.campaigns.influencersTab} ({influencers.length})</TabsTrigger>
          )}
          <TabsTrigger value="pipeline">
            <Kanban className="h-3.5 w-3.5" />
            {t.pipeline.title}
          </TabsTrigger>
        </TabsList>

        {/* Report Tab */}
        <TabsContent value="report">
          {isEmpty ? (
            <div className="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm">
              <BarChart3 className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.common.noResults}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                {t.campaignDetail.mediaEmptyDesc}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                {isActive && (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={handleTrackNow}
                    disabled={isTracking}
                  >
                    {isTracking ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.campaignDetail.tracking}
                      </>
                    ) : (
                      <>
                        <Radar className="h-4 w-4" />
                        {t.campaignDetail.trackNow}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Overview Stats */}
              <div>
                <h2 className="mb-4 text-lg font-semibold text-gray-900">{t.campaignDetail.overview}</h2>
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatCard
                    icon={<Users className="h-5 w-5" />}
                    label={t.dashboard.influencers}
                    value={influencers.length}
                    accent
                  />
                  <StatCard
                    icon={<Image className="h-5 w-5" />}
                    label={t.dashboard.media}
                    value={totalMedia}
                  />
                  <StatCard
                    icon={<Eye className="h-5 w-5" />}
                    label={t.dashboard.totalReach}
                    value={formatNumber(totalReach)}
                  />
                  <StatCard
                    icon={<Heart className="h-5 w-5" />}
                    label={t.campaigns.engagement}
                    value={formatNumber(totalEngagements)}
                  />
                </div>
              </div>

              {/* Additional metrics row */}
              {overview && (overview.totalViews > 0 || overview.engagementRate > 0 || overview.mediaValue > 0) && (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatCard
                    icon={<Eye className="h-5 w-5" />}
                    label={t.campaignDetail.totalViews}
                    value={formatNumber(overview.totalViews)}
                  />
                  <StatCard
                    icon={<BarChart3 className="h-5 w-5" />}
                    label={<span className="flex items-center gap-1">{t.campaignDetail.engagementRate} <InfoTooltip text={locale === 'es' ? 'Calculado como (likes + comentarios + shares + saves) / alcance × 100' : 'Calculated as (likes + comments + shares + saves) / reach × 100'} /></span>}
                    value={`${overview.engagementRate}%`}
                  />
                  <StatCard
                    icon={<TrendingUp className="h-5 w-5" />}
                    label={t.campaignDetail.impressions}
                    value={formatNumber(overview.totalImpressions)}
                  />
                  <StatCard
                    icon={<Users className="h-5 w-5" />}
                    label={t.campaignDetail.profilesPosted}
                    value={overview.profilesPosted}
                  />
                </div>
              )}

              {/* EMV Section */}
              {overview && (overview.emvBasic > 0 || overview.emvExtended > 0) && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="rounded-xl border-2 border-green-200 bg-gradient-to-br from-green-50 to-emerald-50 p-5 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-green-600 flex items-center gap-1">EMV {locale === 'es' ? 'Basico' : 'Basic'} <InfoTooltip text={locale === 'es' ? 'Valor estimado basado únicamente en el alcance (impresiones / 1.000 × CPM del sector).' : 'Estimated value based on reach only (impressions / 1,000 × industry CPM).'} /></p>
                    <p className="mt-1 text-2xl font-bold text-green-700">${formatNumber(Math.round(overview.emvBasic || 0))}</p>
                    <p className="mt-1 text-xs text-green-500">{locale === 'es' ? 'Solo alcance' : 'Reach only'}</p>
                  </div>
                  <div className="rounded-xl border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-indigo-50 p-5 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-purple-600 flex items-center gap-1">EMV {locale === 'es' ? 'Ampliado' : 'Extended'} <InfoTooltip text={locale === 'es' ? 'Incluye alcance + clics + engagement (likes, comentarios, shares, saves). Fórmula TKOC personalizada.' : 'Includes reach + clicks + engagement (likes, comments, shares, saves). Custom TKOC formula.'} /></p>
                    <p className="mt-1 text-2xl font-bold text-purple-700">${formatNumber(Math.round(overview.emvExtended || 0))}</p>
                    <p className="mt-1 text-xs text-purple-500">{locale === 'es' ? 'Alcance + engagement' : 'Reach + engagement'}</p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm flex items-center">
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {locale === 'es'
                        ? 'El EMV es una estimacion del coste equivalente que habria supuesto obtener un alcance, interaccion e intencion similares mediante medios pagados. No representa ventas ni ROI directo.'
                        : 'EMV is an estimate of the equivalent cost of achieving similar reach, interaction, and intent through paid media. It does not represent sales or direct ROI.'}
                    </p>
                  </div>
                </div>
              )}

              {/* Cost Summary (only for PAID campaigns) */}
              {campaign.paymentType === 'PAID' && influencers.length > 0 && (() => {
                const totalCost = overview?.totalCost || influencers.reduce((sum, ci) => sum + (ci.agreedFee || 0), 0)
                const emvValue = overview?.emvExtended || overview?.emvBasic || 0
                const roi = totalCost > 0 ? ((emvValue - totalCost) / totalCost) * 100 : 0
                const isPositiveROI = emvValue > totalCost

                return (
                  <div className="space-y-4">
                    <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                      <DollarSign className="h-5 w-5 text-green-600" />
                      {locale === 'es' ? 'Resumen de Costes' : 'Cost Summary'}
                    </h2>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                          {locale === 'es' ? 'Coste Total Campaña' : 'Total Campaign Cost'}
                        </p>
                        <p className="mt-1 text-2xl font-bold text-gray-900">
                          {totalCost > 0 ? `€${formatNumber(Math.round(totalCost))}` : '—'}
                        </p>
                        <p className="mt-1 text-xs text-gray-400">
                          {locale === 'es' ? `${influencers.filter(ci => ci.agreedFee).length} de ${influencers.length} con fee acordado` : `${influencers.filter(ci => ci.agreedFee).length} of ${influencers.length} with agreed fee`}
                        </p>
                      </div>
                      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                          {locale === 'es' ? 'Coste Medio por Influencer' : 'Avg Cost per Influencer'}
                        </p>
                        <p className="mt-1 text-2xl font-bold text-gray-900">
                          {totalCost > 0 && influencers.filter(ci => ci.agreedFee).length > 0
                            ? `€${formatNumber(Math.round(totalCost / influencers.filter(ci => ci.agreedFee).length))}`
                            : '—'}
                        </p>
                      </div>
                      <div className={`rounded-xl border-2 p-5 shadow-sm ${
                        totalCost > 0
                          ? isPositiveROI
                            ? 'border-green-200 bg-gradient-to-br from-green-50 to-emerald-50'
                            : 'border-red-200 bg-gradient-to-br from-red-50 to-orange-50'
                          : 'border-gray-200 bg-white'
                      }`}>
                        <p className={`text-xs font-semibold uppercase tracking-wider ${
                          totalCost > 0
                            ? isPositiveROI ? 'text-green-600' : 'text-red-600'
                            : 'text-gray-500'
                        }`}>
                          ROI {locale === 'es' ? 'Indicador' : 'Indicator'}
                        </p>
                        <p className={`mt-1 text-2xl font-bold ${
                          totalCost > 0
                            ? isPositiveROI ? 'text-green-700' : 'text-red-700'
                            : 'text-gray-900'
                        }`}>
                          {totalCost > 0 ? `${roi > 0 ? '+' : ''}${roi.toFixed(0)}%` : '—'}
                        </p>
                        <p className={`mt-1 text-xs ${
                          totalCost > 0
                            ? isPositiveROI ? 'text-green-500' : 'text-red-500'
                            : 'text-gray-400'
                        }`}>
                          {totalCost > 0
                            ? isPositiveROI
                              ? (locale === 'es' ? 'EMV supera el coste' : 'EMV exceeds cost')
                              : (locale === 'es' ? 'Coste supera el EMV' : 'Cost exceeds EMV')
                            : (locale === 'es' ? 'Añade fees para calcular' : 'Add fees to calculate')}
                        </p>
                      </div>
                    </div>

                    {/* Per-influencer cost breakdown */}
                    {influencers.some(ci => ci.agreedFee) && (
                      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                        <h3 className="text-sm font-semibold text-gray-700 mb-3">
                          {locale === 'es' ? 'Desglose por Influencer' : 'Cost per Influencer'}
                        </h3>
                        <div className="space-y-2">
                          {influencers.filter(ci => ci.influencer && ci.agreedFee).map(ci => (
                            <div key={ci.id} className="flex items-center justify-between text-sm">
                              <span className="text-gray-700">@{ci.influencer.username}</span>
                              <span className="font-medium text-gray-900">€{formatNumber(ci.agreedFee || 0)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Audience Demographics */}
              {influencers.length > 0 && (() => {
                // Calculate platform breakdown
                const platformCounts = influencers.reduce((acc, ci) => {
                  const p = ci.influencer?.platform || 'UNKNOWN'
                  acc[p] = (acc[p] || 0) + 1
                  return acc
                }, {} as Record<string, number>)

                // Calculate location breakdown from influencer data
                const locationCounts = influencers.reduce((acc, ci) => {
                  const inf = ci.influencer as CampaignInfluencer['influencer'] & { country?: string; city?: string }
                  const loc = inf?.country || inf?.city
                  if (loc) acc[loc] = (acc[loc] || 0) + 1
                  return acc
                }, {} as Record<string, number>)

                // Follower tier breakdown
                const tiers = { micro: 0, mid: 0, macro: 0, mega: 0 }
                influencers.forEach(ci => {
                  const f = ci.influencer?.followers || 0
                  if (f < 10000) tiers.micro++
                  else if (f < 100000) tiers.mid++
                  else if (f < 1000000) tiers.macro++
                  else tiers.mega++
                })

                // Average engagement by platform
                const engByPlatform = influencers.reduce((acc, ci) => {
                  const p = ci.influencer?.platform || 'UNKNOWN'
                  if (!acc[p]) acc[p] = { total: 0, count: 0 }
                  acc[p].total += ci.influencer?.engagementRate || 0
                  acc[p].count++
                  return acc
                }, {} as Record<string, { total: number; count: number }>)

                const tierColors = {
                  micro: '#8b5cf6',
                  mid: '#06b6d4',
                  macro: '#f59e0b',
                  mega: '#ec4899',
                }

                const platformColors: Record<string, string> = {
                  INSTAGRAM: '#e11d48',
                  TIKTOK: '#06b6d4',
                  YOUTUBE: '#dc2626',
                }

                return (
                  <div className="space-y-4">
                    <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                      <Globe className="h-5 w-5 text-purple-600" />
                      {t.campaignDetail.audienceDemographics || 'Audience Demographics'}
                    </h2>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                      {/* Platform Breakdown */}
                      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <h3 className="mb-4 text-sm font-semibold text-gray-700">{t.campaignDetail.platformBreakdown || 'Platform Breakdown'}</h3>
                        <div className="space-y-3">
                          {Object.entries(platformCounts).map(([platform, count]) => {
                            const pct = Math.round((count / influencers.length) * 100)
                            return (
                              <div key={platform}>
                                <div className="flex items-center justify-between text-sm">
                                  <span className="flex items-center gap-2 text-gray-700">
                                    <PlatformIcon platform={platform} />
                                    {platform.charAt(0) + platform.slice(1).toLowerCase()}
                                  </span>
                                  <span className="font-medium text-gray-900">{count} ({pct}%)</span>
                                </div>
                                <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                  <div
                                    className="h-full rounded-full transition-all"
                                    style={{ width: `${pct}%`, backgroundColor: platformColors[platform] || '#9ca3af' }}
                                  />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        {/* Avg engagement by platform */}
                        <div className="mt-4 pt-4 border-t border-gray-100">
                          <p className="text-xs font-medium text-gray-500 mb-2">{t.campaignDetail.avgEngByPlatform || 'Avg. Engagement by Platform'}</p>
                          {Object.entries(engByPlatform).map(([platform, data]) => (
                            <div key={platform} className="flex items-center justify-between text-xs text-gray-600">
                              <span>{platform.charAt(0) + platform.slice(1).toLowerCase()}</span>
                              <span className="font-medium text-purple-600">{(data.total / data.count).toFixed(2)}%</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Influencer Tiers */}
                      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <h3 className="mb-4 text-sm font-semibold text-gray-700 flex items-center gap-1">{t.campaignDetail.influencerTiers || 'Influencer Tiers'} <InfoTooltip text={locale === 'es' ? 'Micro: <10K seguidores | Mid: 10K-100K | Macro: 100K-1M | Mega: >1M' : 'Micro: <10K followers | Mid: 10K-100K | Macro: 100K-1M | Mega: >1M'} /></h3>
                        <div className="space-y-3">
                          {([
                            { key: 'mega', label: 'Mega (1M+)', count: tiers.mega },
                            { key: 'macro', label: 'Macro (100K-1M)', count: tiers.macro },
                            { key: 'mid', label: 'Mid (10K-100K)', count: tiers.mid },
                            { key: 'micro', label: 'Micro (<10K)', count: tiers.micro },
                          ] as const).map(tier => {
                            const pct = influencers.length > 0 ? Math.round((tier.count / influencers.length) * 100) : 0
                            return (
                              <div key={tier.key}>
                                <div className="flex items-center justify-between text-sm">
                                  <span className="text-gray-700">{tier.label}</span>
                                  <span className="font-medium text-gray-900">{tier.count} ({pct}%)</span>
                                </div>
                                <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                  <div
                                    className="h-full rounded-full transition-all"
                                    style={{ width: `${pct}%`, backgroundColor: tierColors[tier.key] }}
                                  />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        {/* Total combined audience */}
                        <div className="mt-4 pt-4 border-t border-gray-100">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-gray-500">{t.campaignDetail.combinedAudience || 'Combined Audience'}</span>
                            <span className="text-sm font-bold text-purple-600">
                              {formatNumber(influencers.reduce((s, ci) => s + (ci.influencer?.followers || 0), 0))}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Location / Geo Distribution */}
                      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <h3 className="mb-4 text-sm font-semibold text-gray-700 flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-gray-400" />
                          {t.campaignDetail.geoDistribution || 'Geographic Distribution'}
                        </h3>
                        {Object.keys(locationCounts).length > 0 ? (
                          <div className="space-y-2">
                            {Object.entries(locationCounts)
                              .sort(([, a], [, b]) => b - a)
                              .slice(0, 8)
                              .map(([loc, count]) => {
                                const pct = Math.round((count / influencers.length) * 100)
                                return (
                                  <div key={loc} className="flex items-center justify-between text-sm">
                                    <span className="text-gray-700">{loc}</span>
                                    <span className="font-medium text-gray-900">{count} ({pct}%)</span>
                                  </div>
                                )
                              })}
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center py-8 text-center">
                            <Globe className="h-8 w-8 text-gray-300 mb-2" />
                            <p className="text-xs text-gray-400">{t.campaignDetail.noLocationData || 'Location data will appear as profiles are analyzed'}</p>
                          </div>
                        )}
                        {/* Avg followers per influencer */}
                        <div className="mt-4 pt-4 border-t border-gray-100">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-gray-500">{t.campaignDetail.avgFollowers || 'Avg. Followers/Influencer'}</span>
                            <span className="text-sm font-bold text-gray-900">
                              {formatNumber(Math.round(influencers.reduce((s, ci) => s + (ci.influencer?.followers || 0), 0) / (influencers.length || 1)))}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Growth Charts */}
              {timeline.length > 1 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold text-gray-900">{t.campaignDetail.growthCharts || 'Growth Over Time'}</h2>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.engagementOverTime || 'Engagement Over Time'}
                      dataKeys={[
                        { key: 'likes', color: '#ec4899', name: 'Likes' },
                        { key: 'comments', color: '#8b5cf6', name: 'Comments' },
                      ]}
                    />
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.viewsOverTime || 'Views Over Time'}
                      dataKeys={[
                        { key: 'views', color: '#06b6d4', name: 'Views' },
                      ]}
                    />
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.postsOverTime || 'Posts Over Time'}
                      dataKeys={[
                        { key: 'posts', color: '#7c3aed', name: 'Posts' },
                      ]}
                    />
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.reachOverTime || 'Reach Over Time'}
                      dataKeys={[
                        { key: 'reach', color: '#10b981', name: 'Reach' },
                        { key: 'engagements', color: '#f59e0b', name: 'Engagements' },
                      ]}
                    />
                  </div>
                </div>
              )}

              {/* Influencer Overview Table */}
              <Card variant="elevated">
                <CardHeader>
                  <CardTitle>{t.dashboard.influencers}</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.dashboard.influencers}</TableHead>
                        <TableHead>{t.campaigns.platform}</TableHead>
                        <TableHead>
                          <button
                            onClick={() => toggleReportSort('followers')}
                            className="inline-flex items-center font-medium hover:text-purple-600"
                          >
                            {t.campaigns.followers}
                            <SortIndicator field="followers" sortField={reportSortField} sortDirection={reportSortDirection} />
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            onClick={() => toggleReportSort('engagement')}
                            className="inline-flex items-center font-medium hover:text-purple-600"
                          >
                            {t.campaigns.engagement}
                            <SortIndicator field="engagement" sortField={reportSortField} sortDirection={reportSortDirection} />
                          </button>
                        </TableHead>
                        <TableHead>{t.campaignDetail.avgLikes}</TableHead>
                        <TableHead>{t.campaignDetail.avgComments}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {influencers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="py-12 text-center text-gray-500">
                            {t.common.noResults}
                          </TableCell>
                        </TableRow>
                      ) : (
                        sortedReportInfluencers.filter(ci => ci.influencer).map((ci) => (
                          <TableRow key={ci.id}>
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <Avatar name={ci.influencer.displayName || ci.influencer.username} size="sm" src={ci.influencer.avatarUrl || undefined} />
                                <div>
                                  <p className="font-medium text-gray-900">
                                    {ci.influencer.displayName || ci.influencer.username}
                                  </p>
                                  <p className="text-xs text-gray-500">@{ci.influencer.username}</p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant={platformBadge(ci.influencer.platform)}>
                                <PlatformIcon platform={ci.influencer.platform} />
                                {ci.influencer.platform.charAt(0) + ci.influencer.platform.slice(1).toLowerCase()}
                              </Badge>
                            </TableCell>
                            <TableCell>{formatNumber(ci.influencer.followers)}</TableCell>
                            <TableCell>
                              <span className="text-purple-600">
                                {ci.influencer.engagementRate || 0}%
                              </span>
                            </TableCell>
                            <TableCell>{formatNumber(ci.influencer.avgLikes || 0)}</TableCell>
                            <TableCell>{formatNumber(ci.influencer.avgComments || 0)}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* Media Tab */}
        <TabsContent value="media">
          {media.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm">
              <Image className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.common.noResults}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                {t.campaignDetail.mediaEmptyDesc}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                {isActive && (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={handleTrackNow}
                    disabled={isTracking}
                  >
                    {isTracking ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.campaignDetail.tracking}
                      </>
                    ) : (
                      <>
                        <Radar className="h-4 w-4" />
                        {t.campaignDetail.trackNow}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Sort Controls */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{totalMedia} {t.dashboard.media}</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{t.campaignDetail.sortBy}:</span>
                  {([
                    { key: 'recent', label: t.campaignDetail.mostRecent },
                    { key: 'likes', label: t.campaignDetail.mostLiked },
                    { key: 'comments', label: t.campaignDetail.mostCommented },
                    { key: 'views', label: t.campaignDetail.mostViewed },
                  ] as const).map(opt => (
                    <button
                      key={opt.key}
                      onClick={() => setMediaSortBy(opt.key)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        mediaSortBy === opt.key
                          ? 'bg-purple-100 text-purple-700'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {sortedMedia.map((m) => (
                  <a
                    key={m.id}
                    href={m.permalink || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="relative flex h-48 items-center justify-center bg-gray-100">
                      {m.thumbnailUrl ? (
                        <>
                          <img
                            src={m.thumbnailUrl}
                            alt={m.caption || 'Media'}
                            className="h-full w-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; (e.currentTarget.nextElementSibling as HTMLElement)?.classList.remove('hidden') }}
                          />
                          <div className="hidden flex flex-col items-center gap-2 text-gray-400">
                            <Image className="h-8 w-8" />
                            <span className="text-xs">{m.mediaType}</span>
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-gray-400">
                          <Image className="h-8 w-8" />
                          <span className="text-xs">{m.mediaType}</span>
                        </div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center gap-4 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                        <span className="flex items-center gap-1 text-sm font-semibold text-white">
                          <Heart className="h-4 w-4" />
                          {formatNumber(m.likes || 0)}
                        </span>
                        <span className="flex items-center gap-1 text-sm font-semibold text-white">
                          <BarChart3 className="h-4 w-4" />
                          {formatNumber(m.comments || 0)}
                        </span>
                        {(m.views || 0) > 0 && (
                          <span className="flex items-center gap-1 text-sm font-semibold text-white">
                            <Eye className="h-4 w-4" />
                            {formatNumber(m.views || 0)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="flex items-center gap-2">
                        <Avatar name={m.influencer?.displayName || m.influencer?.username || '?'} size="sm" src={m.influencer?.avatarUrl || undefined} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">
                            {m.influencer?.displayName || m.influencer?.username || 'Unknown'}
                          </p>
                          <p className="truncate text-xs text-gray-500">
                            @{m.influencer?.username || 'unknown'}
                            {m.postedAt && ` · ${new Date(m.postedAt).toLocaleDateString()}`}
                          </p>
                        </div>
                      </div>
                      {m.caption && (
                        <p className="mt-2 line-clamp-2 text-xs text-gray-500">{m.caption}</p>
                      )}
                      <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <Heart className="h-3 w-3" />
                          {formatNumber(m.likes || 0)}
                        </span>
                        <span className="flex items-center gap-1">
                          <BarChart3 className="h-3 w-3" />
                          {formatNumber(m.comments || 0)}
                        </span>
                        <span className="flex items-center gap-1">
                          <TrendingUp className="h-3 w-3" />
                          {formatNumber(m.shares || 0)}
                        </span>
                      </div>
                    </div>
                  </a>
                ))}
              </div>

              {/* Load More button */}
              {hasMoreMedia && (
                <div className="flex justify-center">
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={handleLoadMoreMedia}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.common.loading}
                      </>
                    ) : (
                      t.campaignDetail.loadMore
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* Stories Tab */}
        <TabsContent value="stories">
          {/* Stories Tracker - log and track stories with metrics */}
          <StoriesTracker
            campaignId={campaign.id}
            locale={locale}
            influencers={influencers.map(ci => ({ id: ci.influencer.id, username: ci.influencer.username }))}
          />

          {/* Existing discovered stories */}
          {stories.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm">
              <Film className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.campaignDetail.stories || 'Stories'}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                {t.campaignDetail.storiesEmpty}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                {isActive && (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={handleTrackNow}
                    disabled={isTracking}
                  >
                    {isTracking ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.campaignDetail.tracking}
                      </>
                    ) : (
                      <>
                        <Radar className="h-4 w-4" />
                        {t.campaignDetail.trackNow}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{stories.length} {t.campaignDetail.stories || 'Stories'}</p>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                  <Clock className="h-3 w-3" />
                  {t.campaignDetail.storiesEmpty ? 'Stories expire after 24h' : 'Las stories expiran tras 24h'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {stories.map((story) => {
                  const postedDate = story.postedAt ? new Date(story.postedAt) : null
                  const isExpired = postedDate ? (Date.now() - postedDate.getTime()) > 24 * 60 * 60 * 1000 : true

                  return (
                    <div
                      key={story.id}
                      className="group relative overflow-hidden rounded-xl border-2 border-transparent bg-white shadow-sm transition-all hover:border-purple-300 hover:shadow-md"
                    >
                      {/* Story gradient ring */}
                      <div className={`absolute inset-0 rounded-xl ${isExpired ? 'bg-gray-100' : 'bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400'} p-[2px]`}>
                        <div className="h-full w-full rounded-[10px] bg-white" />
                      </div>

                      <div className="relative">
                        {/* Thumbnail */}
                        <div className="relative aspect-[9/16] overflow-hidden rounded-t-xl bg-gray-100">
                          {story.thumbnailUrl ? (
                            <img
                              src={story.thumbnailUrl}
                              alt="Story"
                              className="h-full w-full object-cover"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-gray-400">
                              <Film className="h-10 w-10" />
                            </div>
                          )}

                          {/* Views overlay */}
                          {(story.views || 0) > 0 && (
                            <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                              <Eye className="h-3 w-3" />
                              {formatNumber(story.views || 0)}
                            </div>
                          )}

                          {/* Expired badge */}
                          {isExpired && (
                            <div className="absolute top-2 right-2 rounded-full bg-gray-900/70 px-2 py-0.5 text-[10px] font-medium text-white">
                              {t.campaignDetail.storyExpired || 'Expired'}
                            </div>
                          )}
                        </div>

                        {/* Creator info */}
                        <div className="p-3">
                          <div className="flex items-center gap-2">
                            <Avatar name={story.influencer?.displayName || story.influencer?.username || '?'} size="sm" src={story.influencer?.avatarUrl || undefined} />
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-gray-900">
                                @{story.influencer?.username || 'unknown'}
                              </p>
                              {postedDate && (
                                <p className="text-[10px] text-gray-400">
                                  {postedDate.toLocaleDateString()} {postedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Influencers Tab */}
        <TabsContent value="influencers">
          <div className="space-y-4">
            {/* Add Influencer Section */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <UserPlus className="h-4 w-4 text-purple-600" />
                <h3 className="text-sm font-semibold text-gray-900">{t.campaigns.addInfluencers}</h3>
              </div>
              <p className="mb-3 text-xs text-gray-500">{t.campaigns.addInfluencersDesc}</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={addInfluencerUsername}
                  onChange={(e) => setAddInfluencerUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddInfluencer()}
                  placeholder={t.campaigns.influencerPlaceholder}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddInfluencer}
                  disabled={isAddingInfluencer || !addInfluencerUsername.trim()}
                >
                  {isAddingInfluencer ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t.common.loading}
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      {t.common.add}
                    </>
                  )}
                </Button>
              </div>
              {addInfluencerResult && (
                <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  addInfluencerResult.type === 'success'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-red-50 text-red-700'
                }`}>
                  {addInfluencerResult.type === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-red-600" />
                  )}
                  {addInfluencerResult.message}
                  <button
                    onClick={() => setAddInfluencerResult(null)}
                    className="ml-auto text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Influencers Table */}
            <Card variant="elevated">
              <CardContent>
                {influencers.length === 0 ? (
                  <div className="py-16 text-center">
                    <Users className="mx-auto h-12 w-12 text-gray-300" />
                    <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.common.noResults}</h3>
                    <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                      {t.campaigns.addInfluencersDesc}
                    </p>
                    <div className="mt-6 flex items-center justify-center gap-3">
                      {isActive && (
                        <Button
                          variant="primary"
                          size="md"
                          onClick={handleTrackNow}
                          disabled={isTracking}
                        >
                          {isTracking ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {t.campaignDetail.tracking}
                            </>
                          ) : (
                            <>
                              <Radar className="h-4 w-4" />
                              {t.campaignDetail.trackNow}
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {sortedInfluencers.filter(ci => ci.influencer).map((ci) => {
                      const cpm = getCPMForInfluencer(ci)
                      const feeValue = editingFee[ci.id] !== undefined ? editingFee[ci.id] : (ci.agreedFee || ci.cost || '')
                      const trafficColors = {
                        green: 'bg-green-100 text-green-800 border-green-300',
                        yellow: 'bg-amber-100 text-amber-800 border-amber-300',
                        red: 'bg-red-100 text-red-800 border-red-300',
                        gray: 'bg-gray-100 text-gray-600 border-gray-300',
                      }
                      const trafficDot = {
                        green: 'bg-green-500',
                        yellow: 'bg-amber-500',
                        red: 'bg-red-500',
                        gray: 'bg-gray-400',
                      }

                      return (
                        <div key={ci.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                          <div className="flex items-start gap-4">
                            {/* Profile */}
                            <div className="flex items-center gap-3 min-w-[200px]">
                              <Avatar name={ci.influencer.displayName || ci.influencer.username} size="md" src={ci.influencer.avatarUrl || undefined} />
                              <div>
                                <p className="font-semibold text-gray-900">{ci.influencer.displayName || ci.influencer.username}</p>
                                <p className="text-xs text-gray-500">@{ci.influencer.username}</p>
                                <div className="mt-1 flex items-center gap-2">
                                  <Badge variant={platformBadge(ci.influencer.platform)}>
                                    <PlatformIcon platform={ci.influencer.platform} />
                                    {ci.influencer.platform.charAt(0) + ci.influencer.platform.slice(1).toLowerCase()}
                                  </Badge>
                                  <span className="text-[10px] text-gray-400 uppercase font-medium">{cpm.tier}</span>
                                </div>
                              </div>
                            </div>

                            {/* Stats */}
                            <div className="flex-1 grid grid-cols-4 gap-3 text-center">
                              <div>
                                <p className="text-[10px] uppercase tracking-wider text-gray-400">{t.campaigns.followers}</p>
                                <p className="text-sm font-bold text-gray-900">{formatNumber(ci.influencer.followers)}</p>
                              </div>
                              <div>
                                <p className="text-[10px] uppercase tracking-wider text-gray-400">{t.campaignDetail.avgViews}</p>
                                <p className="text-sm font-bold text-gray-900">{formatNumber(ci.influencer.avgViews || 0)}</p>
                              </div>
                              <div>
                                <p className="text-[10px] uppercase tracking-wider text-gray-400">{t.campaigns.engagement}</p>
                                <p className="text-sm font-bold text-purple-600">{ci.influencer.engagementRate || 0}%</p>
                              </div>
                              <div>
                                <p className="text-[10px] uppercase tracking-wider text-gray-400">{t.campaignDetail.avgLikes}</p>
                                <p className="text-sm font-bold text-gray-900">{formatNumber(ci.influencer.avgLikes || 0)}</p>
                              </div>
                            </div>

                            {/* Traffic Light */}
                            <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${trafficColors[cpm.trafficLight]}`}>
                              <span className={`h-3 w-3 rounded-full ${trafficDot[cpm.trafficLight]}`} />
                              <span className="text-sm font-bold">{cpm.recommendation}</span>
                            </div>
                          </div>

                          {/* CPM Evaluation Row */}
                          <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-6 gap-3 items-end">
                            {/* Fee Input */}
                            <div>
                              <label className="text-[10px] uppercase tracking-wider text-gray-400 block mb-1">
                                {locale === 'es' ? 'Fee Acordado (€)' : 'Agreed Fee (€)'}
                              </label>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={feeValue}
                                  onChange={(e) => setEditingFee(prev => ({ ...prev, [ci.id]: e.target.value }))}
                                  onBlur={() => {
                                    const val = editingFee[ci.id]
                                    if (val !== undefined && val !== String(ci.agreedFee || ci.cost || '')) {
                                      handleSaveFee(ci.id, ci.influencer.id, val)
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      handleSaveFee(ci.id, ci.influencer.id, editingFee[ci.id] || '0')
                                    }
                                  }}
                                  placeholder={ci.influencer.standardFee ? `Std: €${ci.influencer.standardFee}` : '0'}
                                  className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-medium text-gray-900 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                                />
                                {savingFee === ci.id && <Loader2 className="h-3 w-3 animate-spin text-purple-500 shrink-0" />}
                              </div>
                              {ci.influencer.standardFee && (
                                <p className="mt-0.5 text-[10px] text-gray-400">
                                  {locale === 'es' ? 'Tarifa estándar' : 'Standard rate'}: €{ci.influencer.standardFee.toLocaleString()}
                                </p>
                              )}
                            </div>

                            {/* CPM Real */}
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-gray-400 flex items-center gap-1">CPM Real <InfoTooltip text={locale === 'es' ? 'Coste por mil visualizaciones = (Fee / Avg Views) × 1.000' : 'Cost per thousand views = (Fee / Avg Views) × 1,000'} /></p>
                              <p className="text-sm font-bold text-gray-900">
                                {cpm.cpmReal !== null ? `€${cpm.cpmReal.toFixed(2)}` : '—'}
                              </p>
                            </div>

                            {/* CPM Target */}
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-gray-400">CPM {locale === 'es' ? 'Objetivo' : 'Target'}</p>
                              <p className="text-sm font-medium text-gray-600">
                                {cpm.cpmTarget !== null ? `€${cpm.cpmTarget}` : '—'}
                              </p>
                            </div>

                            {/* Fee Recommended */}
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-gray-400">Fee {locale === 'es' ? 'Recomendado' : 'Recommended'}</p>
                              <p className="text-sm font-bold text-green-600">
                                {cpm.feeRecommended !== null ? `€${cpm.feeRecommended.toLocaleString()}` : '—'}
                              </p>
                            </div>

                            {/* Fee Max */}
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-gray-400">Fee {locale === 'es' ? 'Maximo' : 'Max'}</p>
                              <p className="text-sm font-medium text-amber-600">
                                {cpm.feeMax !== null ? `€${cpm.feeMax.toLocaleString()}` : '—'}
                              </p>
                            </div>

                            {/* Savings/Overcost */}
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-gray-400">{locale === 'es' ? 'Diferencia' : 'Diff'}</p>
                              {cpm.savingsOrOvercost !== null ? (
                                <p className={`text-sm font-bold ${cpm.savingsOrOvercost > 0 ? 'text-red-600' : 'text-green-600'}`}>
                                  {cpm.savingsOrOvercost > 0 ? '+' : ''}{cpm.savingsOrOvercost > 0 ? `€${cpm.savingsOrOvercost.toLocaleString()}` : `-€${Math.abs(cpm.savingsOrOvercost).toLocaleString()}`}
                                </p>
                              ) : <p className="text-sm text-gray-400">—</p>}
                            </div>
                          </div>

                          {/* Recommendation Detail */}
                          {cpm.recommendationDetail && (
                            <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                              cpm.trafficLight === 'green' ? 'bg-green-50 text-green-700' :
                              cpm.trafficLight === 'yellow' ? 'bg-amber-50 text-amber-700' :
                              cpm.trafficLight === 'red' ? 'bg-red-50 text-red-700' :
                              'bg-gray-50 text-gray-600'
                            }`}>
                              {cpm.recommendationDetail}
                            </div>
                          )}

                          {/* Notes & History */}
                          <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
                            <CampaignNotesButton
                              campaignId={campaignId}
                              influencerId={ci.influencer.id}
                              locale={locale}
                            />
                            <InfluencerHistoryButton
                              influencerId={ci.influencer.id}
                              influencerName={ci.influencer.displayName || ci.influencer.username}
                              locale={locale}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* UGC Creators Tab */}
        <TabsContent value="creators">
          <div className="space-y-4">
            {/* Add Creator Section */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <UserPlus className="h-4 w-4 text-purple-600" />
                <h3 className="text-sm font-semibold text-gray-900">
                  {locale === 'es' ? 'Añadir Creador UGC' : 'Add UGC Creator'}
                </h3>
              </div>
              <p className="mb-3 text-xs text-gray-500">
                {locale === 'es'
                  ? 'Añade creadores UGC por su handle de Instagram. Podrás gestionar pagos y portfolio desde aquí.'
                  : 'Add UGC creators by their Instagram handle. You can manage payments and portfolio from here.'}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={addInfluencerUsername}
                  onChange={(e) => setAddInfluencerUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddInfluencer()}
                  placeholder="@creator_handle"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddInfluencer}
                  disabled={isAddingInfluencer || !addInfluencerUsername.trim()}
                >
                  {isAddingInfluencer ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t.common.loading}
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      {t.common.add}
                    </>
                  )}
                </Button>
              </div>
              {addInfluencerResult && (
                <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  addInfluencerResult.type === 'success'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-red-50 text-red-700'
                }`}>
                  {addInfluencerResult.type === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-red-600" />
                  )}
                  {addInfluencerResult.message}
                  <button
                    onClick={() => setAddInfluencerResult(null)}
                    className="ml-auto text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {/* UGC Summary Stats */}
            {influencers.length > 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <p className="text-xs uppercase tracking-wider text-gray-400">{locale === 'es' ? 'Total Creadores' : 'Total Creators'}</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{influencers.length}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <p className="text-xs uppercase tracking-wider text-gray-400">{locale === 'es' ? 'Coste Total' : 'Total Cost'}</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">
                    €{influencers.reduce((sum, ci) => sum + (ci.agreedFee || ci.cost || 0), 0).toLocaleString()}
                  </p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <p className="text-xs uppercase tracking-wider text-gray-400">{locale === 'es' ? 'Contenido Entregado' : 'Content Delivered'}</p>
                  <p className="mt-1 text-2xl font-bold text-green-600">
                    {influencers.filter(ci => ci.contentDelivered).length}/{influencers.length}
                  </p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <p className="text-xs uppercase tracking-wider text-gray-400">{locale === 'es' ? 'Coste Medio' : 'Avg Cost'}</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">
                    €{influencers.length > 0
                      ? Math.round(influencers.reduce((sum, ci) => sum + (ci.agreedFee || ci.cost || 0), 0) / influencers.length).toLocaleString()
                      : 0}
                  </p>
                </div>
              </div>
            )}

            {/* UGC Creators Cards */}
            <Card variant="elevated">
              <CardContent>
                {influencers.length === 0 ? (
                  <div className="py-16 text-center">
                    <Video className="mx-auto h-12 w-12 text-gray-300" />
                    <h3 className="mt-4 text-lg font-semibold text-gray-700">
                      {locale === 'es' ? 'Sin creadores todavía' : 'No creators yet'}
                    </h3>
                    <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                      {locale === 'es'
                        ? 'Añade creadores UGC usando el campo de arriba para gestionar pagos y entregas.'
                        : 'Add UGC creators using the field above to manage payments and deliveries.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {influencers.filter(ci => ci.influencer).map((ci) => {
                      const feeValue = editingFee[ci.id] !== undefined ? editingFee[ci.id] : (ci.agreedFee || ci.cost || '')
                      return (
                        <div key={ci.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                          <div className="flex items-start gap-4">
                            {/* Profile */}
                            <div className="flex items-center gap-3 min-w-[200px]">
                              <Avatar name={ci.influencer.displayName || ci.influencer.username} size="md" src={ci.influencer.avatarUrl || undefined} />
                              <div>
                                <p className="font-semibold text-gray-900">{ci.influencer.displayName || ci.influencer.username}</p>
                                <p className="text-xs text-gray-500">@{ci.influencer.username}</p>
                                <div className="mt-1 flex items-center gap-2">
                                  <span className="text-xs text-gray-400">{formatNumber(ci.influencer.followers)} {t.campaigns.followers}</span>
                                </div>
                              </div>
                            </div>

                            {/* Payment & Status */}
                            <div className="flex-1 grid grid-cols-3 gap-4 items-start">
                              {/* Payment */}
                              <div>
                                <label className="text-[10px] uppercase tracking-wider text-gray-400 block mb-1">
                                  {locale === 'es' ? 'Pago (€)' : 'Payment (€)'}
                                </label>
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number"
                                    value={feeValue}
                                    onChange={(e) => setEditingFee(prev => ({ ...prev, [ci.id]: e.target.value }))}
                                    onBlur={() => {
                                      const val = editingFee[ci.id]
                                      if (val !== undefined && val !== String(ci.agreedFee || ci.cost || '')) {
                                        handleSaveFee(ci.id, ci.influencer.id, val)
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        handleSaveFee(ci.id, ci.influencer.id, editingFee[ci.id] || '0')
                                      }
                                    }}
                                    placeholder="0"
                                    className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-medium text-gray-900 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                                  />
                                  {savingFee === ci.id && <Loader2 className="h-3 w-3 animate-spin text-purple-500 shrink-0" />}
                                </div>
                              </div>

                              {/* Portfolio Link */}
                              <div>
                                <label className="text-[10px] uppercase tracking-wider text-gray-400 block mb-1">
                                  <Link2 className="inline h-3 w-3" /> Portfolio
                                </label>
                                <div className="flex items-center gap-1">
                                  <input
                                    type="url"
                                    defaultValue={ci.portfolioUrl || ''}
                                    onBlur={async (e) => {
                                      const url = e.target.value.trim()
                                      try {
                                        await fetch(`/api/campaigns/${campaignId}/influencers`, {
                                          method: 'PATCH',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ influencerId: ci.influencer.id, portfolioUrl: url }),
                                        })
                                      } catch { /* ignore */ }
                                    }}
                                    placeholder={locale === 'es' ? 'https://portfolio...' : 'https://portfolio...'}
                                    className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-900 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                                  />
                                  {ci.portfolioUrl && (
                                    <a href={ci.portfolioUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-purple-500 hover:text-purple-700">
                                      <ExternalLink className="h-4 w-4" />
                                    </a>
                                  )}
                                </div>
                              </div>

                              {/* Content Delivered Toggle */}
                              <div>
                                <label className="text-[10px] uppercase tracking-wider text-gray-400 block mb-1">
                                  <Package className="inline h-3 w-3" /> {locale === 'es' ? 'Entregado' : 'Delivered'}
                                </label>
                                <button
                                  onClick={async () => {
                                    try {
                                      await fetch(`/api/campaigns/${campaignId}/influencers`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                          influencerId: ci.influencer.id,
                                          contentDelivered: !ci.contentDelivered,
                                        }),
                                      })
                                      await fetchCampaign()
                                    } catch { /* ignore */ }
                                  }}
                                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all ${
                                    ci.contentDelivered
                                      ? 'border-green-300 bg-green-50 text-green-700'
                                      : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300'
                                  }`}
                                >
                                  {ci.contentDelivered ? (
                                    <>
                                      <CheckCircle2 className="h-4 w-4" />
                                      {locale === 'es' ? 'Entregado' : 'Delivered'}
                                    </>
                                  ) : (
                                    <>
                                      <Clock className="h-4 w-4" />
                                      {locale === 'es' ? 'Pendiente' : 'Pending'}
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Pipeline Status */}
                          <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-3">
                            <span className="text-[10px] uppercase tracking-wider text-gray-400">
                              {locale === 'es' ? 'Estado' : 'Status'}:
                            </span>
                            <select
                              className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600 outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400"
                              value={ci.status || 'PROSPECT'}
                              onChange={async (e) => {
                                try {
                                  await fetch(`/api/campaigns/${campaignId}/influencers`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ influencerId: ci.influencer.id, status: e.target.value }),
                                  })
                                  await fetchCampaign()
                                } catch { /* ignore */ }
                              }}
                            >
                              <option value="PROSPECT">{t.pipeline.prospect}</option>
                              <option value="OUTREACH">{t.pipeline.outreach}</option>
                              <option value="NEGOTIATING">{t.pipeline.negotiating}</option>
                              <option value="AGREED">{t.pipeline.agreed}</option>
                              <option value="CONTRACTED">{t.pipeline.contracted}</option>
                              <option value="SHIPPING">{locale === 'es' ? 'Envío' : 'Shipping'}</option>
                              <option value="POSTED">{t.pipeline.posted}</option>
                              <option value="COMPLETED">{t.pipeline.completed}</option>
                            </select>
                            {ci.notes && (
                              <span className="text-xs text-gray-400 truncate max-w-xs">{ci.notes}</span>
                            )}
                            <div className="ml-auto flex items-center gap-2">
                              <CampaignNotesButton
                                campaignId={campaignId}
                                influencerId={ci.influencer.id}
                                locale={locale}
                              />
                              <InfluencerHistoryButton
                                influencerId={ci.influencer.id}
                                influencerName={ci.influencer.displayName || ci.influencer.username}
                                locale={locale}
                              />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Pipeline Kanban Tab */}
        <TabsContent value="pipeline">
          <div className="overflow-x-auto pb-4">
            <div className="flex gap-4" style={{ minWidth: 'max-content' }}>
              {([
                { key: 'PROSPECT', label: t.pipeline.prospect, color: 'gray' },
                { key: 'OUTREACH', label: t.pipeline.outreach, color: 'blue' },
                { key: 'NEGOTIATING', label: t.pipeline.negotiating, color: 'amber' },
                { key: 'AGREED', label: t.pipeline.agreed, color: 'purple' },
                { key: 'CONTRACTED', label: t.pipeline.contracted, color: 'indigo' },
                { key: 'SHIPPING', label: locale === 'es' ? 'Envío' : 'Shipping', color: 'orange' },
                { key: 'POSTED', label: t.pipeline.posted, color: 'cyan' },
                { key: 'COMPLETED', label: t.pipeline.completed, color: 'green' },
              ] as const).map((col) => {
                const colInfluencers = influencers.filter(
                  (ci) => (ci.status || 'PROSPECT') === col.key
                )
                const colorMap: Record<string, { bg: string; border: string; text: string; headerBg: string; dot: string }> = {
                  gray: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-700', headerBg: 'bg-gray-100', dot: 'bg-gray-400' },
                  blue: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', headerBg: 'bg-blue-100', dot: 'bg-blue-400' },
                  amber: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', headerBg: 'bg-amber-100', dot: 'bg-amber-400' },
                  purple: { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', headerBg: 'bg-purple-100', dot: 'bg-purple-400' },
                  indigo: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700', headerBg: 'bg-indigo-100', dot: 'bg-indigo-400' },
                  orange: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', headerBg: 'bg-orange-100', dot: 'bg-orange-400' },
                  cyan: { bg: 'bg-cyan-50', border: 'border-cyan-200', text: 'text-cyan-700', headerBg: 'bg-cyan-100', dot: 'bg-cyan-400' },
                  green: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', headerBg: 'bg-green-100', dot: 'bg-green-400' },
                }
                const colors = colorMap[col.color]
                return (
                  <div
                    key={col.key}
                    className={`w-[280px] shrink-0 rounded-xl border ${colors.border} ${colors.bg} shadow-sm`}
                  >
                    {/* Column Header */}
                    <div className={`flex items-center justify-between rounded-t-xl px-4 py-3 ${colors.headerBg}`}>
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${colors.dot}`} />
                        <span className={`text-sm font-semibold ${colors.text}`}>{col.label}</span>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors.text} ${colors.bg}`}>
                        {colInfluencers.length}
                      </span>
                    </div>

                    {/* Column Cards */}
                    <div className="space-y-3 p-3" style={{ minHeight: '120px' }}>
                      {colInfluencers.length === 0 ? (
                        <p className="py-6 text-center text-xs text-gray-400">{t.pipeline.noInfluencers}</p>
                      ) : (
                        colInfluencers.map((ci) => (
                          <div key={ci.id} className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
                            <div className="flex items-center gap-2.5">
                              <Avatar
                                src={ci.influencer.avatarUrl || undefined}
                                name={ci.influencer.displayName || ci.influencer.username}
                                size="sm"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-gray-900">
                                  @{ci.influencer.username}
                                </p>
                                <div className="flex items-center gap-2 text-xs text-gray-500">
                                  <Badge variant={ci.influencer.platform === 'INSTAGRAM' ? 'instagram' : ci.influencer.platform === 'YOUTUBE' ? 'youtube' : ci.influencer.platform === 'TIKTOK' ? 'tiktok' : 'default'} className="text-[10px] px-1.5 py-0">
                                    {ci.influencer.platform === 'INSTAGRAM' ? 'IG' : ci.influencer.platform === 'YOUTUBE' ? 'YT' : ci.influencer.platform === 'TIKTOK' ? 'TT' : ci.influencer.platform}
                                  </Badge>
                                  <span>{formatNumber(ci.influencer.followers)}</span>
                                </div>
                              </div>
                            </div>
                            {ci.influencer.engagementRate != null && (
                              <div className="mt-2 flex items-center gap-1 text-xs text-gray-500">
                                <TrendingUp className="h-3 w-3" />
                                <span>{ci.influencer.engagementRate.toFixed(1)}% eng.</span>
                              </div>
                            )}
                            {/* Shipping data button for SHIPPING column */}
                            {col.key === 'SHIPPING' && (
                              <button
                                onClick={() => openShippingModal(ci)}
                                className={`mt-2 w-full flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-all ${
                                  ci.shippingAddress1
                                    ? 'border-green-300 bg-green-50 text-green-700'
                                    : 'border-orange-300 bg-orange-50 text-orange-700 animate-pulse'
                                }`}
                              >
                                <Truck className="h-3 w-3" />
                                {ci.shippingAddress1
                                  ? (locale === 'es' ? 'Datos de envío ✓' : 'Shipping data ✓')
                                  : (locale === 'es' ? 'Añadir datos envío' : 'Add shipping data')}
                              </button>
                            )}
                            {/* Move-to select */}
                            <select
                              className="mt-2 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-600 outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400"
                              value={ci.status || 'PROSPECT'}
                              onChange={async (e) => {
                                const newStatus = e.target.value
                                try {
                                  await fetch(`/api/campaigns/${campaignId}/influencers`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ influencerId: ci.influencer.id, status: newStatus }),
                                  })
                                  await fetchCampaign()
                                } catch (err) {
                                  console.error('Error updating status:', err)
                                }
                              }}
                            >
                              <option value="PROSPECT">{t.pipeline.prospect}</option>
                              <option value="OUTREACH">{t.pipeline.outreach}</option>
                              <option value="NEGOTIATING">{t.pipeline.negotiating}</option>
                              <option value="AGREED">{t.pipeline.agreed}</option>
                              <option value="CONTRACTED">{t.pipeline.contracted}</option>
                              <option value="SHIPPING">{locale === 'es' ? 'Envío' : 'Shipping'}</option>
                              <option value="POSTED">{t.pipeline.posted}</option>
                              <option value="COMPLETED">{t.pipeline.completed}</option>
                            </select>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Download shipping CSV button for SHIPPING column */}
                    {col.key === 'SHIPPING' && colInfluencers.length > 0 && (
                      <div className="border-t border-orange-200 px-3 py-2">
                        <a
                          href={`/api/campaigns/${campaignId}/shipping`}
                          download
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white hover:bg-orange-700 transition-colors"
                        >
                          <Download className="h-3 w-3" />
                          {locale === 'es' ? 'Descargar CSV Envíos' : 'Download Shipping CSV'}
                        </a>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Edit Campaign Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-gray-900">
                {locale === 'es' ? 'Editar Campaña' : 'Edit Campaign'}
              </h2>
              <button onClick={() => setShowEditModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  {t.campaigns.campaignName}
                </label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>

              {/* Status */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  {t.common.status}
                </label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm(prev => ({ ...prev, status: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 bg-white"
                >
                  <option value="ACTIVE">{t.common.active}</option>
                  <option value="PAUSED">{t.common.paused}</option>
                  <option value="ARCHIVED">{t.common.archived}</option>
                </select>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">
                    {t.campaigns.startDateLabel || 'Start Date'}
                  </label>
                  <input
                    type="date"
                    value={editForm.startDate}
                    onChange={(e) => setEditForm(prev => ({ ...prev, startDate: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">
                    {t.campaigns.endDateLabel || 'End Date'}
                  </label>
                  <input
                    type="date"
                    value={editForm.endDate}
                    onChange={(e) => setEditForm(prev => ({ ...prev, endDate: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                  />
                </div>
              </div>

              {/* Country */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  {locale === 'es' ? 'País' : 'Country'}
                </label>
                <select
                  value={editForm.country}
                  onChange={(e) => setEditForm(prev => ({ ...prev, country: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 bg-white"
                >
                  <option value="">{locale === 'es' ? 'Todos los países' : 'All countries'}</option>
                  <option value="ES">Spain</option>
                  <option value="MX">Mexico</option>
                  <option value="AR">Argentina</option>
                  <option value="CO">Colombia</option>
                  <option value="CL">Chile</option>
                  <option value="PE">Peru</option>
                  <option value="US">United States</option>
                  <option value="UK">United Kingdom</option>
                  <option value="FR">France</option>
                  <option value="DE">Germany</option>
                  <option value="IT">Italy</option>
                  <option value="PT">Portugal</option>
                  <option value="BR">Brazil</option>
                </select>
              </div>

              {/* Hashtags */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  {t.campaigns.trackingHashtags}
                </label>
                <input
                  type="text"
                  value={editForm.targetHashtags}
                  onChange={(e) => setEditForm(prev => ({ ...prev, targetHashtags: e.target.value }))}
                  placeholder="#hashtag1, #hashtag2"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
                <p className="mt-1 text-xs text-gray-400">{locale === 'es' ? 'Separados por comas' : 'Comma separated'}</p>
              </div>

              {/* Accounts */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  {t.campaigns.trackingAccounts}
                </label>
                <input
                  type="text"
                  value={editForm.targetAccounts}
                  onChange={(e) => setEditForm(prev => ({ ...prev, targetAccounts: e.target.value }))}
                  placeholder="@account1, @account2"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
                <p className="mt-1 text-xs text-gray-400">{locale === 'es' ? 'Separados por comas' : 'Comma separated'}</p>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={() => setShowEditModal(false)}>
                {t.common.cancel}
              </Button>
              <Button variant="primary" onClick={handleSaveCampaign} disabled={isSaving || !editForm.name.trim()}>
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t.common.loading}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    {t.common.save}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Shipping Data Modal */}
      {shippingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Truck className="h-5 w-5 text-orange-600" />
                <h2 className="text-lg font-bold text-gray-900">
                  {locale === 'es' ? 'Datos de Envío' : 'Shipping Data'}
                </h2>
              </div>
              <button onClick={() => setShippingModal(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-gray-500">
              {locale === 'es'
                ? 'Rellena los datos necesarios para el envío. No todos los campos son obligatorios.'
                : 'Fill in the data needed for shipping. Not all fields are required.'}
            </p>
            <div className="space-y-3">
              {[
                { key: 'shippingName', label: locale === 'es' ? 'Nombre destinatario' : 'Recipient Name', placeholder: 'Carmen Otero' },
                { key: 'shippingAddress1', label: locale === 'es' ? 'Dirección' : 'Address', placeholder: 'Paseo Delivias 35, 3º 4ª' },
                { key: 'shippingAddress2', label: locale === 'es' ? 'Dirección 2 (opcional)' : 'Address Line 2 (optional)', placeholder: '' },
                { key: 'shippingCity', label: locale === 'es' ? 'Ciudad' : 'City', placeholder: 'Madrid' },
                { key: 'shippingPostCode', label: locale === 'es' ? 'Código Postal' : 'Post Code', placeholder: '28006' },
                { key: 'shippingCountry', label: locale === 'es' ? 'País' : 'Country', placeholder: 'SPAIN' },
                { key: 'shippingPhone', label: locale === 'es' ? 'Teléfono' : 'Phone', placeholder: '675859632' },
                { key: 'shippingEmail', label: 'Email', placeholder: 'email@example.com' },
                { key: 'shippingProduct', label: locale === 'es' ? 'Producto / SKU' : 'Product / SKU', placeholder: 'SKU1' },
                { key: 'shippingQty', label: locale === 'es' ? 'Cantidad' : 'Quantity', placeholder: '1' },
                { key: 'shippingComments', label: locale === 'es' ? 'Comentarios' : 'Comments', placeholder: '' },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
                  <input
                    type={key === 'shippingQty' ? 'number' : 'text'}
                    value={shippingForm[key] || ''}
                    onChange={(e) => setShippingForm(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                  />
                </div>
              ))}
            </div>
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={() => setShippingModal(null)}>
                {t.common.cancel}
              </Button>
              <Button
                variant="primary"
                onClick={() => handleSaveShipping(shippingModal)}
                disabled={isSavingShipping}
              >
                {isSavingShipping ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t.common.loading}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    {locale === 'es' ? 'Guardar Datos' : 'Save Data'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Save as Template Modal */}
      <Modal open={showTemplateModal} onClose={() => setShowTemplateModal(false)}>
        <ModalHeader onClose={() => setShowTemplateModal(false)}>
          {locale === 'es' ? 'Guardar como Plantilla' : 'Save as Template'}
        </ModalHeader>
        <ModalBody>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                {locale === 'es' ? 'Nombre de la plantilla' : 'Template Name'}
              </label>
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                placeholder={locale === 'es' ? 'Nombre de la plantilla' : 'Template name'}
              />
            </div>
            <p className="text-xs text-gray-500">
              {locale === 'es'
                ? 'Se guardara el tipo, plataformas, pais, tipo de pago, cuentas objetivo, hashtags y brief de esta campana.'
                : 'This will save the type, platforms, country, payment type, target accounts, hashtags and brief from this campaign.'}
            </p>
            {templateResult && (
              <div className={`rounded-lg px-4 py-3 text-sm ${
                templateResult.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}>
                {templateResult.message}
              </div>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setShowTemplateModal(false)}>
            {t.common.cancel}
          </Button>
          <Button
            onClick={handleSaveTemplate}
            disabled={!templateName.trim() || isSavingTemplate}
          >
            {isSavingTemplate ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t.common.loading}
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                {locale === 'es' ? 'Guardar Plantilla' : 'Save Template'}
              </>
            )}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  )
}

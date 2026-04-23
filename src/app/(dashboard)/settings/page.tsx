"use client"

import { useState, useEffect } from "react"
import { useI18n } from '@/i18n/context'
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar } from "@/components/ui/avatar"
import { Select } from "@/components/ui/select"
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/modal"
import {
  User,
  Users,
  Plug,
  CreditCard,
  Camera,
  Trash2,
  Pencil,
  Send,
  Check,
  ExternalLink,
  Key,
  Zap,
  Loader2,
  RotateCcw,
  XCircle,
  Moon,
  Sun,
  FileText,
  Instagram,
  Youtube,
  BarChart3,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { useTheme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'

// ---------- Interfaces ----------

interface TeamUser {
  id: string
  name: string
  email: string
  role: string
  avatar: string | null
  isActive: boolean
  createdAt: string
}

interface PendingInvitation {
  id: string
  email: string
  role: string
  expiresAt: string
  createdAt: string
  user: { name: string }
}

interface CampaignTemplate {
  id: string
  name: string
  type: string | null
  platforms: string[]
  country: string | null
  paymentType: string | null
  targetAccounts: string[]
  targetHashtags: string[]
  briefText: string | null
  createdAt: string
}

// ---------- Mock Data ----------

const mockProfile = {
  name: "David Calamardo",
  email: "david@tkoc.com",
  company: "TKOC Agency",
}

interface Integration {
  id: string
  name: string
  description: string
  connected: boolean
  icon: React.ReactNode
  color: string
}

const mockIntegrations: Integration[] = [
  {
    id: "instagram",
    name: "Instagram",
    description: "trackStoriesDesc",
    connected: true,
    icon: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
      </svg>
    ),
    color: "text-pink-400",
  },
  {
    id: "tiktok",
    name: "TikTok",
    description: "monitorTiktokDesc",
    connected: false,
    icon: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
        <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
      </svg>
    ),
    color: "text-cyan-400",
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "trackYoutubeDesc",
    connected: false,
    icon: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
        <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    ),
    color: "text-red-400",
  },
]

// ---------- Component ----------

export default function SettingsPage() {
  const { t, locale } = useI18n()
  const { theme, toggleTheme } = useTheme()
  const [currentUserRole, setCurrentUserRole] = useState<string>('')
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const isAdmin = currentUserRole === 'ADMIN'

  // Profile state
  const [profileName, setProfileName] = useState(mockProfile.name)
  const [profileEmail, setProfileEmail] = useState(mockProfile.email)
  const [profileCompany, setProfileCompany] = useState(mockProfile.company)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)

  // Team state
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([])
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([])
  const [teamLoading, setTeamLoading] = useState(true)
  const [inviteSending, setInviteSending] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("Employee")

  // Integrations state
  const [integrations, setIntegrations] = useState(mockIntegrations)
  const [apifyKey, setApifyKey] = useState("")
  const [apifySaving, setApifySaving] = useState(false)
  const [apifySaved, setApifySaved] = useState(false)
  const [integrationsLoading, setIntegrationsLoading] = useState(true)
  const [integrationSaving, setIntegrationSaving] = useState<string | null>(null)

  // API Keys state
  const [youtubeApiKey, setYoutubeApiKey] = useState("")
  const [youtubeKeySaving, setYoutubeKeySaving] = useState(false)
  const [youtubeKeySaved, setYoutubeKeySaved] = useState(false)
  const [youtubeTestResult, setYoutubeTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [metaTestResult, setMetaTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [testingConnection, setTestingConnection] = useState<string | null>(null)

  // Templates state
  const [campaignTemplates, setCampaignTemplates] = useState<CampaignTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null)

  // Brand Assignments state
  interface BrandAssignment {
    brandId: string
    brandName: string
    brandEmail: string
    employees: { id: string; name: string; email: string }[]
  }
  const [brandAssignments, setBrandAssignments] = useState<BrandAssignment[]>([])
  const [allEmployees, setAllEmployees] = useState<{ id: string; name: string; email: string }[]>([])
  const [brandAssignmentsLoading, setBrandAssignmentsLoading] = useState(true)
  const [brandAssignmentSaving, setBrandAssignmentSaving] = useState<string | null>(null)

  // Benchmarks state
  type FeeRangesData = Record<string, Record<string, Record<string, [number, number, number, number]>>>
  type CpmRateEntry = { platform: string; tier: string; cpmTarget: number; cpmMax: number }
  type EmvRatesData = {
    cpmRates: Record<string, Record<string, number>>
    cpc: number
    engagementValues: Record<string, Record<string, number>>
  }
  const [benchmarkFeeRanges, setBenchmarkFeeRanges] = useState<FeeRangesData | null>(null)
  const [benchmarkCpmRates, setBenchmarkCpmRates] = useState<CpmRateEntry[] | null>(null)
  const [benchmarkEmvRates, setBenchmarkEmvRates] = useState<EmvRatesData | null>(null)
  const [benchmarksLoading, setBenchmarksLoading] = useState(true)
  const [benchmarkSaving, setBenchmarkSaving] = useState<string | null>(null)
  const [benchmarkSaveResult, setBenchmarkSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [feeRangesOpen, setFeeRangesOpen] = useState(true)
  const [cpmThresholdsOpen, setCpmThresholdsOpen] = useState(false)
  const [emvRatesOpen, setEmvRatesOpen] = useState(false)

  // Brand-specific benchmarks state
  const [benchmarkBrands, setBenchmarkBrands] = useState<{ id: string; name: string }[]>([])
  const [selectedBenchmarkBrand, setSelectedBenchmarkBrand] = useState<string>('')
  const [benchmarkBrandOverrides, setBenchmarkBrandOverrides] = useState<{
    feeRanges: boolean; cpmRates: boolean; emvRates: boolean
  } | null>(null)

  // ---------- Team Data Fetch ----------

  useEffect(() => {
    fetchTeam()
    fetchTemplates()
    fetchIntegrations()
    fetchBenchmarks()
    fetchBrandAssignments()
    fetchBenchmarkBrands()
    // Fetch current user role
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.user?.role) setCurrentUserRole(d.user.role)
      if (d?.user?.id) setCurrentUserId(d.user.id)
    }).catch(() => {})
  }, [])

  async function fetchTeam() {
    try {
      const res = await fetch('/api/team/invite')
      if (res.ok) {
        const data = await res.json()
        setTeamUsers(data.users || [])
        setPendingInvitations(data.invitations || [])
      }
    } catch {} finally {
      setTeamLoading(false)
    }
  }

  async function fetchTemplates() {
    try {
      const res = await fetch('/api/templates')
      if (res.ok) {
        const data = await res.json()
        setCampaignTemplates(data.templates || [])
      }
    } catch {} finally {
      setTemplatesLoading(false)
    }
  }

  async function fetchIntegrations() {
    try {
      const res = await fetch('/api/settings/integrations')
      if (res.ok) {
        const data = await res.json()
        const intData = data.integrations
        // Update integrations state with real connection statuses
        setIntegrations(prev =>
          prev.map(i => {
            if (i.id === 'instagram') return { ...i, connected: intData.instagram?.connected || false }
            if (i.id === 'tiktok') return { ...i, connected: intData.tiktok?.connected || false }
            if (i.id === 'youtube') return { ...i, connected: intData.youtube?.connected || false }
            return i
          })
        )
        // Load API keys from DB
        if (intData.apify?.key) {
          setApifyKey(intData.apify.key)
        }
        if (intData.youtube?.apiKey) {
          setYoutubeApiKey(intData.youtube.apiKey)
        }
      }
    } catch {} finally {
      setIntegrationsLoading(false)
    }
  }

  async function fetchBenchmarks(brandId?: string) {
    try {
      const url = brandId
        ? `/api/settings/benchmarks?brandId=${encodeURIComponent(brandId)}`
        : '/api/settings/benchmarks'
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setBenchmarkFeeRanges(data.feeRanges)
        setBenchmarkCpmRates(data.cpmRates)
        setBenchmarkEmvRates(data.emvRates)
        if (data.hasBrandOverrides) {
          setBenchmarkBrandOverrides(data.hasBrandOverrides)
        } else {
          setBenchmarkBrandOverrides(null)
        }
      }
    } catch {} finally {
      setBenchmarksLoading(false)
    }
  }

  async function fetchBenchmarkBrands() {
    try {
      const res = await fetch('/api/brands')
      if (res.ok) {
        const data = await res.json()
        setBenchmarkBrands((data.brands || []).map((b: { id: string; name: string }) => ({ id: b.id, name: b.name })))
      }
    } catch {}
  }

  async function fetchBrandAssignments() {
    try {
      const res = await fetch('/api/team/brand-assignments')
      if (res.ok) {
        const data = await res.json()
        setBrandAssignments(data.assignments || [])
        setAllEmployees(data.allEmployees || [])
      }
    } catch {} finally {
      setBrandAssignmentsLoading(false)
    }
  }

  async function handleToggleBrandEmployee(brandId: string, employeeId: string, assigned: boolean) {
    setBrandAssignmentSaving(`${brandId}_${employeeId}`)
    try {
      const res = await fetch('/api/team/brand-assignments', {
        method: assigned ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandId, employeeId }),
      })
      if (res.ok) {
        // Update local state
        setBrandAssignments(prev =>
          prev.map(ba => {
            if (ba.brandId !== brandId) return ba
            if (assigned) {
              return { ...ba, employees: ba.employees.filter(e => e.id !== employeeId) }
            } else {
              const emp = allEmployees.find(e => e.id === employeeId)
              if (!emp) return ba
              return { ...ba, employees: [...ba.employees, emp] }
            }
          })
        )
      }
    } catch {} finally {
      setBrandAssignmentSaving(null)
    }
  }

  async function saveBenchmark(key: string, value: unknown) {
    setBenchmarkSaving(key)
    setBenchmarkSaveResult(null)
    try {
      const bodyObj: { key: string; value: unknown; brandId?: string } = { key, value }
      if (selectedBenchmarkBrand) {
        bodyObj.brandId = selectedBenchmarkBrand
      }
      const res = await fetch('/api/settings/benchmarks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      })
      if (res.ok) {
        setBenchmarkSaveResult({ type: 'success', message: t.settings.savedSuccessfully })
        setTimeout(() => setBenchmarkSaveResult(null), 3000)
        // Refresh overrides info
        if (selectedBenchmarkBrand) {
          fetchBenchmarks(selectedBenchmarkBrand)
        }
      } else {
        setBenchmarkSaveResult({ type: 'error', message: t.settings.saveFailed })
      }
    } catch {
      setBenchmarkSaveResult({ type: 'error', message: t.settings.saveFailed })
    } finally {
      setBenchmarkSaving(null)
    }
  }

  async function resetBrandBenchmarks() {
    if (!selectedBenchmarkBrand) return
    setBenchmarkSaving('reset')
    setBenchmarkSaveResult(null)
    try {
      const res = await fetch(
        `/api/settings/benchmarks?brandId=${encodeURIComponent(selectedBenchmarkBrand)}&key=all`,
        { method: 'DELETE' }
      )
      if (res.ok) {
        setBenchmarkSaveResult({
          type: 'success',
          message: locale === 'es' ? 'Benchmarks de marca reseteados a global' : 'Brand benchmarks reset to global',
        })
        setTimeout(() => setBenchmarkSaveResult(null), 3000)
        fetchBenchmarks(selectedBenchmarkBrand)
      } else {
        setBenchmarkSaveResult({ type: 'error', message: t.settings.saveFailed })
      }
    } catch {
      setBenchmarkSaveResult({ type: 'error', message: t.settings.saveFailed })
    } finally {
      setBenchmarkSaving(null)
    }
  }

  function updateFeeRange(platform: string, tier: string, format: string, index: number, value: number) {
    setBenchmarkFeeRanges(prev => {
      if (!prev) return prev
      const next = JSON.parse(JSON.stringify(prev)) as FeeRangesData
      if (!next[platform]?.[tier]?.[format]) return prev
      next[platform][tier][format][index] = value
      return next
    })
  }

  function updateCpmRate(idx: number, field: 'cpmTarget' | 'cpmMax', value: number) {
    setBenchmarkCpmRates(prev => {
      if (!prev) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      return next
    })
  }

  function updateEmvCpmRate(platform: string, format: string, value: number) {
    setBenchmarkEmvRates(prev => {
      if (!prev) return prev
      return {
        ...prev,
        cpmRates: {
          ...prev.cpmRates,
          [platform]: { ...prev.cpmRates[platform], [format]: value },
        },
      }
    })
  }

  function updateEmvCpc(value: number) {
    setBenchmarkEmvRates(prev => prev ? { ...prev, cpc: value } : prev)
  }

  function updateEmvEngagement(platform: string, action: string, value: number) {
    setBenchmarkEmvRates(prev => {
      if (!prev) return prev
      return {
        ...prev,
        engagementValues: {
          ...prev.engagementValues,
          [platform]: { ...prev.engagementValues[platform], [action]: value },
        },
      }
    })
  }

  async function handleDeleteTemplate(id: string) {
    setDeletingTemplateId(id)
    try {
      const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setCampaignTemplates(prev => prev.filter(t => t.id !== id))
      }
    } catch {} finally {
      setDeletingTemplateId(null)
    }
  }

  // ---------- Handlers ----------

  function handleProfileSave() {
    setProfileSaving(true)
    setTimeout(() => {
      setProfileSaving(false)
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2000)
    }, 800)
  }

  async function handleInvite() {
    if (!inviteEmail) return
    setInviteSending(true)
    setInviteResult(null)
    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole.toUpperCase(), locale }),
      })
      const data = await res.json()
      if (res.ok) {
        setInviteResult({ type: 'success', message: 'Invitation sent successfully!' })
        setInviteEmail('')
        setInviteRole('Employee')
        setInviteOpen(false)
        await fetchTeam()
      } else {
        setInviteResult({ type: 'error', message: data.error || 'Failed to send invitation' })
      }
    } catch {
      setInviteResult({ type: 'error', message: 'Network error' })
    } finally {
      setInviteSending(false)
    }
  }

  async function handleRevokeInvitation(id: string) {
    try {
      await fetch(`/api/team/invite?id=${id}`, { method: 'DELETE' })
      await fetchTeam()
    } catch {}
  }

  async function handleResendInvitation(email: string, role: string) {
    // Revoke old + send new
    const existing = pendingInvitations.find(i => i.email === email)
    if (existing) {
      await fetch(`/api/team/invite?id=${existing.id}`, { method: 'DELETE' })
    }
    const res = await fetch('/api/team/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    })
    if (res.ok) {
      setInviteResult({ type: 'success', message: 'Invitation resent!' })
      await fetchTeam()
    }
  }

  async function handleToggleIntegration(id: string) {
    const integration = integrations.find(i => i.id === id)
    if (!integration) return

    const newConnected = !integration.connected
    const settingKey = `${id}_connected`

    setIntegrationSaving(id)
    try {
      const res = await fetch('/api/settings/integrations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: settingKey, value: newConnected ? 'true' : 'false' }),
      })
      if (res.ok) {
        setIntegrations(prev =>
          prev.map(i => (i.id === id ? { ...i, connected: newConnected } : i))
        )
      }
    } catch {} finally {
      setIntegrationSaving(null)
    }
  }

  async function handleSaveApifyKey() {
    setApifySaving(true)
    setApifySaved(false)
    try {
      const res = await fetch('/api/settings/integrations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'apify_api_key', value: apifyKey }),
      })
      if (res.ok) {
        setApifySaved(true)
        setTimeout(() => setApifySaved(false), 2500)
      }
    } catch {} finally {
      setApifySaving(false)
    }
  }

  async function handleSaveYoutubeKey() {
    setYoutubeKeySaving(true)
    setYoutubeKeySaved(false)
    try {
      const res = await fetch('/api/settings/integrations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'youtube_api_key', value: youtubeApiKey }),
      })
      if (res.ok) {
        setYoutubeKeySaved(true)
        setTimeout(() => setYoutubeKeySaved(false), 2500)
      }
    } catch {} finally {
      setYoutubeKeySaving(false)
    }
  }

  async function handleTestConnection(platform: string) {
    setTestingConnection(platform)
    try {
      const res = await fetch(`/api/settings/integrations/test?platform=${platform}`)
      const data = await res.json()
      if (platform === 'youtube') {
        setYoutubeTestResult({ success: data.success, message: data.message })
        setTimeout(() => setYoutubeTestResult(null), 5000)
      }
      if (platform === 'meta') {
        setMetaTestResult({ success: data.success, message: data.message })
        setTimeout(() => setMetaTestResult(null), 5000)
      }
    } catch {
      const errorResult = { success: false, message: 'Connection test failed' }
      if (platform === 'youtube') setYoutubeTestResult(errorResult)
      if (platform === 'meta') setMetaTestResult(errorResult)
    } finally {
      setTestingConnection(null)
    }
  }

  function handleConnectMeta() {
    window.location.href = '/api/auth/meta/brand/start'
  }

  // ---------- Meta Connections (Phase 2 OAuth) ----------

  interface MetaConnectionAccount {
    igUsername: string
    igName: string | null
    igProfilePicUrl: string | null
    followersCount: number
    followsCount: number
    mediaCount: number
    capturedAt: string
  }

  interface MetaConnection {
    id: string
    platform: string
    tokenType: string
    platformUserId: string | null
    platformPageId: string | null
    scopes: string[]
    expiresAt: string | null
    isValid: boolean
    lastUsedAt: string | null
    lastError: string | null
    createdAt: string
    updatedAt: string
    status: 'connected' | 'expired' | 'error' | 'disconnected'
    account: MetaConnectionAccount | null
  }

  const [metaConnections, setMetaConnections] = useState<MetaConnection[]>([])
  const [metaConnectionsLoading, setMetaConnectionsLoading] = useState(true)
  const [metaSyncingId, setMetaSyncingId] = useState<string | null>(null)
  const [metaDisconnectingId, setMetaDisconnectingId] = useState<string | null>(null)
  const [metaToast, setMetaToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  async function fetchMetaConnections() {
    try {
      const res = await fetch('/api/meta/connections')
      if (res.ok) {
        const data = await res.json()
        setMetaConnections(data.connections || [])
      }
    } catch {
      // silent
    } finally {
      setMetaConnectionsLoading(false)
    }
  }

  async function handleSyncMetaConnection(id: string) {
    setMetaSyncingId(id)
    try {
      const res = await fetch(`/api/meta/sync/${id}`, { method: 'POST' })
      if (res.ok) {
        setMetaToast({ type: 'success', message: locale === 'es' ? 'Sincronización completada' : 'Sync complete' })
        fetchMetaConnections()
      } else {
        setMetaToast({ type: 'error', message: locale === 'es' ? 'Error al sincronizar' : 'Sync failed' })
      }
    } catch {
      setMetaToast({ type: 'error', message: locale === 'es' ? 'Error al sincronizar' : 'Sync failed' })
    } finally {
      setMetaSyncingId(null)
      setTimeout(() => setMetaToast(null), 3500)
    }
  }

  async function handleDisconnectMetaConnection(id: string) {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        locale === 'es'
          ? '¿Desconectar esta cuenta? Los datos se conservarán pero no se actualizarán.'
          : 'Disconnect this account? Existing data will be kept but will stop updating.'
      )
      if (!ok) return
    }
    setMetaDisconnectingId(id)
    try {
      const res = await fetch(`/api/meta/connections/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setMetaToast({ type: 'success', message: locale === 'es' ? 'Cuenta desconectada' : 'Account disconnected' })
        fetchMetaConnections()
      } else {
        setMetaToast({ type: 'error', message: locale === 'es' ? 'Error al desconectar' : 'Disconnect failed' })
      }
    } catch {
      setMetaToast({ type: 'error', message: locale === 'es' ? 'Error al desconectar' : 'Disconnect failed' })
    } finally {
      setMetaDisconnectingId(null)
      setTimeout(() => setMetaToast(null), 3500)
    }
  }

  // Load Meta connections + show toast on ?connected=meta
  useEffect(() => {
    fetchMetaConnections()
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('connected') === 'meta') {
        setMetaToast({
          type: 'success',
          message: locale === 'es' ? 'Instagram conectado correctamente' : 'Instagram connected successfully',
        })
        setTimeout(() => setMetaToast(null), 4000)
        // Clean up query string
        const url = new URL(window.location.href)
        url.searchParams.delete('connected')
        window.history.replaceState({}, '', url.pathname + (url.searchParams.toString() ? '?' + url.searchParams : ''))
      } else if (params.get('error')?.startsWith('meta_')) {
        setMetaToast({
          type: 'error',
          message: locale === 'es' ? 'Error al conectar Instagram' : 'Failed to connect Instagram',
        })
        setTimeout(() => setMetaToast(null), 4000)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">{t.settings.title}</h1>
        <p className="mt-1 text-gray-500">{t.settings.subtitle}</p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile" className="gap-1.5">
            <User className="h-4 w-4" /> {t.settings.profile}
          </TabsTrigger>
          {currentUserRole !== 'BRAND' && (
            <TabsTrigger value="team" className="gap-1.5">
              <Users className="h-4 w-4" /> {t.settings.team}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="integrations" className="gap-1.5">
              <Plug className="h-4 w-4" /> {t.settings.integrations}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="benchmarks" className="gap-1.5">
              <BarChart3 className="h-4 w-4" /> {t.settings.benchmarks}
            </TabsTrigger>
          )}
          {currentUserRole !== 'BRAND' && (
            <TabsTrigger value="templates" className="gap-1.5">
              <FileText className="h-4 w-4" /> Templates
            </TabsTrigger>
          )}
          <TabsTrigger value="billing" className="gap-1.5">
            <CreditCard className="h-4 w-4" /> {t.settings.billing}
          </TabsTrigger>
        </TabsList>

        {/* ===================== PROFILE TAB ===================== */}
        <TabsContent value="profile">
          <Card variant="elevated">
            <CardHeader>
              <CardTitle>{t.settings.profileInfo}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* Avatar Upload */}
                <div className="flex items-center gap-6">
                  <div className="relative">
                    <Avatar name={profileName} size="lg" />
                    <button
                      className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
                      title={t.settings.uploadAvatar}
                    >
                      <Camera className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{t.settings.profilePhoto}</p>
                    <p className="text-xs text-gray-400">{t.settings.photoHint}</p>
                  </div>
                </div>

                {/* Fields */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label={t.settings.fullName}
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                  />
                  <Input
                    label={t.settings.emailAddress}
                    type="email"
                    value={profileEmail}
                    onChange={(e) => setProfileEmail(e.target.value)}
                  />
                </div>
                <div className="max-w-sm">
                  <Input
                    label={t.settings.company}
                    value={profileCompany}
                    onChange={(e) => setProfileCompany(e.target.value)}
                  />
                </div>

                {/* Theme Toggle */}
                <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                  <div className="flex items-center gap-3">
                    {theme === 'dark' ? (
                      <Moon className="h-5 w-5 text-purple-500" />
                    ) : (
                      <Sun className="h-5 w-5 text-yellow-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {theme === 'dark' ? 'Dark Mode' : 'Light Mode'}
                      </p>
                      <p className="text-xs text-gray-400">
                        {theme === 'dark' ? 'Switch to light mode for a brighter interface' : 'Switch to dark mode for a darker interface'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={toggleTheme}
                    className={cn(
                      "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                      theme === 'dark' ? "bg-purple-600" : "bg-gray-300"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                        theme === 'dark' ? "translate-x-6" : "translate-x-1"
                      )}
                    />
                  </button>
                </div>

                {/* Save */}
                <div className="flex items-center gap-3">
                  <Button onClick={handleProfileSave} loading={profileSaving}>
                    {profileSaved ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Check className="h-4 w-4" /> {t.common.save}
                      </span>
                    ) : (
                      t.common.save
                    )}
                  </Button>
                  {profileSaved && (
                    <span className="text-sm text-emerald-500">{t.settings.profileUpdated}</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===================== TEAM TAB ===================== */}
        <TabsContent value="team">
          <Card variant="elevated">
            <CardHeader>
              <CardTitle>{t.settings.teamMembers}</CardTitle>
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <Send className="h-3.5 w-3.5" /> {t.settings.inviteTeamMember}
              </Button>
            </CardHeader>
            <CardContent>
              {teamLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs uppercase tracking-wider text-gray-400">
                        <th className="pb-3 pr-4 font-medium">{t.common.name}</th>
                        <th className="pb-3 pr-4 font-medium">{t.common.email}</th>
                        <th className="pb-3 pr-4 font-medium">{t.settings.role}</th>
                        <th className="pb-3 pr-4 font-medium">{t.common.status}</th>
                        <th className="pb-3 font-medium text-right">{t.common.actions}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {/* Active Users */}
                      {teamUsers.map((user) => (
                        <tr key={user.id} className="group">
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-3">
                              <Avatar name={user.name} size="sm" src={user.avatar || undefined} />
                              <span className="font-medium text-gray-900">{user.name}</span>
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-gray-500">{user.email}</td>
                          <td className="py-3 pr-4">
                            <Badge
                              variant={user.role === "ADMIN" ? "active" : "default"}
                            >
                              {user.role.charAt(0) + user.role.slice(1).toLowerCase()}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4">
                            <Badge variant="active">Active</Badge>
                          </td>
                          <td className="py-3 text-right">
                            <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              {isAdmin && user.id !== currentUserId && (
                                <button
                                  className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                                  title="Change role"
                                  onClick={async () => {
                                    const newRole = prompt(`Change role for ${user.name}?\nCurrent: ${user.role}\n\nType: ADMIN, EMPLOYEE, or BRAND`)
                                    if (!newRole || !['ADMIN', 'EMPLOYEE', 'BRAND'].includes(newRole.toUpperCase())) return
                                    try {
                                      const res = await fetch(`/api/team/users/${user.id}`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ role: newRole.toUpperCase() }),
                                      })
                                      if (res.ok) {
                                        setTeamUsers(prev => prev.map(u => u.id === user.id ? { ...u, role: newRole.toUpperCase() } : u))
                                        setInviteResult({ type: 'success', message: `${user.name} role changed to ${newRole.toUpperCase()}` })
                                      } else {
                                        const data = await res.json()
                                        setInviteResult({ type: 'error', message: data.error || 'Failed to update role' })
                                      }
                                    } catch {
                                      setInviteResult({ type: 'error', message: 'Failed to update role' })
                                    }
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {isAdmin && user.id !== currentUserId && (
                                <button
                                  className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                                  title="Delete user"
                                  onClick={async () => {
                                    if (!confirm(`Are you sure you want to delete ${user.name} (${user.email})? This cannot be undone.`)) return
                                    try {
                                      const res = await fetch(`/api/team/users/${user.id}`, { method: 'DELETE' })
                                      if (res.ok) {
                                        setTeamUsers(prev => prev.filter(u => u.id !== user.id))
                                        setInviteResult({ type: 'success', message: `${user.email} deleted` })
                                      } else {
                                        const data = await res.json()
                                        setInviteResult({ type: 'error', message: data.error || 'Failed to delete user' })
                                      }
                                    } catch {
                                      setInviteResult({ type: 'error', message: 'Failed to delete user' })
                                    }
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}

                      {/* Pending Invitations */}
                      {pendingInvitations.map((invitation) => (
                        <tr key={invitation.id} className="group">
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-3">
                              <Avatar name={invitation.email} size="sm" />
                              <span className="font-medium text-gray-400">{invitation.email.split('@')[0]}</span>
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-gray-500">{invitation.email}</td>
                          <td className="py-3 pr-4">
                            <Badge variant="default">
                              {invitation.role.charAt(0) + invitation.role.slice(1).toLowerCase()}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4">
                            <Badge variant="paused">Invited</Badge>
                          </td>
                          <td className="py-3 text-right">
                            <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                                title="Resend invitation"
                                onClick={() => handleResendInvitation(invitation.email, invitation.role)}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                              <button
                                className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                                title="Revoke invitation"
                                onClick={() => handleRevokeInvitation(invitation.id)}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}

                      {/* Empty state */}
                      {teamUsers.length === 0 && pendingInvitations.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-sm text-gray-400">
                            No team members yet. Invite someone to get started.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {inviteResult && (
                <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${
                  inviteResult.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}>
                  {inviteResult.message}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Invite Modal */}
          <Modal open={inviteOpen} onClose={() => setInviteOpen(false)}>
            <ModalHeader onClose={() => setInviteOpen(false)}>
              {t.settings.inviteTeamMember}
            </ModalHeader>
            <ModalBody>
              <div className="space-y-4">
                <Input
                  label={t.settings.emailAddress}
                  type="email"
                  placeholder="colleague@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
                <Select
                  label={t.settings.role}
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  options={[
                    { value: "Admin", label: "Admin" },
                    { value: "Employee", label: "Employee" },
                    { value: "Brand", label: "Brand" },
                  ]}
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="secondary" onClick={() => setInviteOpen(false)}>
                {t.common.cancel}
              </Button>
              <Button onClick={handleInvite} loading={inviteSending}>
                <Send className="h-4 w-4" /> {t.settings.sendInvite}
              </Button>
            </ModalFooter>
          </Modal>

          {/* ===================== BRAND ASSIGNMENTS (Admin only) ===================== */}
          {isAdmin && (
            <Card variant="elevated" className="mt-6">
              <CardHeader>
                <CardTitle>Brand Assignments</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 mb-4">
                  Assign employees to brands so they automatically see all campaigns from those brands.
                </p>
                {brandAssignmentsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                  </div>
                ) : brandAssignments.length === 0 ? (
                  <div className="py-8 text-center text-sm text-gray-400">
                    No brand users found. Invite a user with the Brand role to get started.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {brandAssignments.map((ba) => (
                      <div key={ba.brandId} className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <Avatar name={ba.brandName} size="sm" />
                          <div>
                            <p className="font-medium text-gray-900 dark:text-white">{ba.brandName}</p>
                            <p className="text-xs text-gray-400">{ba.brandEmail}</p>
                          </div>
                          <Badge variant="default" className="ml-auto">Brand</Badge>
                        </div>
                        <div className="ml-1">
                          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Assigned Employees</p>
                          {allEmployees.length === 0 ? (
                            <p className="text-sm text-gray-400">No employees available.</p>
                          ) : (
                            <div className="space-y-1.5">
                              {allEmployees.map((emp) => {
                                const isAssigned = ba.employees.some(e => e.id === emp.id)
                                const isSaving = brandAssignmentSaving === `${ba.brandId}_${emp.id}`
                                return (
                                  <label
                                    key={emp.id}
                                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isAssigned}
                                      disabled={isSaving}
                                      onChange={() => handleToggleBrandEmployee(ba.brandId, emp.id, isAssigned)}
                                      className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <span className="text-sm text-gray-700 dark:text-gray-300">{emp.name}</span>
                                    <span className="text-xs text-gray-400">{emp.email}</span>
                                    {isSaving && <Loader2 className="h-3 w-3 animate-spin text-purple-500 ml-auto" />}
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ===================== INTEGRATIONS TAB ===================== */}
        <TabsContent value="integrations">
          {!isAdmin ? (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-16 text-center">
              <Plug className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 text-sm text-gray-500">Only administrators can manage integrations.</p>
            </div>
          ) : integrationsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
            </div>
          ) : (
          <div className="space-y-6">
            {/* Section: Official APIs */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Official APIs</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Connect to official platform APIs for verified, first-party data.</p>

              <div className="grid gap-4 sm:grid-cols-2">
                {/* YouTube Data API */}
                <Card variant="elevated">
                  <CardContent>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-red-50 dark:bg-red-900/20 text-red-500">
                          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" /></svg>
                        </div>
                        <div>
                          <h3 className="font-semibold text-gray-900 dark:text-white">YouTube Data API v3</h3>
                          <p className="mt-0.5 text-xs text-gray-400">Public channel & video data. No OAuth needed.</p>
                        </div>
                      </div>
                      <Badge variant={youtubeApiKey ? "active" : "archived"}>
                        {youtubeApiKey ? t.settings.configured : t.settings.notConfigured}
                      </Badge>
                    </div>
                    <div className="mt-4 flex items-end gap-2">
                      <div className="flex-1">
                        <Input
                          label="API Key"
                          type="password"
                          placeholder="AIzaSy..."
                          value={youtubeApiKey}
                          onChange={(e) => setYoutubeApiKey(e.target.value)}
                        />
                      </div>
                      <Button size="sm" variant="secondary" className="mb-[1px]" onClick={handleSaveYoutubeKey} loading={youtubeKeySaving}>
                        {youtubeKeySaved ? (
                          <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> {t.common.save}</span>
                        ) : t.common.save}
                      </Button>
                    </div>
                    {youtubeApiKey && (
                      <div className="mt-3">
                        <Button size="sm" variant="ghost" onClick={() => handleTestConnection('youtube')} loading={testingConnection === 'youtube'}>
                          {t.settings.testConnection || 'Test Connection'}
                        </Button>
                        {youtubeTestResult && (
                          <p className={`mt-2 text-xs ${youtubeTestResult.success ? 'text-emerald-500' : 'text-red-500'}`}>
                            {youtubeTestResult.message}
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Meta / Instagram + Facebook */}
                <Card variant="elevated">
                  <CardContent>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600">
                          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
                        </div>
                        <div>
                          <h3 className="font-semibold text-gray-900 dark:text-white">Meta Platform</h3>
                          <p className="mt-0.5 text-xs text-gray-400">Instagram API + Creator Marketplace + FB Discovery</p>
                        </div>
                      </div>
                      <Badge variant={integrations.find(i => i.id === 'instagram')?.connected ? "active" : "archived"}>
                        {integrations.find(i => i.id === 'instagram')?.connected ? t.settings.connected : t.settings.notConnected}
                      </Badge>
                    </div>
                    <div className="mt-4 space-y-3">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Connect your Facebook Page to access Instagram Graph API, Creator Marketplace discovery, and Facebook Creator Discovery.
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant={integrations.find(i => i.id === 'instagram')?.connected ? "secondary" : "primary"}
                          onClick={handleConnectMeta}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {integrations.find(i => i.id === 'instagram')?.connected ? 'Reconnect' : 'Connect with Facebook'}
                        </Button>
                        {integrations.find(i => i.id === 'instagram')?.connected && (
                          <Button size="sm" variant="ghost" onClick={() => handleTestConnection('meta')} loading={testingConnection === 'meta'}>
                            {t.settings.testConnection || 'Test'}
                          </Button>
                        )}
                      </div>
                      {metaTestResult && (
                        <p className={`text-xs ${metaTestResult.success ? 'text-emerald-500' : 'text-red-500'}`}>
                          {metaTestResult.message}
                        </p>
                      )}
                      <div className="rounded-lg border border-gray-100 dark:border-gray-700 p-3 bg-gray-50 dark:bg-gray-800">
                        <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">APIs included:</p>
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-pink-400" /> Instagram Graph API — Profile & media insights
                          </div>
                          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-purple-400" /> Creator Marketplace API — Discover creators with demographics
                          </div>
                          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" /> FB Creator Discovery — Facebook creator search & content
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Section: Meta Connected Accounts (Phase 2 OAuth) */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                {locale === 'es' ? 'Cuentas de Instagram conectadas' : 'Connected Instagram accounts'}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                {locale === 'es'
                  ? 'Cada cuenta de Instagram Business vinculada aquí se sincroniza automáticamente cada 6 horas.'
                  : 'Each Instagram Business account linked here is auto-synced every 6 hours.'}
              </p>

              {metaToast && (
                <div className={cn(
                  "mb-4 rounded-lg px-4 py-2 text-sm font-medium",
                  metaToast.type === 'success'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                )}>
                  {metaToast.message}
                </div>
              )}

              {metaConnectionsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-purple-600" />
                </div>
              ) : metaConnections.length === 0 ? (
                <Card variant="elevated">
                  <CardContent>
                    <div className="py-6 text-center">
                      <Instagram className="mx-auto h-8 w-8 text-gray-300" />
                      <p className="mt-2 text-sm text-gray-500">
                        {locale === 'es'
                          ? 'Aún no hay cuentas conectadas. Usa el botón “Connect with Facebook” arriba.'
                          : 'No accounts connected yet. Use the “Connect with Facebook” button above.'}
                      </p>
                      <Button
                        size="sm"
                        variant="primary"
                        className="mt-4"
                        onClick={handleConnectMeta}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {locale === 'es' ? 'Conectar Instagram' : 'Connect Instagram'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-3">
                  {metaConnections.map(conn => {
                    const statusBadge = (() => {
                      switch (conn.status) {
                        case 'connected': return { label: locale === 'es' ? 'Conectado' : 'Connected', variant: 'active' as const }
                        case 'expired':   return { label: locale === 'es' ? 'Expirado' : 'Expired', variant: 'archived' as const }
                        case 'error':     return { label: locale === 'es' ? 'Error' : 'Error', variant: 'archived' as const }
                        default:          return { label: locale === 'es' ? 'Desconectado' : 'Disconnected', variant: 'archived' as const }
                      }
                    })()

                    return (
                      <Card key={conn.id} variant="elevated">
                        <CardContent>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              {conn.account?.igProfilePicUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={conn.account.igProfilePicUrl}
                                  alt=""
                                  className="h-11 w-11 rounded-xl object-cover border border-gray-200 dark:border-gray-700"
                                />
                              ) : (
                                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-pink-50 dark:bg-pink-900/20 text-pink-500">
                                  <Instagram className="h-5 w-5" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="font-semibold text-gray-900 dark:text-white truncate">
                                    @{conn.account?.igUsername || conn.platformUserId || 'unknown'}
                                  </p>
                                  <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                                  {conn.account && (
                                    <span>{conn.account.followersCount.toLocaleString()} {locale === 'es' ? 'seguidores' : 'followers'}</span>
                                  )}
                                  {conn.lastUsedAt && (
                                    <span>
                                      {locale === 'es' ? 'Última sync:' : 'Last sync:'}{' '}
                                      {new Date(conn.lastUsedAt).toLocaleString(locale === 'es' ? 'es-ES' : 'en-US')}
                                    </span>
                                  )}
                                  {conn.expiresAt && (
                                    <span>
                                      {locale === 'es' ? 'Expira:' : 'Expires:'}{' '}
                                      {new Date(conn.expiresAt).toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US')}
                                    </span>
                                  )}
                                </div>
                                {conn.lastError && (
                                  <p className="mt-1 text-xs text-red-500 truncate" title={conn.lastError}>
                                    {conn.lastError}
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => handleSyncMetaConnection(conn.id)}
                                loading={metaSyncingId === conn.id}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {locale === 'es' ? 'Sincronizar' : 'Sync'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDisconnectMetaConnection(conn.id)}
                                loading={metaDisconnectingId === conn.id}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                {locale === 'es' ? 'Desconectar' : 'Disconnect'}
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Section: Data Sources */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Data Sources</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Scraping engine used as fallback when official APIs are not available.</p>

              <div className="grid gap-4 sm:grid-cols-2">
                {/* Apify Card */}
                <Card variant="elevated">
                  <CardContent>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-purple-50 dark:bg-purple-900/20 text-purple-600">
                          <Key className="h-6 w-6" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-gray-900 dark:text-white">Apify</h3>
                          <p className="mt-0.5 text-xs text-gray-400">{t.settings.scrapingEngine}</p>
                        </div>
                      </div>
                      <Badge variant={apifyKey ? "active" : "archived"}>
                        {apifyKey ? t.settings.configured : t.settings.notConfigured}
                      </Badge>
                    </div>
                    <div className="mt-4 flex items-end gap-2">
                      <div className="flex-1">
                        <Input
                          label={t.settings.apiKey}
                          type="password"
                          placeholder="apify_api_xxxxxxxxx"
                          value={apifyKey}
                          onChange={(e) => setApifyKey(e.target.value)}
                        />
                      </div>
                      <Button size="sm" variant="secondary" className="mb-[1px]" onClick={handleSaveApifyKey} loading={apifySaving}>
                        {apifySaved ? (
                          <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> {t.common.save}</span>
                        ) : t.common.save}
                      </Button>
                    </div>
                    {apifySaved && (
                      <p className="mt-2 text-sm text-emerald-500">API key saved successfully.</p>
                    )}
                  </CardContent>
                </Card>

                {/* Data source priority info */}
                <Card variant="elevated">
                  <CardContent>
                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-500">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20" /><circle cx="12" cy="12" r="10" /></svg>
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900 dark:text-white">Data Priority</h3>
                        <p className="mt-0.5 text-xs text-gray-400">How data sources are selected</p>
                      </div>
                    </div>
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-3">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-xs font-bold text-emerald-700 dark:text-emerald-300">1</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">Official API (YouTube Data API)</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30 text-xs font-bold text-blue-700 dark:text-blue-300">2</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">OAuth connected (Meta APIs)</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/30 text-xs font-bold text-purple-700 dark:text-purple-300">3</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">Creator Marketplace API</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-bold text-gray-600 dark:text-gray-400">4</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">Apify (fallback)</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
          )}
        </TabsContent>

        {/* ===================== BENCHMARKS TAB ===================== */}
        <TabsContent value="benchmarks">
          {!isAdmin ? (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-16 text-center">
              <BarChart3 className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 text-sm text-gray-500">Only administrators can manage benchmarks.</p>
            </div>
          ) : benchmarksLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
            </div>
          ) : (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t.settings.benchmarksSubtitle}</p>
            </div>

            {/* Brand selector */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-sm">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {locale === 'es' ? 'Marca:' : 'Brand:'}
                  </label>
                  <select
                    value={selectedBenchmarkBrand}
                    onChange={(e) => {
                      const newBrandId = e.target.value
                      setSelectedBenchmarkBrand(newBrandId)
                      setBenchmarksLoading(true)
                      fetchBenchmarks(newBrandId || undefined)
                    }}
                    className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 min-w-[200px]"
                  >
                    <option value="">
                      {locale === 'es' ? 'Global (por defecto)' : 'Global (default)'}
                    </option>
                    {benchmarkBrands.map(b => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
                {selectedBenchmarkBrand && (
                  <>
                    {benchmarkBrandOverrides && (benchmarkBrandOverrides.feeRanges || benchmarkBrandOverrides.cpmRates || benchmarkBrandOverrides.emvRates) ? (
                      <Badge variant="default">
                        {locale === 'es' ? 'Tiene configuraciones propias' : 'Has custom overrides'}
                      </Badge>
                    ) : (
                      <Badge variant="default">
                        {locale === 'es' ? 'Usando valores globales' : 'Using global values'}
                      </Badge>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={resetBrandBenchmarks}
                      disabled={benchmarkSaving === 'reset'}
                      className="gap-1.5 ml-auto"
                    >
                      {benchmarkSaving === 'reset' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                      {locale === 'es' ? 'Resetear a global' : 'Reset to global'}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Save result notification */}
            {benchmarkSaveResult && (
              <div className={cn(
                "rounded-lg px-4 py-2 text-sm font-medium",
                benchmarkSaveResult.type === 'success'
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              )}>
                {benchmarkSaveResult.message}
              </div>
            )}

            {/* ---- Section 1: Fee Ranges ---- */}
            <Card variant="elevated">
              <button
                onClick={() => setFeeRangesOpen(!feeRangesOpen)}
                className="flex w-full items-center justify-between px-6 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  {feeRangesOpen ? <ChevronDown className="h-5 w-5 text-purple-500" /> : <ChevronRight className="h-5 w-5 text-gray-400" />}
                  <div>
                    <h3 className="text-base font-semibold text-gray-900 dark:text-white">{t.settings.feeRanges}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t.settings.feeRangesDesc}</p>
                  </div>
                </div>
              </button>
              {feeRangesOpen && benchmarkFeeRanges && (
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700">
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.platform}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.tier}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.format}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.min}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.target}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.max}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.ceiling}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {Object.entries(benchmarkFeeRanges).map(([platform, tiers]) =>
                          Object.entries(tiers).map(([tier, formats]) =>
                            Object.entries(formats).map(([format, values]) => (
                              <tr key={`${platform}-${tier}-${format}`} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white">{platform}</td>
                                <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">{tier}</td>
                                <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">{format}</td>
                                {[0, 1, 2, 3].map(i => (
                                  <td key={i} className="px-3 py-1.5">
                                    <Input
                                      type="number"
                                      value={values[i]}
                                      onChange={e => updateFeeRange(platform, tier, format, i, Number(e.target.value))}
                                      className="w-24 h-8 text-sm"
                                    />
                                  </td>
                                ))}
                              </tr>
                            ))
                          )
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end mt-4">
                    <Button
                      onClick={() => saveBenchmark('benchmark_fee_ranges', benchmarkFeeRanges)}
                      disabled={benchmarkSaving === 'benchmark_fee_ranges'}
                      className="gap-2"
                    >
                      {benchmarkSaving === 'benchmark_fee_ranges' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      {t.common.save}
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>

            {/* ---- Section 2: CPM Thresholds ---- */}
            <Card variant="elevated">
              <button
                onClick={() => setCpmThresholdsOpen(!cpmThresholdsOpen)}
                className="flex w-full items-center justify-between px-6 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  {cpmThresholdsOpen ? <ChevronDown className="h-5 w-5 text-purple-500" /> : <ChevronRight className="h-5 w-5 text-gray-400" />}
                  <div>
                    <h3 className="text-base font-semibold text-gray-900 dark:text-white">{t.settings.cpmThresholds}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t.settings.cpmThresholdsDesc}</p>
                  </div>
                </div>
              </button>
              {cpmThresholdsOpen && benchmarkCpmRates && (
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700">
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.platform}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.tier}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.cpmTarget}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.cpmMax}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {benchmarkCpmRates.map((entry, idx) => (
                          <tr key={`${entry.platform}-${entry.tier}`} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white">{entry.platform}</td>
                            <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">{entry.tier}</td>
                            <td className="px-3 py-1.5">
                              <Input
                                type="number"
                                step="0.5"
                                value={entry.cpmTarget}
                                onChange={e => updateCpmRate(idx, 'cpmTarget', Number(e.target.value))}
                                className="w-24 h-8 text-sm"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <Input
                                type="number"
                                step="0.5"
                                value={entry.cpmMax}
                                onChange={e => updateCpmRate(idx, 'cpmMax', Number(e.target.value))}
                                className="w-24 h-8 text-sm"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end mt-4">
                    <Button
                      onClick={() => saveBenchmark('benchmark_cpm_rates', benchmarkCpmRates)}
                      disabled={benchmarkSaving === 'benchmark_cpm_rates'}
                      className="gap-2"
                    >
                      {benchmarkSaving === 'benchmark_cpm_rates' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      {t.common.save}
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>

            {/* ---- Section 3: EMV Rates ---- */}
            <Card variant="elevated">
              <button
                onClick={() => setEmvRatesOpen(!emvRatesOpen)}
                className="flex w-full items-center justify-between px-6 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  {emvRatesOpen ? <ChevronDown className="h-5 w-5 text-purple-500" /> : <ChevronRight className="h-5 w-5 text-gray-400" />}
                  <div>
                    <h3 className="text-base font-semibold text-gray-900 dark:text-white">{t.settings.emvRates}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t.settings.emvRatesDesc}</p>
                  </div>
                </div>
              </button>
              {emvRatesOpen && benchmarkEmvRates && (
                <CardContent>
                  <div className="space-y-6">
                    {/* EMV CPM Rates */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t.settings.emvCpmRates}</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200 dark:border-gray-700">
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.platform}</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.format}</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">CPM (EUR)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                            {Object.entries(benchmarkEmvRates.cpmRates).map(([platform, formats]) =>
                              Object.entries(formats).map(([format, value]) => (
                                <tr key={`${platform}-${format}`} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                  <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white">{platform}</td>
                                  <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">{format}</td>
                                  <td className="px-3 py-1.5">
                                    <Input
                                      type="number"
                                      step="0.50"
                                      value={value}
                                      onChange={e => updateEmvCpmRate(platform, format, Number(e.target.value))}
                                      className="w-28 h-8 text-sm"
                                    />
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* CPC */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t.settings.emvCpc}</h4>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-gray-600 dark:text-gray-400">CPC (EUR)</span>
                        <Input
                          type="number"
                          step="0.10"
                          value={benchmarkEmvRates.cpc}
                          onChange={e => updateEmvCpc(Number(e.target.value))}
                          className="w-28 h-8 text-sm"
                        />
                      </div>
                    </div>

                    {/* Engagement Values */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t.settings.emvEngagement}</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200 dark:border-gray-700">
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">{t.settings.platform}</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Like (EUR)</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Comment (EUR)</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Share (EUR)</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Save (EUR)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                            {Object.entries(benchmarkEmvRates.engagementValues).map(([platform, actions]) => (
                              <tr key={platform} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white">{platform}</td>
                                {['like', 'comment', 'share', 'save'].map(action => (
                                  <td key={action} className="px-3 py-1.5">
                                    <Input
                                      type="number"
                                      step="0.05"
                                      value={(actions as Record<string, number>)[action] ?? 0}
                                      onChange={e => updateEmvEngagement(platform, action, Number(e.target.value))}
                                      className="w-24 h-8 text-sm"
                                    />
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end mt-4">
                    <Button
                      onClick={() => saveBenchmark('benchmark_emv_rates', benchmarkEmvRates)}
                      disabled={benchmarkSaving === 'benchmark_emv_rates'}
                      className="gap-2"
                    >
                      {benchmarkSaving === 'benchmark_emv_rates' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      {t.common.save}
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>
          </div>
          )}
        </TabsContent>

        {/* ===================== TEMPLATES TAB ===================== */}
        <TabsContent value="templates">
          <Card variant="elevated">
            <CardHeader>
              <CardTitle>Campaign Templates</CardTitle>
            </CardHeader>
            <CardContent>
              {templatesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                </div>
              ) : campaignTemplates.length === 0 ? (
                <div className="py-12 text-center">
                  <FileText className="mx-auto h-10 w-10 text-gray-300" />
                  <p className="mt-3 text-sm text-gray-500">No templates yet.</p>
                  <p className="mt-1 text-xs text-gray-400">
                    Save a campaign as a template from the campaign detail page.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {campaignTemplates.map((tpl) => (
                    <div
                      key={tpl.id}
                      className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3 transition-colors hover:border-gray-300"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
                          <FileText className="h-5 w-5" />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-900">{tpl.name}</h4>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                            {tpl.type && (
                              <Badge variant="default">
                                {tpl.type === 'SOCIAL_LISTENING' ? 'Social Listening' : tpl.type === 'INFLUENCER_TRACKING' ? 'Influencer Tracking' : 'UGC'}
                              </Badge>
                            )}
                            {tpl.platforms && tpl.platforms.length > 0 && (
                              <span className="flex items-center gap-1">
                                {tpl.platforms.map(p => (
                                  <span key={p} className="inline-flex items-center gap-0.5 text-gray-500">
                                    {p === 'INSTAGRAM' && <Instagram className="h-3 w-3 text-pink-400" />}
                                    {p === 'YOUTUBE' && <Youtube className="h-3 w-3 text-red-400" />}
                                    {p === 'TIKTOK' && (
                                      <svg className="h-3 w-3 text-cyan-400" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z" />
                                      </svg>
                                    )}
                                  </span>
                                ))}
                              </span>
                            )}
                            <span>&middot;</span>
                            <span>{new Date(tpl.createdAt).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteTemplate(tpl.id)}
                        disabled={deletingTemplateId === tpl.id}
                        className="rounded-md p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                        title="Delete template"
                      >
                        {deletingTemplateId === tpl.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===================== BILLING TAB ===================== */}
        <TabsContent value="billing">
          <div className="space-y-6">
            {/* Current Plan */}
            <Card variant="elevated">
              <CardHeader>
                <CardTitle>Billing &amp; Subscription</CardTitle>
                <Badge variant="active">Free (Beta)</Badge>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  <div className="rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 p-4">
                    <p className="text-sm font-medium text-purple-900 dark:text-purple-200 mb-1">Current Plan: Free (Beta)</p>
                    <p className="text-sm text-purple-700 dark:text-purple-300">
                      You are currently on the free beta plan. To upgrade or discuss custom plans, please contact:
                    </p>
                    <a
                      href="mailto:admon@thekingofcontent.agency"
                      className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-purple-600 hover:text-purple-800 dark:text-purple-400 dark:hover:text-purple-200 transition-colors"
                    >
                      <Send className="h-3.5 w-3.5" />
                      admon@thekingofcontent.agency
                    </a>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">What&apos;s Included</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {[
                        'Unlimited campaigns',
                        'Influencer tracking & discovery',
                        'Instagram, TikTok & YouTube monitoring',
                        'Media collection & analytics',
                        'EMV calculation',
                        'Team collaboration',
                        'Campaign templates',
                        'AI-powered insights',
                      ].map((feature) => (
                        <div key={feature} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                          <Check className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                          {feature}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------- Usage Stat Sub-component ----------

function UsageStat({
  label,
  used,
  limit,
}: {
  label: string
  used: number
  limit: number
}) {
  const pct = Math.min((used / limit) * 100, 100)
  const barColor = pct > 80 ? "bg-red-500" : pct > 60 ? "bg-purple-500" : "bg-emerald-500"

  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-lg font-semibold text-gray-900">
        {used.toLocaleString()}{" "}
        <span className="text-sm font-normal text-gray-400">/ {limit.toLocaleString()}</span>
      </p>
      <div className="mt-2 h-1.5 w-full rounded-full bg-gray-200">
        <div
          className={`h-full rounded-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

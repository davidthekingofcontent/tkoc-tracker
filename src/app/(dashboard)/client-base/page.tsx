'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Search,
  Plus,
  Upload,
  Loader2,
  Users,
  Zap,
  Flame,
  Check,
  X,
  ChevronDown,
  FileSpreadsheet,
  Instagram,
  Youtube,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal'
import { Select } from '@/components/ui/select'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatDate } from '@/lib/utils'
import { useI18n } from '@/i18n/context'

// --- Types ---

interface ClientContact {
  id: string
  name: string
  email: string | null
  company: string | null
  domain: string | null
  phone: string | null
  instagramHandle: string | null
  tiktokHandle: string | null
  source: 'CSV' | 'MANUAL' | 'CRM'
  relationshipType: string | null
  relationshipStatus: string | null
  notes: string | null
  matchCount: number
  createdAt: string
}

interface ClientMatch {
  id: string
  clientContact: {
    id: string
    name: string
    company: string | null
  }
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
    followers: number
  }
  matchLevel: 'EXACT' | 'PROBABLE' | 'POSSIBLE'
  confidence: number
  status: 'AUTO_DETECTED' | 'USER_CONFIRMED' | 'USER_REJECTED' | 'PENDING_REVIEW'
  warmScore: number | null
  warmGrade: string | null
  warmReasons: string[]
  warmRisks: string[]
  warmRecommendedUse: string | null
  signals: string[]
  createdAt: string
}

interface ImportResult {
  imported: number
  matches: number
}

// --- Helpers ---

const TikTokIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z" />
  </svg>
)

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform) {
    case 'INSTAGRAM': return <Instagram className="h-3.5 w-3.5" />
    case 'YOUTUBE': return <Youtube className="h-3.5 w-3.5" />
    case 'TIKTOK': return <TikTokIcon className="h-3.5 w-3.5" />
    default: return null
  }
}

function levelBadgeVariant(level: string): 'active' | 'paused' | 'default' {
  switch (level) {
    case 'EXACT': return 'active'
    case 'PROBABLE': return 'paused'
    case 'POSSIBLE': return 'default'
    default: return 'default'
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'AUTO_DETECTED': return 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800'
    case 'USER_CONFIRMED': return 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800'
    case 'USER_REJECTED': return 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800'
    case 'PENDING_REVIEW': return 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800'
    default: return 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600'
  }
}

function formatStatusLabel(status: string): string {
  return status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value))
  const color = pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-gray-400'
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 dark:text-gray-400">{pct}%</span>
    </div>
  )
}

function gradeColor(grade: string | null): string {
  if (!grade) return 'text-gray-400'
  if (grade === 'A' || grade === 'A+') return 'text-green-600 dark:text-green-400'
  if (grade === 'B' || grade === 'B+') return 'text-yellow-600 dark:text-yellow-400'
  if (grade === 'C') return 'text-orange-600 dark:text-orange-400'
  return 'text-red-600 dark:text-red-400'
}

// CSV parsing
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = parseCsvLine(lines[0])
  const rows = lines.slice(1).map(parseCsvLine)
  return { headers, rows }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
  }
  result.push(current.trim())
  return result
}

const MAPPABLE_FIELDS = [
  'name', 'email', 'company', 'domain', 'phone', 'instagram', 'tiktok',
] as const

type MappableField = typeof MAPPABLE_FIELDS[number]

function autoDetectMapping(headers: string[]): Record<number, MappableField | ''> {
  const mapping: Record<number, MappableField | ''> = {}
  const patterns: Record<MappableField, RegExp> = {
    name: /^(name|full.?name|contact.?name|nombre)$/i,
    email: /^(email|e.?mail|correo)$/i,
    company: /^(company|empresa|organization|org|brand|marca)$/i,
    domain: /^(domain|dominio|website|web|url|sitio)$/i,
    phone: /^(phone|tel|telephone|celular|movil|móvil|teléfono)$/i,
    instagram: /^(instagram|ig|ig.?handle|insta)$/i,
    tiktok: /^(tiktok|tt|tik.?tok|tiktok.?handle)$/i,
  }

  headers.forEach((header, idx) => {
    const h = header.trim()
    for (const [field, regex] of Object.entries(patterns)) {
      if (regex.test(h)) {
        mapping[idx] = field as MappableField
        return
      }
    }
    mapping[idx] = ''
  })

  return mapping
}

// --- Main Component ---

export default function ClientBasePage() {
  const { t } = useI18n()
  const cb = (t as Record<string, unknown>).clientBase as Record<string, string> | undefined

  // Helper to get translation with fallback
  const tr = useCallback((key: string, fallback: string) => {
    return cb?.[key] || fallback
  }, [cb])

  // Data state
  const [contacts, setContacts] = useState<ClientContact[]>([])
  const [matches, setMatches] = useState<ClientMatch[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMatches, setIsLoadingMatches] = useState(true)

  // Search & filters - contacts
  const [contactSearch, setContactSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [relationshipFilter, setRelationshipFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Search & filters - matches
  const [matchSearch, setMatchSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('')
  const [matchStatusFilter, setMatchStatusFilter] = useState('')

  // Modals
  const [showAddModal, setShowAddModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [selectedMatch, setSelectedMatch] = useState<ClientMatch | null>(null)

  // Add contact form
  const [formName, setFormName] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formCompany, setFormCompany] = useState('')
  const [formDomain, setFormDomain] = useState('')
  const [formPhone, setFormPhone] = useState('')
  const [formInstagram, setFormInstagram] = useState('')
  const [formTiktok, setFormTiktok] = useState('')
  const [formRelationship, setFormRelationship] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // CSV import state
  const [csvFile, setCsvFile] = useState<File | null>(null)
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<string[][]>([])
  const [csvMapping, setCsvMapping] = useState<Record<number, MappableField | ''>>({})
  const [isParsing, setIsParsing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch contacts
  const fetchContacts = useCallback(async () => {
    try {
      const res = await fetch('/api/client-contacts')
      if (res.ok) {
        const data = await res.json()
        setContacts(data.contacts || [])
      }
    } catch (err) {
      console.error('Error fetching client contacts:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Fetch matches
  const fetchMatches = useCallback(async () => {
    try {
      const res = await fetch('/api/client-contacts/matches')
      if (res.ok) {
        const data = await res.json()
        setMatches(data.matches || [])
      }
    } catch (err) {
      console.error('Error fetching matches:', err)
    } finally {
      setIsLoadingMatches(false)
    }
  }, [])

  useEffect(() => {
    fetchContacts()
    fetchMatches()
  }, [fetchContacts, fetchMatches])

  // Stats
  const totalClients = contacts.length
  const totalMatches = matches.length
  const warmOpportunities = matches.filter(m =>
    m.warmGrade && (m.warmGrade === 'A' || m.warmGrade === 'A+' || m.warmGrade === 'B' || m.warmGrade === 'B+')
  ).length

  // Unique relationship types from contacts
  const relationshipTypes = useMemo(() => {
    const types = new Set<string>()
    contacts.forEach(c => { if (c.relationshipType) types.add(c.relationshipType) })
    return Array.from(types)
  }, [contacts])

  // Filtered contacts
  const filteredContacts = useMemo(() => {
    return contacts.filter(c => {
      const matchesSearch = !contactSearch ||
        c.name.toLowerCase().includes(contactSearch.toLowerCase()) ||
        (c.email || '').toLowerCase().includes(contactSearch.toLowerCase()) ||
        (c.company || '').toLowerCase().includes(contactSearch.toLowerCase())
      const matchesSource = !sourceFilter || c.source === sourceFilter
      const matchesRelationship = !relationshipFilter || c.relationshipType === relationshipFilter
      const matchesStatus = !statusFilter || c.relationshipStatus === statusFilter
      return matchesSearch && matchesSource && matchesRelationship && matchesStatus
    })
  }, [contacts, contactSearch, sourceFilter, relationshipFilter, statusFilter])

  // Filtered matches
  const filteredMatches = useMemo(() => {
    return matches.filter(m => {
      const matchesSearch = !matchSearch ||
        m.clientContact.name.toLowerCase().includes(matchSearch.toLowerCase()) ||
        m.influencer.username.toLowerCase().includes(matchSearch.toLowerCase()) ||
        (m.influencer.displayName || '').toLowerCase().includes(matchSearch.toLowerCase())
      const matchesLevel = !levelFilter || m.matchLevel === levelFilter
      const matchesStatus = !matchStatusFilter || m.status === matchStatusFilter
      return matchesSearch && matchesLevel && matchesStatus
    })
  }, [matches, matchSearch, levelFilter, matchStatusFilter])

  // Add contact handler
  const handleAddContact = async () => {
    if (!formName.trim()) return
    setIsSaving(true)
    try {
      const res = await fetch('/api/client-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          email: formEmail.trim() || null,
          company: formCompany.trim() || null,
          domain: formDomain.trim() || null,
          phone: formPhone.trim() || null,
          instagramHandle: formInstagram.trim() || null,
          tiktokHandle: formTiktok.trim() || null,
          relationshipType: formRelationship.trim() || null,
          notes: formNotes.trim() || null,
        }),
      })
      if (res.ok) {
        resetAddForm()
        setShowAddModal(false)
        fetchContacts()
        fetchMatches()
      }
    } catch (err) {
      console.error('Error adding contact:', err)
    } finally {
      setIsSaving(false)
    }
  }

  const resetAddForm = () => {
    setFormName('')
    setFormEmail('')
    setFormCompany('')
    setFormDomain('')
    setFormPhone('')
    setFormInstagram('')
    setFormTiktok('')
    setFormRelationship('')
    setFormNotes('')
  }

  // CSV file handling
  const handleFileSelect = (file: File) => {
    setCsvFile(file)
    setImportResult(null)
    setIsParsing(true)
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const { headers, rows } = parseCSV(text)
      setCsvHeaders(headers)
      setCsvRows(rows)
      setCsvMapping(autoDetectMapping(headers))
      setIsParsing(false)
    }
    reader.readAsText(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file && (file.type === 'text/csv' || file.name.endsWith('.csv'))) {
      handleFileSelect(file)
    }
  }

  const handleImport = async () => {
    if (csvRows.length === 0) return
    setIsImporting(true)
    setImportResult(null)

    // Map rows to contact objects
    const mappedContacts = csvRows.map(row => {
      const contact: Record<string, string> = {}
      Object.entries(csvMapping).forEach(([idxStr, field]) => {
        if (field) {
          const idx = parseInt(idxStr)
          contact[field] = row[idx] || ''
        }
      })
      return contact
    }).filter(c => c.name || c.email) // At least name or email required

    try {
      const res = await fetch('/api/client-contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: mappedContacts }),
      })
      if (res.ok) {
        const data = await res.json()
        setImportResult({ imported: data.imported || 0, matches: data.matches || 0 })
        fetchContacts()
        fetchMatches()
      }
    } catch (err) {
      console.error('Error importing CSV:', err)
    } finally {
      setIsImporting(false)
    }
  }

  const resetImportModal = () => {
    setCsvFile(null)
    setCsvHeaders([])
    setCsvRows([])
    setCsvMapping({})
    setImportResult(null)
    setIsParsing(false)
    setIsImporting(false)
  }

  // Match actions
  const handleMatchAction = async (matchId: string, action: 'confirm' | 'reject') => {
    try {
      const res = await fetch(`/api/client-contacts/matches/${matchId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: action === 'confirm' ? 'USER_CONFIRMED' : 'USER_REJECTED',
        }),
      })
      if (res.ok) {
        fetchMatches()
        if (selectedMatch?.id === matchId) {
          const data = await res.json()
          setSelectedMatch(data.match || null)
        }
      }
    } catch (err) {
      console.error('Error updating match:', err)
    }
  }

  // --- Render ---

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {tr('title', 'My Client Base')}
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => { resetImportModal(); setShowImportModal(true) }}>
            <Upload className="h-4 w-4" />
            {tr('importCsv', 'Import CSV')}
          </Button>
          <Button onClick={() => { resetAddForm(); setShowAddModal(true) }}>
            <Plus className="h-4 w-4" />
            {tr('addContact', 'Add Contact')}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label={tr('totalClients', 'Total Clients')}
          value={totalClients}
          accent
        />
        <StatCard
          icon={<Zap className="h-5 w-5" />}
          label={tr('matchesFound', 'Matches Found')}
          value={totalMatches}
        />
        <StatCard
          icon={<Flame className="h-5 w-5" />}
          label={tr('warmOpportunities', 'Warm Opportunities (A+B)')}
          value={warmOpportunities}
        />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="contacts">
        <TabsList>
          <TabsTrigger value="contacts">{tr('contactsTab', 'Contacts')}</TabsTrigger>
          <TabsTrigger value="matches">{tr('matchesTab', 'Matches')}</TabsTrigger>
        </TabsList>

        {/* === Contacts Tab === */}
        <TabsContent value="contacts">
          {/* Search + Filters */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <Input
                placeholder={tr('searchContacts', 'Search contacts by name, email, company...')}
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                icon={<Search className="h-4 w-4" />}
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              >
                <option value="">{tr('allSources', 'All Sources')}</option>
                <option value="CSV">{tr('csv', 'CSV')}</option>
                <option value="MANUAL">{tr('manual', 'Manual')}</option>
                <option value="CRM">{tr('crm', 'CRM')}</option>
              </select>
              <select
                value={relationshipFilter}
                onChange={(e) => setRelationshipFilter(e.target.value)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              >
                <option value="">{tr('allRelationships', 'All Relationships')}</option>
                {relationshipTypes.map(rt => (
                  <option key={rt} value={rt}>{rt}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Contacts Table */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
              <span className="ml-2 text-gray-500">{t.common.loading}</span>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.common.name}</TableHead>
                    <TableHead>{tr('company', 'Company')}</TableHead>
                    <TableHead>{t.common.email}</TableHead>
                    <TableHead>{tr('source', 'Source')}</TableHead>
                    <TableHead>{tr('relationship', 'Relationship')}</TableHead>
                    <TableHead>{t.common.status}</TableHead>
                    <TableHead>{tr('matches', 'Matches')}</TableHead>
                    <TableHead>{t.common.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredContacts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-12 text-center text-gray-500">
                        {contacts.length === 0
                          ? tr('noContactsDesc', 'Add your first client contact or import a CSV to get started.')
                          : t.common.noResults}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredContacts.map((contact) => (
                      <TableRow key={contact.id}>
                        <TableCell>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{contact.name}</p>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-gray-600 dark:text-gray-400">{contact.company || '—'}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-gray-400">{contact.email || '—'}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="default">{contact.source}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-gray-600 dark:text-gray-400">
                            {contact.relationshipType || '—'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={
                            contact.relationshipStatus === 'active' ? 'active' :
                            contact.relationshipStatus === 'paused' ? 'paused' : 'default'
                          }>
                            {contact.relationshipStatus || '—'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {contact.matchCount > 0 ? (
                            <button
                              onClick={() => {
                                // Switch to matches tab filtered by this client (handled via search)
                                setMatchSearch(contact.name)
                                const tabEl = document.querySelector('[role="tab"][aria-selected="false"]') as HTMLButtonElement
                                if (tabEl) tabEl.click()
                              }}
                              className="inline-flex items-center gap-1 rounded-full bg-purple-50 dark:bg-purple-900/30 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors"
                            >
                              <Zap className="h-3 w-3" />
                              {contact.matchCount}
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">0</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => {
                              // Could open edit modal - for now, just a placeholder
                            }}
                            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100"
                            title="View"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* === Matches Tab === */}
        <TabsContent value="matches">
          {/* Search + Filters */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <Input
                placeholder={tr('searchContacts', 'Search by client or creator...')}
                value={matchSearch}
                onChange={(e) => setMatchSearch(e.target.value)}
                icon={<Search className="h-4 w-4" />}
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              >
                <option value="">{tr('allLevels', 'All Levels')}</option>
                <option value="EXACT">Exact</option>
                <option value="PROBABLE">Probable</option>
                <option value="POSSIBLE">Possible</option>
              </select>
              <select
                value={matchStatusFilter}
                onChange={(e) => setMatchStatusFilter(e.target.value)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              >
                <option value="">{tr('allStatuses', 'All Statuses')}</option>
                <option value="AUTO_DETECTED">Auto Detected</option>
                <option value="USER_CONFIRMED">Confirmed</option>
                <option value="USER_REJECTED">Rejected</option>
                <option value="PENDING_REVIEW">Pending Review</option>
              </select>
            </div>
          </div>

          {/* Matches Table */}
          {isLoadingMatches ? (
            <div className="flex items-center justify-center py-16 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
              <span className="ml-2 text-gray-500">{t.common.loading}</span>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr('client', 'Client')}</TableHead>
                    <TableHead>{tr('creator', 'Creator')}</TableHead>
                    <TableHead>{tr('platform', 'Platform')}</TableHead>
                    <TableHead>{tr('confidence', 'Confidence')}</TableHead>
                    <TableHead>{tr('level', 'Level')}</TableHead>
                    <TableHead>{t.common.status}</TableHead>
                    <TableHead>{tr('warmScore', 'Warm Score')}</TableHead>
                    <TableHead>{t.common.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMatches.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-12 text-center text-gray-500">
                        {matches.length === 0
                          ? tr('noMatchesDesc', 'Matches will appear here once contacts are analyzed.')
                          : t.common.noResults}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredMatches.map((match) => (
                      <TableRow
                        key={match.id}
                        className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        onClick={() => setSelectedMatch(match)}
                      >
                        <TableCell>
                          <div>
                            <p className="font-medium text-gray-900 dark:text-gray-100">{match.clientContact.name}</p>
                            {match.clientContact.company && (
                              <p className="text-xs text-gray-500">{match.clientContact.company}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div>
                              <p className="font-medium text-gray-900 dark:text-gray-100">@{match.influencer.username}</p>
                              {match.influencer.displayName && (
                                <p className="text-xs text-gray-500">{match.influencer.displayName}</p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <PlatformIcon platform={match.influencer.platform} />
                            <span className="text-sm">
                              {match.influencer.platform.charAt(0) + match.influencer.platform.slice(1).toLowerCase()}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <ConfidenceBar value={match.confidence} />
                        </TableCell>
                        <TableCell>
                          <Badge variant={levelBadgeVariant(match.matchLevel)}>
                            {match.matchLevel}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(match.status)}`}>
                            {formatStatusLabel(match.status)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {match.warmGrade ? (
                            <span className={`text-sm font-bold ${gradeColor(match.warmGrade)}`}>
                              {match.warmGrade}
                              {match.warmScore !== null && (
                                <span className="ml-1 text-xs font-normal text-gray-400">({match.warmScore})</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            {(match.status === 'AUTO_DETECTED' || match.status === 'PENDING_REVIEW') && (
                              <>
                                <button
                                  onClick={() => handleMatchAction(match.id, 'confirm')}
                                  className="rounded-lg p-1.5 text-green-600 transition-colors hover:bg-green-50 dark:hover:bg-green-900/20"
                                  title={tr('confirmMatch', 'Confirm')}
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => handleMatchAction(match.id, 'reject')}
                                  className="rounded-lg p-1.5 text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
                                  title={tr('rejectMatch', 'Reject')}
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* === Add Contact Modal === */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)}>
        <ModalHeader onClose={() => setShowAddModal(false)}>
          {tr('addContact', 'Add Contact')}
        </ModalHeader>
        <ModalBody>
          <div className="space-y-4">
            <Input
              label={t.common.name}
              placeholder="John Smith"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
            <Input
              label={t.common.email}
              placeholder="john@company.com"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              type="email"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label={tr('company', 'Company')}
                placeholder="Acme Corp"
                value={formCompany}
                onChange={(e) => setFormCompany(e.target.value)}
              />
              <Input
                label={tr('domain', 'Domain')}
                placeholder="acme.com"
                value={formDomain}
                onChange={(e) => setFormDomain(e.target.value)}
              />
            </div>
            <Input
              label={tr('phone', 'Phone')}
              placeholder="+1 555 123 4567"
              value={formPhone}
              onChange={(e) => setFormPhone(e.target.value)}
              type="tel"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label={tr('instagram', 'Instagram')}
                placeholder="@handle"
                value={formInstagram}
                onChange={(e) => setFormInstagram(e.target.value)}
              />
              <Input
                label={tr('tiktok', 'TikTok')}
                placeholder="@handle"
                value={formTiktok}
                onChange={(e) => setFormTiktok(e.target.value)}
              />
            </div>
            <Input
              label={tr('relationshipType', 'Relationship Type')}
              placeholder="Client, Partner, Lead..."
              value={formRelationship}
              onChange={(e) => setFormRelationship(e.target.value)}
            />
            <div className="w-full">
              <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                {tr('notes', 'Notes')}
              </label>
              <textarea
                className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 transition-colors focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                rows={3}
                placeholder="Additional notes..."
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setShowAddModal(false)}>
            {t.common.cancel}
          </Button>
          <Button onClick={handleAddContact} disabled={!formName.trim() || isSaving}>
            {isSaving ? t.common.loading : tr('saveContact', 'Save Contact')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* === Import CSV Modal === */}
      <Modal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        className="max-w-2xl"
      >
        <ModalHeader onClose={() => setShowImportModal(false)}>
          {tr('importTitle', 'Import CSV')}
        </ModalHeader>
        <ModalBody>
          <div className="space-y-4">
            {/* File Upload Area */}
            {!csvFile ? (
              <div
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50 p-8 cursor-pointer transition-colors hover:border-purple-400 hover:bg-purple-50/50 dark:hover:bg-purple-900/10"
              >
                <FileSpreadsheet className="h-10 w-10 text-gray-400" />
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
                  {tr('dragDrop', 'Drag & drop your CSV file here, or click to browse')}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFileSelect(file)
                  }}
                />
              </div>
            ) : isParsing ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                <span className="ml-2 text-gray-500">{tr('parsingFile', 'Parsing file...')}</span>
              </div>
            ) : (
              <>
                {/* File info */}
                <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-5 w-5 text-purple-600" />
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{csvFile.name}</span>
                    <span className="text-xs text-gray-400">({csvRows.length} {tr('rows', 'rows')})</span>
                  </div>
                  <button
                    onClick={() => { resetImportModal() }}
                    className="rounded-lg p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Column Mapping */}
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {tr('columnMapping', 'Column Mapping')}
                  </h3>
                  <div className="grid grid-cols-2 gap-2">
                    {csvHeaders.map((header, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="min-w-[100px] truncate text-xs text-gray-500 dark:text-gray-400" title={header}>
                          {header}
                        </span>
                        <select
                          value={csvMapping[idx] || ''}
                          onChange={(e) => setCsvMapping(prev => ({ ...prev, [idx]: e.target.value as MappableField | '' }))}
                          className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-900 dark:text-white focus:border-purple-500 focus:outline-none"
                        >
                          <option value="">{tr('skipColumn', '(skip)')}</option>
                          {MAPPABLE_FIELDS.map(f => (
                            <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Preview */}
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {tr('preview', 'Preview')} ({Math.min(5, csvRows.length)} {tr('rows', 'rows')})
                  </h3>
                  <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-gray-800">
                          {csvHeaders.map((h, i) => (
                            <th key={i} className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                              {h}
                              {csvMapping[i] && (
                                <span className="ml-1 text-purple-600">({csvMapping[i]})</span>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvRows.slice(0, 5).map((row, ri) => (
                          <tr key={ri} className="border-t border-gray-100 dark:border-gray-700">
                            {row.map((cell, ci) => (
                              <td key={ci} className="whitespace-nowrap px-3 py-1.5 text-gray-700 dark:text-gray-300">
                                {cell || '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Import result */}
                {importResult && (
                  <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-4 py-3">
                    <p className="text-sm text-green-700 dark:text-green-400">
                      Imported {importResult.imported} contacts, found {importResult.matches} matches
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setShowImportModal(false)}>
            {importResult ? t.common.close : t.common.cancel}
          </Button>
          {csvFile && !importResult && (
            <Button
              onClick={handleImport}
              disabled={isImporting || csvRows.length === 0}
            >
              {isImporting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {tr('importing', 'Importing...')}
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  {tr('importButton', 'Import')} ({csvRows.length})
                </>
              )}
            </Button>
          )}
        </ModalFooter>
      </Modal>

      {/* === Match Detail Drawer === */}
      {selectedMatch && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setSelectedMatch(null)} />
          <div className="relative z-10 h-full w-full max-w-2xl overflow-y-auto border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl">
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {tr('matchDetail', 'Match Detail')}
              </h2>
              <button
                onClick={() => setSelectedMatch(null)}
                className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Client + Creator side by side */}
              <div className="grid grid-cols-2 gap-6">
                {/* Client Info */}
                <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                  <h3 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {tr('clientInfo', 'Client Info')}
                  </h3>
                  <p className="text-base font-medium text-gray-900 dark:text-gray-100">{selectedMatch.clientContact.name}</p>
                  {selectedMatch.clientContact.company && (
                    <p className="mt-1 text-sm text-gray-500">{selectedMatch.clientContact.company}</p>
                  )}
                </div>

                {/* Creator Info */}
                <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                  <h3 className="mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {tr('creatorInfo', 'Creator Info')}
                  </h3>
                  <div className="flex items-center gap-2">
                    <PlatformIcon platform={selectedMatch.influencer.platform} />
                    <p className="text-base font-medium text-gray-900 dark:text-gray-100">@{selectedMatch.influencer.username}</p>
                  </div>
                  {selectedMatch.influencer.displayName && (
                    <p className="mt-1 text-sm text-gray-500">{selectedMatch.influencer.displayName}</p>
                  )}
                </div>
              </div>

              {/* Match Info */}
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">{tr('level', 'Level')}</span>
                  <Badge variant={levelBadgeVariant(selectedMatch.matchLevel)}>{selectedMatch.matchLevel}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">{tr('confidence', 'Confidence')}</span>
                  <ConfidenceBar value={selectedMatch.confidence} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">{t.common.status}</span>
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(selectedMatch.status)}`}>
                    {formatStatusLabel(selectedMatch.status)}
                  </span>
                </div>
              </div>

              {/* Match Signals */}
              {selectedMatch.signals.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {tr('matchSignals', 'Match Signals')}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedMatch.signals.map((signal, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-900/20 px-3 py-1 text-xs text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800"
                      >
                        {signal}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Warm Score Section */}
              {selectedMatch.warmGrade && (
                <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {tr('warmScoreSection', 'Warm Score')}
                  </h3>

                  <div className="flex items-center gap-4">
                    <div className={`text-4xl font-bold ${gradeColor(selectedMatch.warmGrade)}`}>
                      {selectedMatch.warmGrade}
                    </div>
                    {selectedMatch.warmScore !== null && (
                      <div className="text-sm text-gray-500">
                        Score: {selectedMatch.warmScore}/100
                      </div>
                    )}
                  </div>

                  {selectedMatch.warmReasons.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        {tr('reasons', 'Reasons')}
                      </h4>
                      <ul className="space-y-1">
                        {selectedMatch.warmReasons.map((reason, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                            <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" />
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selectedMatch.warmRisks.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        {tr('risks', 'Risks')}
                      </h4>
                      <ul className="space-y-1">
                        {selectedMatch.warmRisks.map((risk, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                            <X className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" />
                            {risk}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selectedMatch.warmRecommendedUse && (
                    <div>
                      <h4 className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        {tr('recommendedUse', 'Recommended Use')}
                      </h4>
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        {selectedMatch.warmRecommendedUse}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              {(selectedMatch.status === 'AUTO_DETECTED' || selectedMatch.status === 'PENDING_REVIEW') && (
                <div className="flex items-center gap-3 pt-2">
                  <Button
                    onClick={() => handleMatchAction(selectedMatch.id, 'confirm')}
                    className="flex-1"
                  >
                    <Check className="h-4 w-4" />
                    {tr('confirmMatch', 'Confirm')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => handleMatchAction(selectedMatch.id, 'reject')}
                    className="flex-1"
                  >
                    <X className="h-4 w-4" />
                    {tr('rejectMatch', 'Reject')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

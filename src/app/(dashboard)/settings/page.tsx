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
} from "lucide-react"

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
  const { t } = useI18n()

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

  // ---------- Team Data Fetch ----------

  useEffect(() => {
    fetchTeam()
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
        body: JSON.stringify({ email: inviteEmail, role: inviteRole.toUpperCase() }),
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

  function handleToggleIntegration(id: string) {
    setIntegrations((prev) =>
      prev.map((i) => (i.id === id ? { ...i, connected: !i.connected } : i))
    )
  }

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
          <TabsTrigger value="team" className="gap-1.5">
            <Users className="h-4 w-4" /> {t.settings.team}
          </TabsTrigger>
          <TabsTrigger value="integrations" className="gap-1.5">
            <Plug className="h-4 w-4" /> {t.settings.integrations}
          </TabsTrigger>
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
                              <button
                                className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                                title={t.common.edit}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
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
        </TabsContent>

        {/* ===================== INTEGRATIONS TAB ===================== */}
        <TabsContent value="integrations">
          <div className="grid gap-4 sm:grid-cols-2">
            {integrations.map((integration) => (
              <Card key={integration.id} variant="elevated">
                <CardContent>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 ${integration.color}`}
                      >
                        {integration.icon}
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900">{integration.name}</h3>
                        <p className="mt-0.5 text-xs text-gray-400">{t.settings[integration.description as keyof typeof t.settings] || integration.description}</p>
                      </div>
                    </div>
                    <Badge variant={integration.connected ? "active" : "archived"}>
                      {integration.connected ? t.settings.connected : t.settings.notConnected}
                    </Badge>
                  </div>
                  <div className="mt-4">
                    <Button
                      size="sm"
                      variant={integration.connected ? "secondary" : "primary"}
                      onClick={() => handleToggleIntegration(integration.id)}
                    >
                      {integration.connected ? (
                        <>{t.settings.disconnect}</>
                      ) : (
                        <>
                          <ExternalLink className="h-3.5 w-3.5" /> {t.settings.connect}
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}

            {/* Apify Card */}
            <Card variant="elevated">
              <CardContent>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 text-purple-600">
                      <Key className="h-6 w-6" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">Apify</h3>
                      <p className="mt-0.5 text-xs text-gray-400">
                        {t.settings.scrapingEngine}
                      </p>
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
                  <Button size="sm" variant="secondary" className="mb-[1px]">
                    {t.common.save}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ===================== BILLING TAB ===================== */}
        <TabsContent value="billing">
          <div className="space-y-6">
            {/* Current Plan */}
            <Card variant="elevated">
              <CardHeader>
                <CardTitle>{t.settings.currentPlan}</CardTitle>
                <Badge variant="active">Pro</Badge>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 mb-4" dangerouslySetInnerHTML={{ __html: t.settings.planDescription }} />
                <div className="flex gap-3">
                  <Button size="sm">
                    <Zap className="h-3.5 w-3.5" /> {t.settings.upgradeEnterprise}
                  </Button>
                  <Button size="sm" variant="ghost">
                    {t.settings.manageSubscription}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Usage Stats */}
            <Card variant="elevated">
              <CardHeader>
                <CardTitle>{t.settings.usageThisPeriod}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  <UsageStat label={t.settings.campaignsUsed} used={12} limit={25} />
                  <UsageStat label={t.settings.profilesTracked} used={348} limit={500} />
                  <UsageStat label={t.settings.apiCalls} used={8420} limit={50000} />
                  <UsageStat label={t.settings.teamMembersUsage} used={4} limit={10} />
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

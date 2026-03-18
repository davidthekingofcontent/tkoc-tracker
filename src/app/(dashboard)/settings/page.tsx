"use client"

import { useState } from "react"
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
} from "lucide-react"

// ---------- Mock Data ----------

const mockProfile = {
  name: "David Calamardo",
  email: "david@tkoc.com",
  company: "TKOC Agency",
}

interface TeamMember {
  id: number
  name: string
  email: string
  role: "Admin" | "Employee" | "Brand"
  status: "Active" | "Invited"
  avatarUrl?: string
}

const mockTeam: TeamMember[] = [
  { id: 1, name: "David Calamardo", email: "david@tkoc.com", role: "Admin", status: "Active" },
  { id: 2, name: "Sofia Martinez", email: "sofia@tkoc.com", role: "Employee", status: "Active" },
  { id: 3, name: "Alex Johnson", email: "alex@tkoc.com", role: "Employee", status: "Active" },
  { id: 4, name: "New Hire", email: "newhire@tkoc.com", role: "Brand", status: "Invited" },
]

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
    description: "Track stories, reels, and posts from influencer accounts",
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
    description: "Monitor TikTok creator content and engagement metrics",
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
    description: "Track YouTube videos, shorts, and channel analytics",
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
  const [team, setTeam] = useState<TeamMember[]>(mockTeam)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("Employee")

  // Integrations state
  const [integrations, setIntegrations] = useState(mockIntegrations)
  const [apifyKey, setApifyKey] = useState("")

  // ---------- Handlers ----------

  function handleProfileSave() {
    setProfileSaving(true)
    setTimeout(() => {
      setProfileSaving(false)
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2000)
    }, 800)
  }

  function handleInvite() {
    if (!inviteEmail) return
    const newMember: TeamMember = {
      id: Date.now(),
      name: inviteEmail.split("@")[0],
      email: inviteEmail,
      role: inviteRole as TeamMember["role"],
      status: "Invited",
    }
    setTeam((prev) => [...prev, newMember])
    setInviteEmail("")
    setInviteRole("Employee")
    setInviteOpen(false)
  }

  function handleRemoveMember(id: number) {
    setTeam((prev) => prev.filter((m) => m.id !== id))
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
              <CardTitle>Profile Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* Avatar Upload */}
                <div className="flex items-center gap-6">
                  <div className="relative">
                    <Avatar name={profileName} size="lg" />
                    <button
                      className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
                      title="Upload avatar"
                    >
                      <Camera className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Profile Photo</p>
                    <p className="text-xs text-gray-400">JPG, PNG or GIF. Max 2MB.</p>
                  </div>
                </div>

                {/* Fields */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label="Full Name"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                  />
                  <Input
                    label="Email Address"
                    type="email"
                    value={profileEmail}
                    onChange={(e) => setProfileEmail(e.target.value)}
                  />
                </div>
                <div className="max-w-sm">
                  <Input
                    label="Company"
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
                    <span className="text-sm text-emerald-500">Profile updated successfully.</span>
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
              <CardTitle>Team Members</CardTitle>
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <Send className="h-3.5 w-3.5" /> Invite Team Member
              </Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-xs uppercase tracking-wider text-gray-400">
                      <th className="pb-3 pr-4 font-medium">{t.common.name}</th>
                      <th className="pb-3 pr-4 font-medium">{t.common.email}</th>
                      <th className="pb-3 pr-4 font-medium">Role</th>
                      <th className="pb-3 pr-4 font-medium">{t.common.status}</th>
                      <th className="pb-3 font-medium text-right">{t.common.actions}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {team.map((member) => (
                      <tr key={member.id} className="group">
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-3">
                            <Avatar name={member.name} size="sm" src={member.avatarUrl} />
                            <span className="font-medium text-gray-900">{member.name}</span>
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-gray-500">{member.email}</td>
                        <td className="py-3 pr-4">
                          <Badge
                            variant={member.role === "Admin" ? "active" : "default"}
                          >
                            {member.role}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant={member.status === "Active" ? "active" : "paused"}>
                            {member.status}
                          </Badge>
                        </td>
                        <td className="py-3 text-right">
                          <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                              title={t.common.edit}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                              title={t.common.remove}
                              onClick={() => handleRemoveMember(member.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Invite Modal */}
          <Modal open={inviteOpen} onClose={() => setInviteOpen(false)}>
            <ModalHeader onClose={() => setInviteOpen(false)}>
              Invite Team Member
            </ModalHeader>
            <ModalBody>
              <div className="space-y-4">
                <Input
                  label="Email Address"
                  type="email"
                  placeholder="colleague@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
                <Select
                  label="Role"
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
              <Button onClick={handleInvite}>
                <Send className="h-4 w-4" /> Send Invite
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
                        <p className="mt-0.5 text-xs text-gray-400">{integration.description}</p>
                      </div>
                    </div>
                    <Badge variant={integration.connected ? "active" : "archived"}>
                      {integration.connected ? "Connected" : "Not connected"}
                    </Badge>
                  </div>
                  <div className="mt-4">
                    <Button
                      size="sm"
                      variant={integration.connected ? "secondary" : "primary"}
                      onClick={() => handleToggleIntegration(integration.id)}
                    >
                      {integration.connected ? (
                        <>Disconnect</>
                      ) : (
                        <>
                          <ExternalLink className="h-3.5 w-3.5" /> Connect
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
                        Scraping engine for influencer data collection
                      </p>
                    </div>
                  </div>
                  <Badge variant={apifyKey ? "active" : "archived"}>
                    {apifyKey ? "Configured" : "Not configured"}
                  </Badge>
                </div>
                <div className="mt-4 flex items-end gap-2">
                  <div className="flex-1">
                    <Input
                      label="API Key"
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
                <CardTitle>Current Plan</CardTitle>
                <Badge variant="active">Pro</Badge>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 mb-4">
                  You are on the <span className="font-medium text-gray-900">Pro</span> plan.
                  Billed monthly at <span className="font-medium text-gray-900">$99/mo</span>.
                </p>
                <div className="flex gap-3">
                  <Button size="sm">
                    <Zap className="h-3.5 w-3.5" /> Upgrade to Enterprise
                  </Button>
                  <Button size="sm" variant="ghost">
                    Manage Subscription
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Usage Stats */}
            <Card variant="elevated">
              <CardHeader>
                <CardTitle>Usage This Period</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  <UsageStat label="Campaigns Used" used={12} limit={25} />
                  <UsageStat label="Profiles Tracked" used={348} limit={500} />
                  <UsageStat label="API Calls" used={8420} limit={50000} />
                  <UsageStat label="Team Members" used={4} limit={10} />
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

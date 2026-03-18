'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { useI18n } from '@/i18n/context'
import {
  ArrowLeft,
  Radio,
  UserCheck,
  Instagram,
  Youtube,
  X,
  Plus,
  Calendar,
  Infinity,
} from 'lucide-react'

type TrackingType = 'social_listening' | 'influencer_tracking' | null

export default function NewCampaignPage() {
  const router = useRouter()
  const { t } = useI18n()
  const [trackingType, setTrackingType] = useState<TrackingType>(null)
  const [campaignName, setCampaignName] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [targetInput, setTargetInput] = useState('')
  const [platforms, setPlatforms] = useState<Record<string, boolean>>({
    instagram: false,
    tiktok: false,
    youtube: false,
  })
  const [influencers, setInfluencers] = useState<string[]>([])
  const [influencerInput, setInfluencerInput] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const addTarget = useCallback(() => {
    const value = targetInput.trim()
    if (value && !targets.includes(value)) {
      setTargets((prev) => [...prev, value])
      setTargetInput('')
    }
  }, [targetInput, targets])

  const removeTarget = (target: string) => {
    setTargets((prev) => prev.filter((t) => t !== target))
  }

  const addInfluencer = useCallback(() => {
    const value = influencerInput.trim()
    if (value && !influencers.includes(value)) {
      setInfluencers((prev) => [...prev, value])
      setInfluencerInput('')
    }
  }, [influencerInput, influencers])

  const removeInfluencer = (handle: string) => {
    setInfluencers((prev) => prev.filter((i) => i !== handle))
  }

  const togglePlatform = (platform: string) => {
    setPlatforms((prev) => ({ ...prev, [platform]: !prev[platform] }))
  }

  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    if (!campaignName.trim() || !trackingType) return

    setIsCreating(true)
    setError('')

    const selectedPlatforms = Object.entries(platforms)
      .filter(([, enabled]) => enabled)
      .map(([platform]) => platform.toUpperCase())

    const targetAccounts = targets.filter((t) => t.startsWith('@'))
    const targetHashtags = targets.filter((t) => t.startsWith('#'))

    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName.trim(),
          type: trackingType === 'social_listening' ? 'SOCIAL_LISTENING' : 'INFLUENCER_TRACKING',
          platforms: selectedPlatforms,
          targetAccounts,
          targetHashtags,
          ...(trackingType === 'influencer_tracking' && startDate && { startDate }),
          ...(trackingType === 'influencer_tracking' && endDate && { endDate }),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create campaign')
      }

      const { campaign } = await res.json()
      router.push(`/campaigns/${campaign.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setIsCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/campaigns">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
            {t.common.back}
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.campaigns.createCampaign}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t.campaigns.setupNew}
          </p>
        </div>
      </div>

      {/* Tracking Type Selection */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {t.campaigns.chooseType}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Social Listening Card */}
          <button
            onClick={() => setTrackingType('social_listening')}
            className="text-left"
          >
            <Card
              className={`cursor-pointer transition-all hover:border-purple-300 ${
                trackingType === 'social_listening'
                  ? 'border-purple-600 bg-purple-50'
                  : ''
              }`}
              variant="elevated"
            >
              <div className="flex items-start gap-4">
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
                    trackingType === 'social_listening'
                      ? 'bg-purple-100 text-purple-600'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  <Radio className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">
                    {t.campaigns.socialListening}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {t.campaigns.socialListeningDesc}
                  </p>
                </div>
              </div>
              {trackingType === 'social_listening' && (
                <div className="mt-4 flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-purple-600" />
                  <span className="text-xs font-medium text-purple-600">
                    {t.campaigns.selected}
                  </span>
                </div>
              )}
            </Card>
          </button>

          {/* Influencer Tracking Card */}
          <button
            onClick={() => setTrackingType('influencer_tracking')}
            className="text-left"
          >
            <Card
              className={`cursor-pointer transition-all hover:border-purple-300 ${
                trackingType === 'influencer_tracking'
                  ? 'border-purple-600 bg-purple-50'
                  : ''
              }`}
              variant="elevated"
            >
              <div className="flex items-start gap-4">
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
                    trackingType === 'influencer_tracking'
                      ? 'bg-purple-100 text-purple-600'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  <UserCheck className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">
                    {t.campaigns.influencerTracking}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {t.campaigns.influencerTrackingDesc}
                  </p>
                </div>
              </div>
              {trackingType === 'influencer_tracking' && (
                <div className="mt-4 flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-purple-600" />
                  <span className="text-xs font-medium text-purple-600">
                    {t.campaigns.selected}
                  </span>
                </div>
              )}
            </Card>
          </button>
        </div>
      </div>

      {/* Step Form (shown after type selection) */}
      {trackingType && (
        <div className="space-y-6">
          {/* Campaign Name */}
          <Card variant="elevated">
            <h3 className="mb-4 text-base font-semibold text-gray-900">
              {t.campaigns.campaignDetails}
            </h3>
            <Input
              label={t.campaigns.campaignName}
              placeholder={t.campaigns.campaignNamePlaceholder}
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
            />
          </Card>

          {/* Brand Account Targets */}
          <Card variant="elevated">
            <h3 className="mb-4 text-base font-semibold text-gray-900">
              {t.campaigns.brandTargets}
            </h3>
            <p className="mb-4 text-sm text-gray-500">
              {t.campaigns.brandTargetsDesc}
            </p>
            <div className="flex gap-2">
              <Input
                placeholder={t.campaigns.brandTargetPlaceholder}
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTarget()
                  }
                }}
              />
              <Button onClick={addTarget} variant="secondary" size="md">
                <Plus className="h-4 w-4" />
                {t.common.add}
              </Button>
            </div>
            {targets.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {targets.map((target) => (
                  <span
                    key={target}
                    className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-sm text-gray-600"
                  >
                    {target}
                    <button
                      onClick={() => removeTarget(target)}
                      className="text-gray-400 transition-colors hover:text-gray-900"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* Platform Selection */}
          <Card variant="elevated">
            <h3 className="mb-4 text-base font-semibold text-gray-900">
              {t.campaigns.platforms}
            </h3>
            <p className="mb-4 text-sm text-gray-500">
              {t.campaigns.platformsDesc}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => togglePlatform('instagram')}
                className={`flex items-center gap-2 rounded-lg border px-4 py-3 transition-all ${
                  platforms.instagram
                    ? 'border-pink-500/50 bg-pink-50 text-pink-500'
                    : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300'
                }`}
              >
                <Instagram className="h-5 w-5" />
                <span className="text-sm font-medium">Instagram</span>
                {platforms.instagram && (
                  <div className="ml-1 h-2 w-2 rounded-full bg-pink-400" />
                )}
              </button>

              <button
                onClick={() => togglePlatform('tiktok')}
                className={`flex items-center gap-2 rounded-lg border px-4 py-3 transition-all ${
                  platforms.tiktok
                    ? 'border-cyan-500/50 bg-cyan-50 text-cyan-500'
                    : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300'
                }`}
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z" />
                </svg>
                <span className="text-sm font-medium">TikTok</span>
                {platforms.tiktok && (
                  <div className="ml-1 h-2 w-2 rounded-full bg-cyan-400" />
                )}
              </button>

              <button
                onClick={() => togglePlatform('youtube')}
                className={`flex items-center gap-2 rounded-lg border px-4 py-3 transition-all ${
                  platforms.youtube
                    ? 'border-red-500/50 bg-red-50 text-red-500'
                    : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300'
                }`}
              >
                <Youtube className="h-5 w-5" />
                <span className="text-sm font-medium">YouTube</span>
                {platforms.youtube && (
                  <div className="ml-1 h-2 w-2 rounded-full bg-red-400" />
                )}
              </button>
            </div>
          </Card>

          {/* Campaign Duration */}
          {trackingType === 'social_listening' && (
            <Card variant="elevated">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50 text-green-600">
                  <Infinity className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">
                    {t.campaigns.alwaysOn || 'Always On'}
                  </h3>
                  <p className="text-sm text-gray-500">
                    {t.campaigns.alwaysOnDesc || 'This campaign will continuously track all brand mentions and hashtags with no end date.'}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {trackingType === 'influencer_tracking' && (
            <Card variant="elevated">
              <div className="flex items-center gap-2 mb-4">
                <Calendar className="h-4 w-4 text-purple-600" />
                <h3 className="text-base font-semibold text-gray-900">
                  {t.campaigns.campaignDuration || 'Campaign Duration'}
                </h3>
              </div>
              <p className="mb-4 text-sm text-gray-500">
                {t.campaigns.campaignDurationDesc || 'Set the tracking period for this campaign. Only content posted within these dates will be tracked.'}
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">
                    {t.campaigns.startDateLabel || 'Start Date'}
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">
                    {t.campaigns.endDateLabel || 'End Date'}
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    min={startDate || undefined}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                  />
                </div>
              </div>
            </Card>
          )}

          {/* Add Influencers (only for Influencer Tracking) */}
          {trackingType === 'influencer_tracking' && (
            <Card variant="elevated">
              <h3 className="mb-4 text-base font-semibold text-gray-900">
                {t.campaigns.addInfluencers}
              </h3>
              <p className="mb-4 text-sm text-gray-500">
                {t.campaigns.addInfluencersDesc}
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder={t.campaigns.influencerPlaceholder}
                  value={influencerInput}
                  onChange={(e) => setInfluencerInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addInfluencer()
                    }
                  }}
                />
                <Button onClick={addInfluencer} variant="secondary" size="md">
                  <Plus className="h-4 w-4" />
                  {t.common.add}
                </Button>
              </div>
              {influencers.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {influencers.map((handle) => (
                    <span
                      key={handle}
                      className="inline-flex items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-3 py-1 text-sm text-purple-600"
                    >
                      {handle}
                      <button
                        onClick={() => removeInfluencer(handle)}
                        className="text-purple-400 transition-colors hover:text-purple-700"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Error Message */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 pt-6">
            <Link href="/campaigns">
              <Button variant="ghost">{t.common.cancel}</Button>
            </Link>
            <Button
              onClick={handleCreate}
              disabled={!campaignName.trim() || isCreating}
            >
              {isCreating ? t.campaigns.creating : t.campaigns.createCampaign}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

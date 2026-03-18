'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import {
  ArrowLeft,
  Radio,
  UserCheck,
  Instagram,
  Youtube,
  X,
  Plus,
} from 'lucide-react'

type TrackingType = 'social_listening' | 'influencer_tracking' | null

export default function NewCampaignPage() {
  const router = useRouter()
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

  const handleCreate = () => {
    // In a real app, this would POST to /api/campaigns
    router.push('/campaigns')
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/campaigns">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Create Campaign</h1>
          <p className="mt-1 text-sm text-gray-500">
            Set up a new tracking campaign
          </p>
        </div>
      </div>

      {/* Tracking Type Selection */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          Choose tracking type
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
                    Social Listening
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Track everyone mentioning your brand, hashtags, or accounts.
                    Discover organic content and UGC automatically.
                  </p>
                </div>
              </div>
              {trackingType === 'social_listening' && (
                <div className="mt-4 flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-purple-600" />
                  <span className="text-xs font-medium text-purple-600">
                    Selected
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
                    Influencer Tracking
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Track specific influencers and monitor their posts, stories,
                    and engagement metrics in real-time.
                  </p>
                </div>
              </div>
              {trackingType === 'influencer_tracking' && (
                <div className="mt-4 flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-purple-600" />
                  <span className="text-xs font-medium text-purple-600">
                    Selected
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
              Campaign Details
            </h3>
            <Input
              label="Campaign Name"
              placeholder="e.g., Vileda Spring 2026"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
            />
          </Card>

          {/* Brand Account Targets */}
          <Card variant="elevated">
            <h3 className="mb-4 text-base font-semibold text-gray-900">
              Brand Account Targets
            </h3>
            <p className="mb-4 text-sm text-gray-500">
              Add @mentions and #hashtags to track
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="@brand or #hashtag"
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
                Add
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
              Platforms
            </h3>
            <p className="mb-4 text-sm text-gray-500">
              Select platforms to track
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

          {/* Add Influencers (only for Influencer Tracking) */}
          {trackingType === 'influencer_tracking' && (
            <Card variant="elevated">
              <h3 className="mb-4 text-base font-semibold text-gray-900">
                Add Influencers
              </h3>
              <p className="mb-4 text-sm text-gray-500">
                Add influencer handles to track
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="@influencer_handle"
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
                  Add
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

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 pt-6">
            <Link href="/campaigns">
              <Button variant="ghost">Cancel</Button>
            </Link>
            <Button
              onClick={handleCreate}
              disabled={!campaignName.trim()}
            >
              Create Campaign
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

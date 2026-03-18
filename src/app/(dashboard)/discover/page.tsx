'use client'

import { useState } from 'react'
import { Search, RotateCcw, Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useI18n } from '@/i18n/context'

export default function DiscoverPage() {
  const { t } = useI18n()
  const [filters, setFilters] = useState({
    platform: 'instagram',
    topic: '',
    followersMin: '',
    followersMax: '',
    location: '',
    engagement: '',
    viewsMin: '',
    viewsMax: '',
    gender: '',
    language: '',
    bioKeyword: '',
    audienceLocation: '',
    audienceGender: '',
    audienceLanguage: '',
  })
  const [hasSearched, setHasSearched] = useState(false)

  const updateFilter = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const resetFilters = () => {
    setFilters({
      platform: 'instagram',
      topic: '',
      followersMin: '',
      followersMax: '',
      location: '',
      engagement: '',
      viewsMin: '',
      viewsMax: '',
      gender: '',
      language: '',
      bioKeyword: '',
      audienceLocation: '',
      audienceGender: '',
      audienceLanguage: '',
    })
    setHasSearched(false)
  }

  const handleSearch = () => {
    setHasSearched(true)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.discover.title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t.discover.subtitle}
        </p>
      </div>

      {/* Main Layout */}
      <div className="flex gap-6">
        {/* Left Sidebar Filters */}
        <div className="w-80 shrink-0 space-y-5 rounded-xl border border-gray-200 bg-white shadow-sm p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
              {t.discover.filters}
            </h2>
            <button
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-900 transition-colors"
            >
              <RotateCcw className="h-3 w-3" />
              Reset all
            </button>
          </div>

          <Select
            label={t.campaigns.platform}
            value={filters.platform}
            onChange={(e) => updateFilter('platform', e.target.value)}
            options={[
              { value: 'instagram', label: 'Instagram' },
              { value: 'tiktok', label: 'TikTok' },
              { value: 'youtube', label: 'YouTube' },
            ]}
          />

          <Input
            label={t.discover.category}
            placeholder={t.discover.searchPlaceholder}
            value={filters.topic}
            onChange={(e) => updateFilter('topic', e.target.value)}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              {t.campaigns.followers}
            </label>
            <div className="flex items-center gap-2">
              <Input
                placeholder={t.discover.minFollowers}
                type="number"
                value={filters.followersMin}
                onChange={(e) => updateFilter('followersMin', e.target.value)}
              />
              <span className="text-gray-400">-</span>
              <Input
                placeholder={t.discover.maxFollowers}
                type="number"
                value={filters.followersMax}
                onChange={(e) => updateFilter('followersMax', e.target.value)}
              />
            </div>
          </div>

          <Input
            label={t.discover.location}
            placeholder="e.g. Madrid, Spain"
            value={filters.location}
            onChange={(e) => updateFilter('location', e.target.value)}
          />

          <Select
            label={`${t.campaigns.engagement} %`}
            value={filters.engagement}
            onChange={(e) => updateFilter('engagement', e.target.value)}
            placeholder="Any"
            options={[
              { value: '1', label: '> 1%' },
              { value: '3', label: '> 3%' },
              { value: '5', label: '> 5%' },
              { value: '8', label: '> 8%' },
              { value: '10', label: '> 10%' },
            ]}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Average Video Views
            </label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Min"
                type="number"
                value={filters.viewsMin}
                onChange={(e) => updateFilter('viewsMin', e.target.value)}
              />
              <span className="text-gray-400">-</span>
              <Input
                placeholder="Max"
                type="number"
                value={filters.viewsMax}
                onChange={(e) => updateFilter('viewsMax', e.target.value)}
              />
            </div>
          </div>

          <Select
            label="Gender"
            value={filters.gender}
            onChange={(e) => updateFilter('gender', e.target.value)}
            placeholder="Any"
            options={[
              { value: 'male', label: 'Male' },
              { value: 'female', label: 'Female' },
              { value: 'non-binary', label: 'Non-binary' },
            ]}
          />

          <Select
            label="Language"
            value={filters.language}
            onChange={(e) => updateFilter('language', e.target.value)}
            placeholder="Any"
            options={[
              { value: 'es', label: 'Spanish' },
              { value: 'en', label: 'English' },
              { value: 'fr', label: 'French' },
              { value: 'pt', label: 'Portuguese' },
              { value: 'de', label: 'German' },
              { value: 'it', label: 'Italian' },
              { value: 'ca', label: 'Catalan' },
            ]}
          />

          <Input
            label="Keyword in Bio"
            placeholder="e.g. vegan, photographer"
            value={filters.bioKeyword}
            onChange={(e) => updateFilter('bioKeyword', e.target.value)}
          />

          {/* Audience Filters Section */}
          <div className="border-t border-gray-200 pt-5">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-400">
              Creator&apos;s Audience Filters
            </h3>

            <div className="space-y-4">
              <Input
                label="Audience Location"
                placeholder="e.g. Spain"
                value={filters.audienceLocation}
                onChange={(e) => updateFilter('audienceLocation', e.target.value)}
              />

              <Select
                label="Audience Gender"
                value={filters.audienceGender}
                onChange={(e) => updateFilter('audienceGender', e.target.value)}
                placeholder="Any"
                options={[
                  { value: 'mostly_male', label: 'Mostly Male (>60%)' },
                  { value: 'mostly_female', label: 'Mostly Female (>60%)' },
                  { value: 'balanced', label: 'Balanced' },
                ]}
              />

              <Select
                label="Audience Language"
                value={filters.audienceLanguage}
                onChange={(e) => updateFilter('audienceLanguage', e.target.value)}
                placeholder="Any"
                options={[
                  { value: 'es', label: 'Spanish' },
                  { value: 'en', label: 'English' },
                  { value: 'fr', label: 'French' },
                  { value: 'pt', label: 'Portuguese' },
                  { value: 'de', label: 'German' },
                ]}
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2 border-t border-gray-200 pt-5">
            <Button onClick={handleSearch} className="w-full">
              <Search className="h-4 w-4" />
              {t.common.search}
            </Button>
            <Button variant="ghost" onClick={resetFilters} className="w-full">
              <RotateCcw className="h-4 w-4" />
              Reset all filters
            </Button>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1">
          {!hasSearched ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-32">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                <Compass className="h-7 w-7" />
              </div>
              <p className="mt-5 text-base font-medium text-gray-500">
                Use the filters to search for creators
              </p>
              <p className="mt-1.5 text-sm text-gray-400">
                Set your criteria and click Search to discover matching influencers
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-32">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-purple-50 text-purple-600">
                <Search className="h-7 w-7" />
              </div>
              <p className="mt-5 text-base font-medium text-gray-500">
                Searching for creators...
              </p>
              <p className="mt-1.5 text-sm text-gray-400">
                Results will appear here once connected to the API
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

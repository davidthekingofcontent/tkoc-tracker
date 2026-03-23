'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  Search,
  DollarSign,
  TrendingUp,
  TrendingDown,
  BarChart3,
  MessageSquare,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Info,
  Users,
  Eye,
  Heart,
  MessageCircle,
  Instagram,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/i18n/context'
import { formatNumber } from '@/lib/utils'
import { getQuickBenchmark, type QuickBenchmark } from '@/lib/market-benchmark-client'
import type { PricingAnalysisResult } from '@/app/api/pricing/analyze/route'

// ============ TYPES ============

interface FormData {
  username: string
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: string
  avgViews: string
  avgLikes: string
  avgComments: string
  engagementRate: string
  format: string
  fee: string
}

const INITIAL_FORM: FormData = {
  username: '',
  platform: 'INSTAGRAM',
  followers: '',
  avgViews: '',
  avgLikes: '',
  avgComments: '',
  engagementRate: '',
  format: 'REEL',
  fee: '',
}

const FORMAT_OPTIONS: Record<string, { value: string; label: string }[]> = {
  INSTAGRAM: [
    { value: 'REEL', label: 'Reel' },
    { value: 'POST', label: 'Post' },
    { value: 'STORY', label: 'Story' },
  ],
  TIKTOK: [
    { value: 'VIDEO', label: 'Video' },
    { value: 'SHORT', label: 'Short' },
  ],
  YOUTUBE: [
    { value: 'VIDEO', label: 'Video' },
    { value: 'SHORT', label: 'Short' },
  ],
}

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform) {
    case 'INSTAGRAM': return <Instagram className="h-4 w-4 text-pink-400" />
    case 'TIKTOK': return <span className="text-xs font-bold text-cyan-400">TT</span>
    case 'YOUTUBE': return <span className="text-xs font-bold text-red-400">YT</span>
    default: return null
  }
}

// ============ VERDICT VISUALS ============

interface VerdictConfig {
  color: string
  bgColor: string
  borderColor: string
  ringColor: string
  textColor: string
  icon: React.ReactNode
  labelEs: string
  labelEn: string
  actionEs: string
  actionEn: string
}

const VERDICT_MAP: Record<string, VerdictConfig> = {
  excellent_deal: {
    color: '#22c55e',
    bgColor: 'bg-green-50 dark:bg-green-900/20',
    borderColor: 'border-green-200 dark:border-green-800',
    ringColor: 'ring-green-400/30',
    textColor: 'text-green-700 dark:text-green-400',
    icon: <CheckCircle2 className="h-8 w-8 text-green-500" />,
    labelEs: 'Excelente Precio',
    labelEn: 'Excellent Deal',
    actionEs: 'Contratar -- buen precio para lo que ofrece',
    actionEn: 'Hire -- great price for the value offered',
  },
  fair_deal: {
    color: '#a3e635',
    bgColor: 'bg-lime-50 dark:bg-lime-900/20',
    borderColor: 'border-lime-200 dark:border-lime-800',
    ringColor: 'ring-lime-400/30',
    textColor: 'text-lime-700 dark:text-lime-400',
    icon: <CheckCircle2 className="h-8 w-8 text-lime-500" />,
    labelEs: 'Precio Justo',
    labelEn: 'Fair Deal',
    actionEs: 'Contratar -- precio alineado con el mercado',
    actionEn: 'Hire -- price aligned with market',
  },
  slightly_above: {
    color: '#f59e0b',
    bgColor: 'bg-amber-50 dark:bg-amber-900/20',
    borderColor: 'border-amber-200 dark:border-amber-800',
    ringColor: 'ring-amber-400/30',
    textColor: 'text-amber-700 dark:text-amber-400',
    icon: <AlertTriangle className="h-8 w-8 text-amber-500" />,
    labelEs: 'Ligeramente Caro',
    labelEn: 'Slightly Above Market',
    actionEs: 'Negociar a la baja',
    actionEn: 'Negotiate down',
  },
  overpriced: {
    color: '#ef4444',
    bgColor: 'bg-red-50 dark:bg-red-900/20',
    borderColor: 'border-red-200 dark:border-red-800',
    ringColor: 'ring-red-400/30',
    textColor: 'text-red-700 dark:text-red-400',
    icon: <XCircle className="h-8 w-8 text-red-500" />,
    labelEs: 'Sobreprecio',
    labelEn: 'Overpriced',
    actionEs: 'No compensa -- buscar alternativas',
    actionEn: 'Not worth it -- look for alternatives',
  },
  way_overpriced: {
    color: '#dc2626',
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    borderColor: 'border-red-300 dark:border-red-700',
    ringColor: 'ring-red-500/30',
    textColor: 'text-red-800 dark:text-red-300',
    icon: <XCircle className="h-8 w-8 text-red-600" />,
    labelEs: 'Muy Sobrevalorado',
    labelEn: 'Way Overpriced',
    actionEs: 'No contratar -- precio fuera de mercado',
    actionEn: 'Do not hire -- price is off the charts',
  },
}

// ============ MARKET RANGE BAR ============

function MarketRangeBar({
  min, target, max, ceiling, fee, locale,
}: {
  min: number; target: number; max: number; ceiling: number; fee: number; locale: string
}) {
  const totalRange = ceiling * 1.15
  const pct = (v: number) => Math.min(Math.max((v / totalRange) * 100, 0), 100)

  return (
    <div className="mt-4">
      <div className="relative h-10 rounded-lg bg-gray-100 dark:bg-gray-700 overflow-hidden">
        {/* Green zone: min to target */}
        <div
          className="absolute top-0 h-full bg-green-200/60 dark:bg-green-800/40"
          style={{ left: `${pct(min)}%`, width: `${pct(target) - pct(min)}%` }}
        />
        {/* Yellow zone: target to max */}
        <div
          className="absolute top-0 h-full bg-amber-200/60 dark:bg-amber-800/40"
          style={{ left: `${pct(target)}%`, width: `${pct(max) - pct(target)}%` }}
        />
        {/* Red zone: max to ceiling */}
        <div
          className="absolute top-0 h-full bg-red-200/60 dark:bg-red-800/40"
          style={{ left: `${pct(max)}%`, width: `${pct(ceiling) - pct(max)}%` }}
        />
        {/* Fee marker */}
        <div
          className="absolute top-0 h-full w-0.5 bg-purple-600 dark:bg-purple-400 z-10"
          style={{ left: `${pct(fee)}%` }}
        >
          <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-purple-600 px-2 py-0.5 text-[10px] font-bold text-white shadow">
            {locale === 'es' ? 'Fee pedido' : 'Asked fee'}: {'\u20AC'}{fee.toLocaleString()}
          </div>
          <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 h-3 w-3 rounded-full bg-purple-600 dark:bg-purple-400 border-2 border-white dark:border-gray-800 shadow" />
        </div>
      </div>
      {/* Labels */}
      <div className="relative mt-1 h-5 text-[10px] font-medium text-gray-400">
        <span className="absolute" style={{ left: `${pct(min)}%`, transform: 'translateX(-50%)' }}>
          Min {'\u20AC'}{min.toLocaleString()}
        </span>
        <span className="absolute" style={{ left: `${pct(target)}%`, transform: 'translateX(-50%)' }}>
          Target {'\u20AC'}{target.toLocaleString()}
        </span>
        <span className="absolute" style={{ left: `${pct(max)}%`, transform: 'translateX(-50%)' }}>
          Max {'\u20AC'}{max.toLocaleString()}
        </span>
        <span className="absolute" style={{ left: `${pct(ceiling)}%`, transform: 'translateX(-50%)' }}>
          Ceiling {'\u20AC'}{ceiling.toLocaleString()}
        </span>
      </div>
    </div>
  )
}

// ============ MAIN PAGE ============

export default function PricingPage() {
  const { t, locale } = useI18n()
  const isEs = locale === 'es'

  const [form, setForm] = useState<FormData>(INITIAL_FORM)
  const [loading, setLoading] = useState(false)
  const [lookingUp, setLookingUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PricingAnalysisResult | null>(null)
  const [quickBenchmark, setQuickBenchmark] = useState<QuickBenchmark | null>(null)

  const updateField = (key: keyof FormData, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  // Auto-calculate engagement rate
  useEffect(() => {
    const followers = parseFloat(form.followers)
    const likes = parseFloat(form.avgLikes)
    if (followers > 0 && likes > 0 && !form.engagementRate) {
      const er = ((likes / followers) * 100).toFixed(2)
      setForm(prev => ({ ...prev, engagementRate: er }))
    }
  }, [form.followers, form.avgLikes, form.engagementRate])

  // Quick benchmark preview when followers + platform change
  useEffect(() => {
    const followers = parseInt(form.followers, 10)
    if (followers > 0) {
      const bm = getQuickBenchmark(form.platform, followers, form.format || undefined)
      setQuickBenchmark(bm)
    } else {
      setQuickBenchmark(null)
    }
  }, [form.followers, form.platform, form.format])

  // Update format options when platform changes
  useEffect(() => {
    const formats = FORMAT_OPTIONS[form.platform]
    if (formats && !formats.find(f => f.value === form.format)) {
      setForm(prev => ({ ...prev, format: formats[0].value }))
    }
  }, [form.platform, form.format])

  // Search by username
  const handleLookup = useCallback(async () => {
    if (!form.username.trim()) return
    setLookingUp(true)
    setError(null)
    try {
      const res = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username.replace('@', ''),
          platform: form.platform,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const inf = data.influencer || data
        if (inf) {
          setForm(prev => ({
            ...prev,
            followers: String(inf.followers || ''),
            avgViews: String(inf.avgViews || ''),
            avgLikes: String(inf.avgLikes || ''),
            avgComments: String(inf.avgComments || ''),
            engagementRate: String(inf.engagementRate || ''),
          }))
        }
      } else {
        setError(isEs ? 'No se encontro el usuario en la base de datos' : 'User not found in database')
      }
    } catch {
      setError(isEs ? 'Error de red' : 'Network error')
    } finally {
      setLookingUp(false)
    }
  }, [form.username, form.platform, isEs])

  // Analyze pricing
  const handleAnalyze = useCallback(async () => {
    const fee = parseFloat(form.fee)
    const followers = parseInt(form.followers, 10)
    const avgViews = parseInt(form.avgViews, 10)

    if (!fee || fee <= 0) {
      setError(isEs ? 'Introduce el fee que pide el creador' : 'Enter the fee the creator is asking')
      return
    }
    if (!followers || followers <= 0) {
      setError(isEs ? 'Introduce el numero de seguidores' : 'Enter the follower count')
      return
    }
    if (!avgViews || avgViews <= 0) {
      setError(isEs ? 'Introduce las views medias' : 'Enter the average views')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/pricing/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username || undefined,
          platform: form.platform,
          followers,
          avgViews,
          avgLikes: parseInt(form.avgLikes, 10) || 0,
          avgComments: parseInt(form.avgComments, 10) || 0,
          engagementRate: parseFloat(form.engagementRate) || 0,
          fee,
          format: form.format || undefined,
        }),
      })

      if (res.ok) {
        const data = await res.json() as PricingAnalysisResult
        setResult(data)
      } else {
        const errData = await res.json().catch(() => null)
        setError(errData?.error || (isEs ? 'Error al analizar' : 'Analysis error'))
      }
    } catch {
      setError(isEs ? 'Error de red' : 'Network error')
    } finally {
      setLoading(false)
    }
  }, [form, isEs])

  const verdictConfig = result ? VERDICT_MAP[result.deal.verdict] || VERDICT_MAP.fair_deal : null

  return (
    <div className="space-y-8 pb-12">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {isEs ? 'Calculadora de Precios' : 'Pricing Calculator'}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {isEs
            ? 'Analiza si el precio de un influencer es justo comparado con el mercado'
            : 'Analyze if an influencer\'s price is fair compared to market benchmarks'}
        </p>
      </div>

      {/* INPUT SECTION */}
      <Card className="dark:bg-gray-800 dark:border-gray-700">
        <div className="space-y-6">
          {/* Username lookup row */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Input
                label={isEs ? 'Username (opcional)' : 'Username (optional)'}
                placeholder="@username"
                value={form.username}
                onChange={e => updateField('username', e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLookup()}
                className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
              />
            </div>
            <Button
              variant="secondary"
              size="md"
              onClick={handleLookup}
              disabled={lookingUp || !form.username.trim()}
            >
              {lookingUp ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {isEs ? 'Buscar' : 'Lookup'}
            </Button>
          </div>

          {/* Platform + Format row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={isEs ? 'Plataforma' : 'Platform'}
              value={form.platform}
              onChange={e => updateField('platform', e.target.value)}
              options={[
                { value: 'INSTAGRAM', label: 'Instagram' },
                { value: 'TIKTOK', label: 'TikTok' },
                { value: 'YOUTUBE', label: 'YouTube' },
              ]}
              className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
            <Select
              label={isEs ? 'Formato' : 'Format'}
              value={form.format}
              onChange={e => updateField('format', e.target.value)}
              options={FORMAT_OPTIONS[form.platform] || FORMAT_OPTIONS.INSTAGRAM}
              className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Input
              label={isEs ? 'Seguidores' : 'Followers'}
              placeholder="100000"
              type="number"
              value={form.followers}
              onChange={e => updateField('followers', e.target.value)}
              icon={<Users className="h-4 w-4" />}
              className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
            <Input
              label={isEs ? 'Views Medias' : 'Average Views'}
              placeholder="25000"
              type="number"
              value={form.avgViews}
              onChange={e => updateField('avgViews', e.target.value)}
              icon={<Eye className="h-4 w-4" />}
              className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
            <Input
              label={isEs ? 'Likes Medios (opc.)' : 'Avg Likes (opt.)'}
              placeholder="5000"
              type="number"
              value={form.avgLikes}
              onChange={e => updateField('avgLikes', e.target.value)}
              icon={<Heart className="h-4 w-4" />}
              className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
            <Input
              label={isEs ? 'Comentarios (opc.)' : 'Avg Comments (opt.)'}
              placeholder="200"
              type="number"
              value={form.avgComments}
              onChange={e => updateField('avgComments', e.target.value)}
              icon={<MessageCircle className="h-4 w-4" />}
              className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
          </div>

          {/* Engagement + quick benchmark hint */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={isEs ? 'Engagement Rate % (opc.)' : 'Engagement Rate % (opt.)'}
              placeholder="3.5"
              type="number"
              step="0.01"
              value={form.engagementRate}
              onChange={e => updateField('engagementRate', e.target.value)}
              className="dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
            {quickBenchmark && (
              <div className="flex items-end">
                <div className="rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 px-4 py-2.5 text-sm w-full">
                  <span className="text-purple-600 dark:text-purple-400 font-medium">
                    {isEs ? 'Referencia rapida' : 'Quick benchmark'}:
                  </span>{' '}
                  <span className="text-gray-700 dark:text-gray-300">
                    {'\u20AC'}{quickBenchmark.feeMin.toLocaleString()} - {'\u20AC'}{quickBenchmark.feeMax.toLocaleString()}
                  </span>
                  <span className="text-gray-400 ml-2 text-xs">({quickBenchmark.tier})</span>
                </div>
              </div>
            )}
          </div>

          {/* FEE INPUT - PROMINENT */}
          <div className="rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-purple-50/50 dark:bg-purple-900/10 p-5">
            <label className="block text-sm font-semibold text-purple-700 dark:text-purple-400 mb-2">
              {isEs ? 'Fee que pide el creador' : 'Fee the creator is asking'} ({'\u20AC'})
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-purple-500">
                <DollarSign className="h-6 w-6" />
              </div>
              <input
                type="number"
                placeholder={isEs ? 'Ej: 500' : 'e.g. 500'}
                value={form.fee}
                onChange={e => updateField('fee', e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAnalyze()}
                className="block w-full rounded-xl border-2 border-purple-300 dark:border-purple-600 bg-white dark:bg-gray-900 pl-12 pr-4 py-4 text-2xl font-bold text-gray-900 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 transition-colors"
              />
            </div>
            {quickBenchmark && form.fee && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {isEs ? 'Rango de mercado para este tier' : 'Market range for this tier'}:{' '}
                <span className="font-medium">{'\u20AC'}{quickBenchmark.feeMin.toLocaleString()} - {'\u20AC'}{quickBenchmark.feeCeiling.toLocaleString()}</span>
              </p>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              <XCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* ANALYZE BUTTON */}
          <Button
            variant="primary"
            size="lg"
            onClick={handleAnalyze}
            disabled={loading || !form.fee || !form.followers || !form.avgViews}
            className="w-full text-lg py-4"
          >
            {loading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                {isEs ? 'Analizando...' : 'Analyzing...'}
              </>
            ) : (
              <>
                <Zap className="h-5 w-5" />
                {isEs ? 'Analizar Precio' : 'Analyze Price'}
              </>
            )}
          </Button>
        </div>
      </Card>

      {/* LOADING STATE */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-12 w-12 animate-spin text-purple-500 mb-4" />
          <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
            {isEs ? 'Calculando precio optimo...' : 'Calculating optimal price...'}
          </p>
        </div>
      )}

      {/* ============ RESULTS ============ */}
      {result && verdictConfig && !loading && (
        <div className="space-y-6">

          {/* 1. TRAFFIC LIGHT VERDICT */}
          <Card className={`${verdictConfig.bgColor} ${verdictConfig.borderColor} border-2 dark:border-2`}>
            <div className="flex flex-col items-center text-center py-4">
              {/* Big colored circle */}
              <div
                className={`h-24 w-24 rounded-full flex items-center justify-center ring-4 ${verdictConfig.ringColor} mb-4`}
                style={{ backgroundColor: verdictConfig.color + '20' }}
              >
                <div
                  className="h-16 w-16 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: verdictConfig.color }}
                >
                  <span className="text-white text-3xl font-black">
                    {result.deal.verdict === 'excellent_deal' && '\u2705'}
                    {result.deal.verdict === 'fair_deal' && '\uD83D\uDFE2'}
                    {result.deal.verdict === 'slightly_above' && '\uD83D\uDFE1'}
                    {result.deal.verdict === 'overpriced' && '\uD83D\uDFE0'}
                    {result.deal.verdict === 'way_overpriced' && '\u26D4'}
                  </span>
                </div>
              </div>
              {/* Verdict text */}
              <h2 className={`text-2xl font-bold ${verdictConfig.textColor}`}>
                {isEs ? verdictConfig.labelEs : verdictConfig.labelEn}
              </h2>
              <p className="mt-2 text-base text-gray-600 dark:text-gray-300 max-w-lg">
                {result.deal.narrative}
              </p>
              {/* Creator info badge */}
              <div className="mt-4 flex items-center gap-2">
                <PlatformIcon platform={result.creator.platform} />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  @{result.creator.username}
                </span>
                <Badge variant="default">{result.creator.tier}</Badge>
                <Badge variant="default">{formatNumber(result.creator.followers)} {isEs ? 'seguidores' : 'followers'}</Badge>
                {result.creator.fromDatabase && (
                  <Badge variant="active">{isEs ? 'De BD' : 'From DB'}</Badge>
                )}
              </div>
            </div>
          </Card>

          {/* 2. MARKET RANGE BAR */}
          <Card className="dark:bg-gray-800 dark:border-gray-700">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
              {isEs ? 'Rango de Mercado' : 'Market Range'}
            </h3>
            <MarketRangeBar
              min={result.deal.recommendedFeeMin}
              target={Math.round((result.deal.recommendedFeeMin + result.deal.recommendedFeeMax) / 2)}
              max={result.deal.recommendedFeeMax}
              ceiling={Math.round(result.deal.recommendedFeeMax * 1.5)}
              fee={result.deal.askedFee}
              locale={locale}
            />
          </Card>

          {/* 3. KEY METRICS - 4 cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* CPM Real */}
            <Card className="dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center gap-2 mb-1">
                <BarChart3 className="h-4 w-4 text-purple-500" />
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">CPM Real</span>
              </div>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {'\u20AC'}{(result.deal.cpmReal || 0).toFixed(0)}
              </p>
              <p className="text-xs text-gray-400">
                {isEs ? 'Coste por 1000 views' : 'Cost per 1000 views'}
              </p>
            </Card>

            {/* CPM Benchmark */}
            <Card className="dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="h-4 w-4 text-blue-500" />
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">CPM Benchmark</span>
              </div>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {result.deal.cpmBenchmark !== null ? `\u20AC${result.deal.cpmBenchmark}` : 'N/A'}
              </p>
              <p className="text-xs text-gray-400">
                {isEs ? 'CPM objetivo del mercado' : 'Market target CPM'}
              </p>
            </Card>

            {/* Savings / Overcost */}
            <Card className="dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center gap-2 mb-1">
                {result.deal.savingsOrOvercost >= 0 ? (
                  <TrendingDown className="h-4 w-4 text-green-500" />
                ) : (
                  <TrendingUp className="h-4 w-4 text-red-500" />
                )}
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  {isEs ? 'Ahorro / Sobrecoste' : 'Savings / Overcost'}
                </span>
              </div>
              <p className={`text-2xl font-bold ${result.deal.savingsOrOvercost >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {result.deal.savingsOrOvercost >= 0 ? '+' : ''}{'\u20AC'}{result.deal.savingsOrOvercost.toLocaleString()}
              </p>
              <p className="text-xs text-gray-400">
                {result.deal.savingsPercent >= 0
                  ? (isEs ? `${result.deal.savingsPercent}% menos que mercado` : `${result.deal.savingsPercent}% below market`)
                  : (isEs ? `${Math.abs(result.deal.savingsPercent)}% sobre mercado` : `${Math.abs(result.deal.savingsPercent)}% above market`)}
              </p>
            </Card>

            {/* Fee vs Market */}
            <Card className="dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center gap-2 mb-1">
                <DollarSign className="h-4 w-4 text-amber-500" />
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Fee vs Market
                </span>
              </div>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {'\u20AC'}{result.deal.askedFee.toLocaleString()}
              </p>
              <p className="text-xs text-gray-400">
                {isEs ? 'Rango' : 'Range'}: {'\u20AC'}{result.deal.recommendedFeeMin.toLocaleString()} - {'\u20AC'}{result.deal.recommendedFeeMax.toLocaleString()}
              </p>
            </Card>
          </div>

          {/* 4. THREE SCENARIOS */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
              {isEs ? 'Escenarios de Precio' : 'Price Scenarios'}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Conservative */}
              <Card className="dark:bg-gray-800 dark:border-gray-700 border-green-200 dark:border-green-800/50">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {isEs ? 'Conservador (p25)' : 'Conservative (p25)'}
                  </h4>
                </div>
                <p className="text-xl font-bold text-green-600 dark:text-green-400 mb-1">
                  {'\u20AC'}{result.scenarios.conservative.fee.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  CPM: {'\u20AC'}{result.scenarios.conservative.cpm.toFixed(1)}
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  {result.scenarios.conservative.verdict}
                </p>
              </Card>

              {/* Realistic */}
              <Card className="dark:bg-gray-800 dark:border-gray-700 border-blue-200 dark:border-blue-800/50 ring-1 ring-blue-200 dark:ring-blue-800/50">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {isEs ? 'Realista (p50)' : 'Realistic (p50)'}
                  </h4>
                  <Badge variant="default" className="text-[10px]">{isEs ? 'Recomendado' : 'Recommended'}</Badge>
                </div>
                <p className="text-xl font-bold text-blue-600 dark:text-blue-400 mb-1">
                  {'\u20AC'}{result.scenarios.realistic.fee.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  CPM: {'\u20AC'}{result.scenarios.realistic.cpm.toFixed(1)}
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  {result.scenarios.realistic.verdict}
                </p>
              </Card>

              {/* Optimistic */}
              <Card className="dark:bg-gray-800 dark:border-gray-700 border-amber-200 dark:border-amber-800/50">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 rounded-full bg-amber-500" />
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {isEs ? 'Optimista (p75)' : 'Optimistic (p75)'}
                  </h4>
                </div>
                <p className="text-xl font-bold text-amber-600 dark:text-amber-400 mb-1">
                  {'\u20AC'}{result.scenarios.optimistic.fee.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  CPM: {'\u20AC'}{result.scenarios.optimistic.cpm.toFixed(1)}
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  {result.scenarios.optimistic.verdict}
                </p>
              </Card>
            </div>
          </div>

          {/* 5. RECOMMENDATION BOX */}
          <Card className="dark:bg-gray-800 dark:border-gray-700">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
              {isEs ? 'Recomendacion' : 'Recommendation'}
            </h3>
            {/* Narrative */}
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed mb-4">
              {result.deal.narrative}
            </p>
            {/* Negotiation tip */}
            <div className="flex items-start gap-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4 mb-4">
              <MessageSquare className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-1 uppercase">
                  {isEs ? 'Tip de negociacion' : 'Negotiation Tip'}
                </p>
                <p className="text-sm text-blue-800 dark:text-blue-300">
                  {result.deal.negotiationTip}
                </p>
              </div>
            </div>
            {/* Tier warnings */}
            {result.tierWarnings.length > 0 && (
              <div className="space-y-2">
                {result.tierWarnings.map((warning, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* 6. DECISION SUMMARY */}
          <Card className={`${verdictConfig.bgColor} ${verdictConfig.borderColor} border-2 dark:border-2`}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
              {isEs ? 'Decision Final' : 'Final Decision'}
            </h3>
            <div className="flex items-center gap-3">
              {verdictConfig.icon}
              <div>
                <p className={`text-lg font-bold ${verdictConfig.textColor}`}>
                  {isEs ? verdictConfig.actionEs : verdictConfig.actionEn}
                </p>
                {result.deal.verdict === 'slightly_above' && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {isEs
                      ? `Negociar a la baja -- pedir \u20AC${result.deal.recommendedFeeMin.toLocaleString()}-\u20AC${result.deal.recommendedFeeMax.toLocaleString()}`
                      : `Negotiate down -- ask for \u20AC${result.deal.recommendedFeeMin.toLocaleString()}-\u20AC${result.deal.recommendedFeeMax.toLocaleString()}`}
                  </p>
                )}
                {(result.deal.verdict === 'overpriced' || result.deal.verdict === 'way_overpriced') && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {isEs
                      ? 'Solo compensa si incluye derechos de uso / stories adicionales / paid amplification'
                      : 'Only worth it if it includes usage rights / additional stories / paid amplification'}
                  </p>
                )}
              </div>
            </div>
          </Card>

        </div>
      )}
    </div>
  )
}

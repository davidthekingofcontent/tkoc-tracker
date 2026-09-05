'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Target,
  Rocket,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Sparkles,
  Globe,
  Gauge,
  X,
} from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { formatEur, formatNumber, formatPercent, type EurLocale } from '@/lib/utils'

/**
 * Campaign Wizard — Guided step-by-step campaign creation.
 * "Guíame" mode: walks user through Planificar → Elegir → Pagar → Ejecutar → Aprender
 *
 * This wizard creates the campaign with minimal friction, then redirects to the campaign page.
 * Decision 1B (David, 2026-09-05): the objective AND at least one numeric target are mandatory.
 */

interface CampaignWizardProps {
  isOpen: boolean
  onClose: () => void
}

const OBJECTIVES = [
  { value: 'awareness', icon: '📣', label: 'Awareness', labelEs: 'Notoriedad', desc: 'Brand visibility and reach', descEs: 'Visibilidad y alcance de marca' },
  { value: 'engagement', icon: '💬', label: 'Engagement', labelEs: 'Engagement', desc: 'Interactions and community', descEs: 'Interacciones y comunidad' },
  { value: 'traffic', icon: '🔗', label: 'Traffic', labelEs: 'Tráfico', desc: 'Drive visits to site/landing', descEs: 'Llevar visitas a web/landing' },
  { value: 'conversion', icon: '🛒', label: 'Conversion', labelEs: 'Conversión', desc: 'Sales and signups', descEs: 'Ventas y registros' },
  { value: 'content', icon: '🎬', label: 'Content', labelEs: 'Contenido', desc: 'Reusable branded content', descEs: 'Contenido reutilizable de marca' },
]

/** Numeric targets a campaign can commit to. `recommendedFor` marks which ones each objective usually needs. */
type TargetKey = 'targetViews' | 'targetReach' | 'targetEngagement' | 'targetER' | 'targetCpmMax'

const TARGET_FIELDS: {
  key: TargetKey
  labelEs: string
  labelEn: string
  unit: string
  step: number
  placeholder: string
  recommendedFor: string[]
}[] = [
  { key: 'targetViews', labelEs: 'Vistas', labelEn: 'Views', unit: '', step: 1, placeholder: '500000', recommendedFor: ['awareness', 'traffic', 'content'] },
  { key: 'targetReach', labelEs: 'Alcance', labelEn: 'Reach', unit: '', step: 1, placeholder: '300000', recommendedFor: ['awareness', 'conversion'] },
  { key: 'targetEngagement', labelEs: 'Interacciones', labelEn: 'Engagements', unit: '', step: 1, placeholder: '15000', recommendedFor: ['engagement'] },
  { key: 'targetER', labelEs: 'ER objetivo', labelEn: 'Target ER', unit: '%', step: 0.1, placeholder: '3.5', recommendedFor: ['engagement'] },
  { key: 'targetCpmMax', labelEs: 'CPM máximo', labelEn: 'Max CPM', unit: '€', step: 0.5, placeholder: '12', recommendedFor: ['awareness', 'traffic', 'conversion', 'content'] },
]

/** Helper text shown on the targets step, depending on the chosen objective. */
const TARGET_HINTS: Record<string, { es: string; en: string }> = {
  awareness: {
    es: 'Para notoriedad, lo habitual es fijar vistas y/o alcance. El CPM máximo marca cuánto estás dispuesto a pagar por cada 1.000 vistas.',
    en: 'For awareness, set views and/or reach. The max CPM caps what you are willing to pay per 1,000 views.',
  },
  engagement: {
    es: 'Para engagement, fija el número de interacciones (likes, comentarios, shares, saves) y/o el ER (%) que esperas.',
    en: 'For engagement, set the number of interactions (likes, comments, shares, saves) and/or the ER (%) you expect.',
  },
  traffic: {
    es: 'Los clics se registran por creador con enlaces trackeados. Aquí fija las vistas que necesitas para generarlos y un CPM máximo de referencia.',
    en: 'Clicks are tracked per creator with tracked links. Here, set the views you need to generate them and a reference max CPM.',
  },
  conversion: {
    es: 'Las ventas y los códigos los aporta el cliente al cerrar la campaña. Aquí fija el alcance que necesitas y un CPM máximo de referencia.',
    en: 'Sales and promo codes are reported by the client at campaign close. Here, set the reach you need and a reference max CPM.',
  },
  content: {
    es: 'Para contenido, los entregables se fijan por creador al elegirlos. Aquí fija un mínimo de vistas o un CPM máximo para valorar la eficiencia.',
    en: 'For content, deliverables are set per creator when you pick them. Here, set a minimum of views or a max CPM to judge efficiency.',
  },
}

const PLATFORMS = [
  { value: 'INSTAGRAM', label: 'Instagram', icon: '📸' },
  { value: 'TIKTOK', label: 'TikTok', icon: '🎵' },
  { value: 'YOUTUBE', label: 'YouTube', icon: '▶️' },
]

const CAMPAIGN_TYPES = [
  { value: 'SOCIAL_LISTENING', label: 'Social Listening', labelEs: 'Social Listening', desc: 'Track hashtags and mentions', descEs: 'Rastrear hashtags y menciones' },
  { value: 'INFLUENCER_TRACKING', label: 'Influencer Tracking', labelEs: 'Tracking de Influencers', desc: 'Track specific creators', descEs: 'Rastrear creadores específicos' },
  { value: 'UGC', label: 'UGC Campaign', labelEs: 'Campaña UGC', desc: 'User-generated content', descEs: 'Contenido generado por usuarios' },
]

const STEPS = [
  { key: 'objective', icon: Target, label: 'Objective', labelEs: 'Objetivo' },
  { key: 'targets', icon: Gauge, label: 'Targets', labelEs: 'Objetivos numéricos' },
  { key: 'basics', icon: Sparkles, label: 'Basics', labelEs: 'Básicos' },
  { key: 'tracking', icon: Globe, label: 'Tracking', labelEs: 'Tracking' },
  { key: 'confirm', icon: Rocket, label: 'Launch', labelEs: 'Lanzar' },
]
const LAST_STEP = STEPS.length - 1

/** "500000" → 500000; empty, NaN or ≤ 0 → null (an unfilled datum is not stored). */
function toPositiveInt(value: string): number | null {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function toPositiveFloat(value: string): number | null {
  const n = parseFloat(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Formats a target for the confirm step with the shared helpers, so it reads exactly like the Objectives card. */
function formatTarget(field: (typeof TARGET_FIELDS)[number], value: string, locale: EurLocale): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (field.unit === '€') return formatEur(n, { locale, maxFractionDigits: 2 })
  if (field.unit === '%') return formatPercent(n, { locale, digits: 2 })
  return formatNumber(n, { locale })
}

export function CampaignWizard({ isOpen, onClose }: CampaignWizardProps) {
  const router = useRouter()
  const { locale } = useI18n()
  const [step, setStep] = useState(0)
  const [isCreating, setIsCreating] = useState(false)
  const es = locale === 'es'

  const [form, setForm] = useState({
    name: '',
    objective: '',
    type: 'SOCIAL_LISTENING',
    platforms: [] as string[],
    country: '',
    budget: '',
    paymentType: 'PAID',
    targetHashtags: '',
    targetAccounts: '',
    startDate: new Date().toISOString().split('T')[0],
    endDate: '',
    // Numeric targets (kept as strings while typing; parsed on submit)
    targetViews: '',
    targetReach: '',
    targetEngagement: '',
    targetER: '',
    targetCpmMax: '',
  })

  if (!isOpen) return null

  function togglePlatform(p: string) {
    setForm(prev => ({
      ...prev,
      platforms: prev.platforms.includes(p)
        ? prev.platforms.filter(x => x !== p)
        : [...prev.platforms, p],
    }))
  }

  // Decision 1B: at least one numeric target is required alongside the objective.
  const hasAnyTarget = TARGET_FIELDS.some(f => (f.step >= 1 ? toPositiveInt(form[f.key]) : toPositiveFloat(form[f.key])) !== null)
  const filledTargets = TARGET_FIELDS.filter(f => (f.step >= 1 ? toPositiveInt(form[f.key]) : toPositiveFloat(form[f.key])) !== null)

  async function handleCreate() {
    setIsCreating(true)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          objective: form.objective,
          type: form.type,
          platforms: form.platforms.length > 0 ? form.platforms : ['INSTAGRAM'],
          country: form.country || null,
          budget: form.budget ? parseFloat(form.budget) : null,
          paymentType: form.paymentType,
          targetHashtags: form.targetHashtags ? form.targetHashtags.split(',').map(h => h.trim().replace(/^#/, '')) : [],
          targetAccounts: form.targetAccounts ? form.targetAccounts.split(',').map(a => a.trim().replace(/^@/, '')) : [],
          startDate: form.startDate || null,
          endDate: form.endDate || null,
          // Numeric targets — null when not filled in
          targetViews: toPositiveInt(form.targetViews),
          targetReach: toPositiveInt(form.targetReach),
          targetEngagement: toPositiveInt(form.targetEngagement),
          targetER: toPositiveFloat(form.targetER),
          targetCpmMax: toPositiveFloat(form.targetCpmMax),
        }),
      })

      if (res.ok) {
        const data = await res.json()
        onClose()
        router.push(`/campaigns/${data.campaign.id}`)
      }
    } catch {
      // silent
    } finally {
      setIsCreating(false)
    }
  }

  const canNext = () => {
    if (step === 0) return !!form.objective
    if (step === 1) return hasAnyTarget
    if (step === 2) return !!form.name && form.platforms.length > 0
    return true
  }

  const canLaunch = !!form.name && !!form.objective && hasAnyTarget
  const selectedObjective = OBJECTIVES.find(o => o.value === form.objective)
  const targetHint = TARGET_HINTS[form.objective]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl mx-4 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl overflow-hidden">
        {/* Close button */}
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 z-10">
          <X className="h-5 w-5" />
        </button>

        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-blue-600 px-8 py-6 text-white">
          <div className="flex items-center gap-3">
            <Sparkles className="h-6 w-6" />
            <div>
              <h2 className="text-lg font-bold">{es ? 'Asistente de Campaña' : 'Campaign Wizard'}</h2>
              <p className="text-sm text-white/70">{es ? 'Te guiamos paso a paso' : 'We guide you step by step'}</p>
            </div>
          </div>

          {/* Steps */}
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            {STEPS.map((s, i) => (
              <div key={s.key} className="flex items-center gap-1">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  i === step ? 'bg-white text-purple-600' :
                  i < step ? 'bg-white/30 text-white' :
                  'bg-white/10 text-white/50'
                }`}>
                  {i < step ? '✓' : i + 1}
                </div>
                <span className={`hidden sm:inline text-xs font-medium ${i === step ? 'text-white' : 'text-white/50'}`}>
                  {es ? s.labelEs : s.label}
                </span>
                {i < LAST_STEP && <div className={`w-4 h-0.5 ${i < step ? 'bg-white/40' : 'bg-white/10'}`} />}
              </div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-8 min-h-[300px]">
          {/* Step 0: Objective */}
          {step === 0 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{es ? '¿Qué quieres conseguir?' : 'What do you want to achieve?'}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {OBJECTIVES.map(obj => (
                  <button
                    key={obj.value}
                    onClick={() => setForm(prev => ({ ...prev, objective: obj.value }))}
                    className={`rounded-xl border-2 p-4 text-left transition-all ${
                      form.objective === obj.value
                        ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-purple-300'
                    }`}
                  >
                    <span className="text-2xl">{obj.icon}</span>
                    <p className="mt-1 text-sm font-bold text-gray-900 dark:text-white">{es ? obj.labelEs : obj.label}</p>
                    <p className="text-xs text-gray-500">{es ? obj.descEs : obj.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 1: Numeric targets (mandatory: at least one) */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">{es ? '¿Qué cifras quieres alcanzar?' : 'What numbers do you want to hit?'}</h3>
                <p className="mt-1 text-sm text-gray-500">
                  {es
                    ? 'Rellena al menos un objetivo numérico. Se congelan al arrancar la campaña y cualquier cambio posterior queda registrado.'
                    : 'Fill in at least one numeric target. They freeze when the campaign starts and any later change is logged.'}
                </p>
              </div>

              {targetHint && selectedObjective && (
                <div className="rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 px-4 py-3 text-sm text-purple-700 dark:text-purple-300">
                  <span className="mr-1">{selectedObjective.icon}</span>
                  <span className="font-semibold">{es ? selectedObjective.labelEs : selectedObjective.label}:</span>{' '}
                  {es ? targetHint.es : targetHint.en}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {TARGET_FIELDS.map(f => {
                  const recommended = f.recommendedFor.includes(form.objective)
                  return (
                    <div key={f.key}>
                      <label className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase mb-1">
                        {es ? f.labelEs : f.labelEn}{f.unit ? ` (${f.unit})` : ''}
                        {recommended && (
                          <span className="rounded-full bg-purple-100 dark:bg-purple-900/40 px-2 py-0.5 text-[10px] font-semibold normal-case text-purple-700 dark:text-purple-300">
                            {es ? 'Recomendado' : 'Recommended'}
                          </span>
                        )}
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={f.step}
                        inputMode="decimal"
                        value={form[f.key]}
                        onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className={`w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none ${
                          recommended ? 'border-purple-300 dark:border-purple-700' : 'border-gray-300 dark:border-gray-600'
                        }`}
                      />
                    </div>
                  )
                })}
              </div>

              {!hasAnyTarget && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {es ? 'Necesitas al menos un objetivo numérico para continuar.' : 'You need at least one numeric target to continue.'}
                </p>
              )}
            </div>
          )}

          {/* Step 2: Basics */}
          {step === 2 && (
            <div className="space-y-5">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{es ? 'Lo esencial' : 'The essentials'}</h3>

              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Nombre de la campaña' : 'Campaign name'}</label>
                <input type="text" value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder={es ? 'Ej: Lanzamiento Primavera 2026' : 'E.g.: Spring Launch 2026'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-3 text-sm text-gray-900 dark:text-white focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-2">{es ? 'Plataformas' : 'Platforms'}</label>
                <div className="flex gap-3">
                  {PLATFORMS.map(p => (
                    <button key={p.value} onClick={() => togglePlatform(p.value)}
                      className={`flex items-center gap-2 rounded-xl border-2 px-4 py-3 text-sm font-medium transition-all ${
                        form.platforms.includes(p.value)
                          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300'
                          : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'
                      }`}>
                      <span>{p.icon}</span> {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'País / Mercado' : 'Country / Market'}</label>
                  <input type="text" value={form.country} onChange={e => setForm(prev => ({ ...prev, country: e.target.value }))}
                    placeholder="ES" className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Presupuesto (€)' : 'Budget (€)'}</label>
                  <input type="number" value={form.budget} onChange={e => setForm(prev => ({ ...prev, budget: e.target.value }))}
                    placeholder="5000" className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Tipo de campaña' : 'Campaign type'}</label>
                  <select value={form.type} onChange={e => setForm(prev => ({ ...prev, type: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none">
                    {CAMPAIGN_TYPES.map(ct => (
                      <option key={ct.value} value={ct.value}>{es ? ct.labelEs : ct.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Tipo de pago' : 'Payment type'}</label>
                  <select value={form.paymentType} onChange={e => setForm(prev => ({ ...prev, paymentType: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none">
                    <option value="PAID">{es ? 'Pago' : 'Paid'}</option>
                    <option value="GIFTED">{es ? 'Gifting' : 'Gifted'}</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Tracking */}
          {step === 3 && (
            <div className="space-y-5">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{es ? '¿Qué rastrear?' : 'What to track?'}</h3>
              <p className="text-sm text-gray-500">{es ? 'Define los hashtags y cuentas que quieres monitorizar. Puedes añadir más después.' : 'Define hashtags and accounts to monitor. You can add more later.'}</p>

              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Hashtags (separados por coma)' : 'Hashtags (comma separated)'}</label>
                <input type="text" value={form.targetHashtags} onChange={e => setForm(prev => ({ ...prev, targetHashtags: e.target.value }))}
                  placeholder="#vileda, #limpiezafacil"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-3 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Cuentas a rastrear (separadas por coma)' : 'Accounts to track (comma separated)'}</label>
                <input type="text" value={form.targetAccounts} onChange={e => setForm(prev => ({ ...prev, targetAccounts: e.target.value }))}
                  placeholder="@vileda.es, @vileda_espana"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-3 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Fecha inicio' : 'Start date'}</label>
                  <input type="date" value={form.startDate} onChange={e => setForm(prev => ({ ...prev, startDate: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{es ? 'Fecha fin (opcional)' : 'End date (optional)'}</label>
                  <input type="date" value={form.endDate} onChange={e => setForm(prev => ({ ...prev, endDate: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white focus:border-purple-500 outline-none" />
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Confirm */}
          {step === LAST_STEP && (
            <div className="space-y-5">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{es ? '¡Todo listo!' : 'All set!'}</h3>
              <p className="text-sm text-gray-500">{es ? 'Revisa y lanza tu campaña' : 'Review and launch your campaign'}</p>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-5 space-y-3">
                <div className="flex justify-between">
                  <span className="text-xs text-gray-500 uppercase">{es ? 'Nombre' : 'Name'}</span>
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">{form.name || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-500 uppercase">{es ? 'Objetivo' : 'Objective'}</span>
                  <span className="text-sm font-medium">{selectedObjective?.icon} {es ? selectedObjective?.labelEs : selectedObjective?.label}</span>
                </div>
                {filledTargets.length > 0 && (
                  <div className="flex justify-between gap-4">
                    <span className="text-xs text-gray-500 uppercase shrink-0">{es ? 'Objetivos numéricos' : 'Numeric targets'}</span>
                    <span className="text-sm text-right">
                      {filledTargets.map(f => `${es ? f.labelEs : f.labelEn}: ${formatTarget(f, form[f.key], locale)}`).join(' · ')}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-xs text-gray-500 uppercase">{es ? 'Plataformas' : 'Platforms'}</span>
                  <span className="text-sm">{form.platforms.join(', ') || '—'}</span>
                </div>
                {form.country && (
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 uppercase">{es ? 'País' : 'Country'}</span>
                    <span className="text-sm">{form.country}</span>
                  </div>
                )}
                {form.budget && (
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 uppercase">{es ? 'Presupuesto' : 'Budget'}</span>
                    <span className="text-sm font-semibold">€{Number(form.budget).toLocaleString()}</span>
                  </div>
                )}
                {form.targetHashtags && (
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 uppercase">Hashtags</span>
                    <span className="text-sm">{form.targetHashtags}</span>
                  </div>
                )}
                {form.targetAccounts && (
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 uppercase">{es ? 'Cuentas' : 'Accounts'}</span>
                    <span className="text-sm">{form.targetAccounts}</span>
                  </div>
                )}
              </div>

              <div className="rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 p-4">
                <p className="text-sm text-purple-700 dark:text-purple-300">
                  {es
                    ? '💡 Después de crear la campaña, podrás añadir influencers, subir el brief, gestionar envíos y trackear contenido.'
                    : '💡 After creating the campaign, you can add influencers, upload the brief, manage shipping and track content.'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-8 py-4 flex items-center justify-between bg-gray-50 dark:bg-gray-800/50">
          <button
            onClick={() => step > 0 ? setStep(step - 1) : onClose()}
            className="flex items-center gap-2 rounded-xl border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> {step === 0 ? (es ? 'Cancelar' : 'Cancel') : (es ? 'Atrás' : 'Back')}
          </button>

          {step < LAST_STEP ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canNext()}
              className="flex items-center gap-2 rounded-xl bg-purple-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {es ? 'Siguiente' : 'Next'} <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={isCreating || !canLaunch}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-2.5 text-sm font-bold text-white hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 transition-all"
            >
              {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {es ? 'Lanzar Campaña' : 'Launch Campaign'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

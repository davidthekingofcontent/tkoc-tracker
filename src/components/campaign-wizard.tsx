'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Target,
  Users,
  DollarSign,
  Rocket,
  BarChart3,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Sparkles,
  Instagram,
  Youtube,
  Globe,
  X,
} from 'lucide-react'
import { useI18n } from '@/i18n/context'

/**
 * Campaign Wizard — Guided step-by-step campaign creation.
 * "Guíame" mode: walks user through Planificar → Elegir → Pagar → Ejecutar → Aprender
 *
 * This wizard creates the campaign with minimal friction, then redirects to the campaign page.
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
  { key: 'basics', icon: Sparkles, label: 'Basics', labelEs: 'Básicos' },
  { key: 'tracking', icon: Globe, label: 'Tracking', labelEs: 'Tracking' },
  { key: 'confirm', icon: Rocket, label: 'Launch', labelEs: 'Lanzar' },
]

export function CampaignWizard({ isOpen, onClose }: CampaignWizardProps) {
  const router = useRouter()
  const { t, locale } = useI18n()
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
    if (step === 1) return !!form.name && form.platforms.length > 0
    if (step === 2) return true
    return true
  }

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
          <div className="flex items-center gap-2 mt-4">
            {STEPS.map((s, i) => (
              <div key={s.key} className="flex items-center gap-1">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  i === step ? 'bg-white text-purple-600' :
                  i < step ? 'bg-white/30 text-white' :
                  'bg-white/10 text-white/50'
                }`}>
                  {i < step ? '✓' : i + 1}
                </div>
                <span className={`text-xs font-medium ${i === step ? 'text-white' : 'text-white/50'}`}>
                  {es ? s.labelEs : s.label}
                </span>
                {i < STEPS.length - 1 && <div className={`w-6 h-0.5 ${i < step ? 'bg-white/40' : 'bg-white/10'}`} />}
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

          {/* Step 1: Basics */}
          {step === 1 && (
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

          {/* Step 2: Tracking */}
          {step === 2 && (
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

          {/* Step 3: Confirm */}
          {step === 3 && (
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
                  <span className="text-sm font-medium">{OBJECTIVES.find(o => o.value === form.objective)?.icon} {es ? OBJECTIVES.find(o => o.value === form.objective)?.labelEs : OBJECTIVES.find(o => o.value === form.objective)?.label}</span>
                </div>
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

          {step < 3 ? (
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
              disabled={isCreating || !form.name}
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

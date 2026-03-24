'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Zap,
  Instagram,
  Youtube,
  Users,
  CheckCircle2,
  Upload,
  Globe,
  Star,
  ArrowRight,
  Loader2,
  Shield,
  TrendingUp,
  Award,
  Eye,
} from 'lucide-react'

type CreatorType = 'MACRO' | 'MICRO' | 'NANO' | 'UGC'

const CREATOR_TYPES: { value: CreatorType; label: string; labelEs: string; desc: string; descEs: string; icon: string }[] = [
  { value: 'MACRO', label: 'Macro Creator', labelEs: 'Macro Creator', desc: '250K+ followers. Brand collaborations focus.', descEs: '250K+ seguidores. Enfocado en colaboraciones con marcas.', icon: '🌟' },
  { value: 'MICRO', label: 'Micro Creator', labelEs: 'Micro Creator', desc: '10K-250K followers. High engagement niche.', descEs: '10K-250K seguidores. Alto engagement en nicho.', icon: '⚡' },
  { value: 'NANO', label: 'Nano Creator', labelEs: 'Nano Creator', desc: 'Under 10K followers. Community-driven.', descEs: 'Menos de 10K seguidores. Orientado a comunidad.', icon: '💎' },
  { value: 'UGC', label: 'UGC Creator', labelEs: 'Creador UGC', desc: 'User-generated content specialist. Portfolio-based.', descEs: 'Especialista en contenido generado. Basado en portfolio.', icon: '🎬' },
]

const CATEGORIES = [
  'Lifestyle', 'Beauty', 'Fashion', 'Tech', 'Food', 'Fitness', 'Travel',
  'Gaming', 'Music', 'Education', 'Business', 'Comedy', 'Parenting',
  'Health', 'Sports', 'Art', 'Photography', 'Home', 'Pets', 'Other',
]

const PLATFORMS = [
  { value: 'INSTAGRAM', label: 'Instagram', icon: '📸' },
  { value: 'TIKTOK', label: 'TikTok', icon: '🎵' },
  { value: 'YOUTUBE', label: 'YouTube', icon: '▶️' },
]

export default function CreatorRegisterPage() {
  const [step, setStep] = useState(1)
  const [isLoading, setIsLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lang, setLang] = useState<'en' | 'es'>('es')

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    creatorType: '' as CreatorType | '',
    creatorUsername: '',
    creatorPlatform: '',
    creatorBio: '',
    creatorCategory: '',
    portfolioUrl: '',
    creatorFollowers: '',
    creatorCountry: '',
    creatorCity: '',
    creatorLanguages: [] as string[],
  })

  const t = lang === 'es' ? {
    title: 'Regístrate como Creador',
    subtitle: 'Únete a TKOC Intelligence y conecta con marcas top',
    step1: 'Tipo de creador',
    step2: 'Tu perfil',
    step3: 'Tu cuenta',
    next: 'Siguiente',
    back: 'Atrás',
    submit: 'Crear perfil',
    selectType: 'Selecciona tu tipo de creador',
    username: 'Tu @ principal',
    platform: 'Plataforma principal',
    bio: 'Bio / Sobre ti',
    bioPlaceholder: 'Cuéntanos sobre ti, tu contenido y tu audiencia...',
    category: 'Categoría',
    portfolio: 'URL de portfolio / media kit',
    portfolioPlaceholder: 'https://tu-portfolio.com',
    followers: 'Seguidores (aproximado)',
    country: 'País',
    city: 'Ciudad',
    languages: 'Idiomas de contenido',
    name: 'Nombre completo',
    email: 'Email',
    password: 'Contraseña',
    passwordHint: 'Mínimo 8 caracteres',
    successTitle: '¡Perfil creado!',
    successDesc: 'Tu perfil de creador está pendiente de verificación. Te avisaremos cuando un administrador lo apruebe.',
    successCta: 'Ir al login',
    benefits: [
      'Perfil verificado visible para marcas',
      'Recibe propuestas de colaboración',
      'Accede a datos de tus campañas',
      'Conecta tus cuentas de Instagram y TikTok',
    ],
    alreadyAccount: '¿Ya tienes cuenta?',
    login: 'Inicia sesión',
  } : {
    title: 'Register as Creator',
    subtitle: 'Join TKOC Intelligence and connect with top brands',
    step1: 'Creator type',
    step2: 'Your profile',
    step3: 'Your account',
    next: 'Next',
    back: 'Back',
    submit: 'Create profile',
    selectType: 'Select your creator type',
    username: 'Your main @',
    platform: 'Main platform',
    bio: 'Bio / About you',
    bioPlaceholder: 'Tell us about yourself, your content and your audience...',
    category: 'Category',
    portfolio: 'Portfolio / media kit URL',
    portfolioPlaceholder: 'https://your-portfolio.com',
    followers: 'Followers (approx)',
    country: 'Country',
    city: 'City',
    languages: 'Content languages',
    name: 'Full name',
    email: 'Email',
    password: 'Password',
    passwordHint: 'Minimum 8 characters',
    successTitle: 'Profile created!',
    successDesc: 'Your creator profile is pending verification. We will notify you when an admin approves it.',
    successCta: 'Go to login',
    benefits: [
      'Verified profile visible to brands',
      'Receive collaboration proposals',
      'Access your campaign data',
      'Connect your Instagram and TikTok accounts',
    ],
    alreadyAccount: 'Already have an account?',
    login: 'Sign in',
  }

  async function handleSubmit() {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          name: form.name,
          role: 'CREATOR',
          creatorUsername: form.creatorUsername,
          creatorPlatform: form.creatorPlatform,
          creatorBio: form.creatorBio,
          creatorCategory: form.creatorCategory,
          portfolioUrl: form.portfolioUrl,
          creatorFollowers: parseInt(form.creatorFollowers) || null,
          creatorCountry: form.creatorCountry,
          creatorCity: form.creatorCity,
          creatorType: form.creatorType,
          creatorLanguages: form.creatorLanguages,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Registration failed')
      }

      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setIsLoading(false)
    }
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-emerald-100 border border-emerald-200 mb-6">
            <CheckCircle2 className="w-10 h-10 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{t.successTitle}</h1>
          <p className="mt-3 text-gray-500">{t.successDesc}</p>
          <Link href="/login" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-purple-600 px-6 py-3 text-white font-semibold hover:bg-purple-700 transition-colors">
            {t.successCta} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50">
      {/* Language toggle */}
      <div className="absolute top-4 right-4 flex items-center rounded-lg border border-gray-200 bg-white p-0.5">
        <button onClick={() => setLang('en')} className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${lang === 'en' ? 'bg-purple-100 text-purple-600' : 'text-gray-500 hover:text-gray-700'}`}>EN</button>
        <button onClick={() => setLang('es')} className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${lang === 'es' ? 'bg-purple-100 text-purple-600' : 'text-gray-500 hover:text-gray-700'}`}>ES</button>
      </div>

      <div className="mx-auto max-w-5xl px-4 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-purple-100 border border-purple-200 mb-4">
            <Zap className="w-7 h-7 text-purple-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">{t.title}</h1>
          <p className="mt-2 text-gray-500">{t.subtitle}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left: Benefits */}
          <div className="lg:col-span-1">
            <div className="sticky top-8 space-y-6">
              {/* Benefits */}
              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 mb-4 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-purple-600" />
                  {lang === 'es' ? 'Beneficios' : 'Benefits'}
                </h3>
                <div className="space-y-3">
                  {t.benefits.map((benefit, i) => (
                    <div key={i} className="flex items-start gap-2.5">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                      <span className="text-sm text-gray-600">{benefit}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trust signals */}
              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="grid grid-cols-2 gap-4 text-center">
                  <div>
                    <Award className="h-6 w-6 text-purple-500 mx-auto" />
                    <p className="text-xs text-gray-500 mt-1">{lang === 'es' ? 'Perfil verificado' : 'Verified profile'}</p>
                  </div>
                  <div>
                    <Eye className="h-6 w-6 text-blue-500 mx-auto" />
                    <p className="text-xs text-gray-500 mt-1">{lang === 'es' ? 'Visible a marcas' : 'Visible to brands'}</p>
                  </div>
                  <div>
                    <TrendingUp className="h-6 w-6 text-emerald-500 mx-auto" />
                    <p className="text-xs text-gray-500 mt-1">{lang === 'es' ? 'Analytics pro' : 'Pro analytics'}</p>
                  </div>
                  <div>
                    <Star className="h-6 w-6 text-amber-500 mx-auto" />
                    <p className="text-xs text-gray-500 mt-1">{lang === 'es' ? 'Oportunidades' : 'Opportunities'}</p>
                  </div>
                </div>
              </div>

              {/* Login link */}
              <p className="text-center text-sm text-gray-500">
                {t.alreadyAccount}{' '}
                <Link href="/login" className="text-purple-600 font-semibold hover:underline">{t.login}</Link>
              </p>
            </div>
          </div>

          {/* Right: Form */}
          <div className="lg:col-span-2">
            {/* Step indicator */}
            <div className="flex items-center gap-2 mb-6">
              {[1, 2, 3].map(s => (
                <div key={s} className="flex items-center gap-2">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                    step === s ? 'bg-purple-600 text-white' :
                    step > s ? 'bg-emerald-500 text-white' :
                    'bg-gray-200 text-gray-500'
                  }`}>
                    {step > s ? '✓' : s}
                  </div>
                  <span className={`text-xs font-medium ${step === s ? 'text-purple-600' : 'text-gray-400'}`}>
                    {s === 1 ? t.step1 : s === 2 ? t.step2 : t.step3}
                  </span>
                  {s < 3 && <div className={`w-8 h-0.5 ${step > s ? 'bg-emerald-400' : 'bg-gray-200'}`} />}
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
              {error && (
                <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
              )}

              {/* Step 1: Creator Type */}
              {step === 1 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-bold text-gray-900">{t.selectType}</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {CREATOR_TYPES.map(type => (
                      <button
                        key={type.value}
                        onClick={() => setForm(prev => ({ ...prev, creatorType: type.value }))}
                        className={`rounded-xl border-2 p-4 text-left transition-all ${
                          form.creatorType === type.value
                            ? 'border-purple-500 bg-purple-50'
                            : 'border-gray-200 hover:border-purple-300 hover:bg-gray-50'
                        }`}
                      >
                        <span className="text-2xl">{type.icon}</span>
                        <p className="mt-2 text-sm font-bold text-gray-900">{lang === 'es' ? type.labelEs : type.label}</p>
                        <p className="mt-1 text-xs text-gray-500">{lang === 'es' ? type.descEs : type.desc}</p>
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end pt-4">
                    <button
                      onClick={() => form.creatorType && setStep(2)}
                      disabled={!form.creatorType}
                      className="rounded-xl bg-purple-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      {t.next} <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 2: Profile */}
              {step === 2 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-bold text-gray-900">{t.step2}</h2>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.username}</label>
                      <input type="text" value={form.creatorUsername} onChange={e => setForm(prev => ({ ...prev, creatorUsername: e.target.value }))}
                        placeholder="@tu_usuario" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.platform}</label>
                      <select value={form.creatorPlatform} onChange={e => setForm(prev => ({ ...prev, creatorPlatform: e.target.value }))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none">
                        <option value="">---</option>
                        {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.icon} {p.label}</option>)}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.bio}</label>
                    <textarea value={form.creatorBio} onChange={e => setForm(prev => ({ ...prev, creatorBio: e.target.value }))}
                      placeholder={t.bioPlaceholder} rows={3}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none resize-none" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.category}</label>
                      <select value={form.creatorCategory} onChange={e => setForm(prev => ({ ...prev, creatorCategory: e.target.value }))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none">
                        <option value="">---</option>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.followers}</label>
                      <input type="number" value={form.creatorFollowers} onChange={e => setForm(prev => ({ ...prev, creatorFollowers: e.target.value }))}
                        placeholder="50000" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.country}</label>
                      <input type="text" value={form.creatorCountry} onChange={e => setForm(prev => ({ ...prev, creatorCountry: e.target.value }))}
                        placeholder="España" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.city}</label>
                      <input type="text" value={form.creatorCity} onChange={e => setForm(prev => ({ ...prev, creatorCity: e.target.value }))}
                        placeholder="Madrid" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                    </div>
                  </div>

                  {form.creatorType === 'UGC' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.portfolio}</label>
                      <input type="url" value={form.portfolioUrl} onChange={e => setForm(prev => ({ ...prev, portfolioUrl: e.target.value }))}
                        placeholder={t.portfolioPlaceholder} className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                    </div>
                  )}

                  <div className="flex justify-between pt-4">
                    <button onClick={() => setStep(1)} className="rounded-xl border border-gray-300 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">{t.back}</button>
                    <button onClick={() => setStep(3)} className="rounded-xl bg-purple-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 transition-colors flex items-center gap-2">
                      {t.next} <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: Account */}
              {step === 3 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-bold text-gray-900">{t.step3}</h2>

                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.name}</label>
                    <input type="text" value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="David Calamardo" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.email}</label>
                    <input type="email" value={form.email} onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                      placeholder="tu@email.com" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{t.password}</label>
                    <input type="password" value={form.password} onChange={e => setForm(prev => ({ ...prev, password: e.target.value }))}
                      placeholder="••••••••" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none" />
                    <p className="mt-1 text-xs text-gray-400">{t.passwordHint}</p>
                  </div>

                  <div className="flex justify-between pt-4">
                    <button onClick={() => setStep(2)} className="rounded-xl border border-gray-300 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">{t.back}</button>
                    <button
                      onClick={handleSubmit}
                      disabled={isLoading || !form.name || !form.email || !form.password || form.password.length < 8}
                      className="rounded-xl bg-purple-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      {t.submit}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Ad Permissions Section (skeleton for logged-in creators) */}
        <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-100 border border-purple-200">
              <Shield className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {lang === 'es' ? 'Gestionar Permisos de Anuncios' : 'Manage Ad Permissions'}
              </h2>
              <p className="text-xs text-gray-500">
                {lang === 'es'
                  ? 'Otorga permisos a marcas para impulsar tu contenido via Spark Ads (TikTok) o Partnership Ads (Instagram)'
                  : 'Grant brands permission to boost your content via Spark Ads (TikTok) or Partnership Ads (Instagram)'}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {/* TikTok Spark Ads */}
            <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center gap-3">
                <span className="text-xl">🎵</span>
                <div>
                  <p className="text-sm font-semibold text-gray-900">Spark Ads</p>
                  <p className="text-xs text-gray-500">TikTok</p>
                </div>
              </div>
              <span className="inline-flex items-center rounded-full bg-gray-200 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                {lang === 'es' ? 'Inicia sesion para gestionar' : 'Sign in to manage'}
              </span>
            </div>

            {/* Instagram Partnership Ads */}
            <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center gap-3">
                <span className="text-xl">📸</span>
                <div>
                  <p className="text-sm font-semibold text-gray-900">Partnership Ads</p>
                  <p className="text-xs text-gray-500">Instagram</p>
                </div>
              </div>
              <span className="inline-flex items-center rounded-full bg-gray-200 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                {lang === 'es' ? 'Inicia sesion para gestionar' : 'Sign in to manage'}
              </span>
            </div>

            {/* YouTube BrandConnect */}
            <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center gap-3">
                <span className="text-xl">▶️</span>
                <div>
                  <p className="text-sm font-semibold text-gray-900">BrandConnect</p>
                  <p className="text-xs text-gray-500">YouTube</p>
                </div>
              </div>
              <span className="inline-flex items-center rounded-full bg-gray-200 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                {lang === 'es' ? 'Inicia sesion para gestionar' : 'Sign in to manage'}
              </span>
            </div>
          </div>

          <p className="mt-4 text-center text-xs text-gray-400">
            {lang === 'es'
              ? 'Registrate primero. Podras gestionar permisos desde tu panel de creador.'
              : 'Register first. You can manage permissions from your creator dashboard.'}
          </p>
        </div>

        {/* Footer */}
        <div className="mt-12 text-center">
          <p className="text-xs text-gray-400">Powered by TKOC Intelligence · DAMA Platforms S.L.</p>
          <div className="mt-2 flex items-center justify-center gap-4 text-xs text-gray-400">
            <Link href="/privacy" className="hover:text-gray-600">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-gray-600">Terms of Service</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

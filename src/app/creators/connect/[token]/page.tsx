'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Zap,
  CheckCircle2,
  ArrowRight,
  Loader2,
  Shield,
  LogIn,
  UserPlus,
  AlertCircle,
} from 'lucide-react'

type Mode = 'loading' | 'choose' | 'login' | 'register' | 'success' | 'error'

interface InvitationData {
  email: string
  campaignName: string | null
}

export default function CreatorConnectPage() {
  const params = useParams()
  const router = useRouter()
  const token = params.token as string
  const [mode, setMode] = useState<Mode>('loading')
  const [lang, setLang] = useState<'en' | 'es'>('es')
  const [invitation, setInvitation] = useState<InvitationData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Login form
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  // Register form
  const [regName, setRegName] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')

  const isEs = lang === 'es'

  const t = isEs ? {
    title: 'Conecta tu cuenta',
    subtitle: 'Conecta tu cuenta para mejorar el seguimiento de tu contenido',
    campaignLabel: 'Te invitan desde',
    chooseTitle: '¿Cómo quieres continuar?',
    loginOption: 'Ya tengo una cuenta',
    loginDesc: 'Inicia sesión con tu cuenta existente',
    registerOption: 'Crear nueva cuenta',
    registerDesc: 'Regístrate para conectar tu contenido',
    loginTitle: 'Iniciar sesión',
    email: 'Email',
    password: 'Contraseña',
    passwordHint: 'Mínimo 8 caracteres',
    name: 'Nombre completo',
    login: 'Iniciar sesión',
    register: 'Crear cuenta',
    back: 'Volver',
    successTitle: '¡Cuenta conectada!',
    successDesc: 'Tu cuenta ha sido vinculada. Ahora puedes conectar tus redes sociales desde Ajustes → Integraciones.',
    goToSettings: 'Ir a Integraciones',
    goToDashboard: 'Ir al panel',
    invalidToken: 'Este enlace de invitación no es válido o ha expirado.',
    backToHome: 'Volver al inicio',
    errorOccurred: 'Ha ocurrido un error',
  } : {
    title: 'Connect your account',
    subtitle: 'Connect your account for better content tracking',
    campaignLabel: 'Invited from',
    chooseTitle: 'How would you like to continue?',
    loginOption: 'I already have an account',
    loginDesc: 'Sign in with your existing account',
    registerOption: 'Create new account',
    registerDesc: 'Register to connect your content',
    loginTitle: 'Sign in',
    email: 'Email',
    password: 'Password',
    passwordHint: 'Minimum 8 characters',
    name: 'Full name',
    login: 'Sign in',
    register: 'Create account',
    back: 'Back',
    successTitle: 'Account connected!',
    successDesc: 'Your account has been linked. You can now connect your social networks from Settings → Integrations.',
    goToSettings: 'Go to Integrations',
    goToDashboard: 'Go to dashboard',
    invalidToken: 'This invitation link is invalid or has expired.',
    backToHome: 'Back to home',
    errorOccurred: 'An error occurred',
  }

  // Validate token on mount
  useEffect(() => {
    async function validateToken() {
      try {
        const res = await fetch(`/api/influencers/invite/validate?token=${token}`)
        if (!res.ok) {
          setMode('error')
          setError(t.invalidToken)
          return
        }
        const data = await res.json()
        setInvitation(data)
        setRegEmail(data.email || '')
        setLoginEmail(data.email || '')
        setMode('choose')
      } catch {
        setMode('error')
        setError(t.invalidToken)
      }
    }
    validateToken()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function handleLogin() {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Login failed')
      }

      // Mark invitation as accepted
      await fetch('/api/influencers/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      setMode('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleRegister() {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: regEmail,
          password: regPassword,
          name: regName,
          role: 'CREATOR',
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Registration failed')
      }

      // Mark invitation as accepted
      await fetch('/api/influencers/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      setMode('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setIsLoading(false)
    }
  }

  // Loading state
  if (mode === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    )
  }

  // Error state (invalid token)
  if (mode === 'error') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800 mb-6">
            <AlertCircle className="w-10 h-10 text-red-600 dark:text-red-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t.errorOccurred}</h1>
          <p className="mt-3 text-gray-500 dark:text-gray-400">{error || t.invalidToken}</p>
          <Link href="/login" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-purple-600 px-6 py-3 text-white font-semibold hover:bg-purple-700 transition-colors">
            {t.backToHome} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    )
  }

  // Success state
  if (mode === 'success') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 mb-6">
            <CheckCircle2 className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t.successTitle}</h1>
          <p className="mt-3 text-gray-500 dark:text-gray-400">{t.successDesc}</p>
          <div className="mt-6 flex flex-col gap-3">
            <button
              onClick={() => router.push('/settings')}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 py-3 text-white font-semibold hover:bg-purple-700 transition-colors"
            >
              {t.goToSettings} <ArrowRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => router.push('/')}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 dark:border-gray-600 px-6 py-3 text-gray-700 dark:text-gray-300 font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {t.goToDashboard}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950">
      {/* Language toggle */}
      <div className="absolute top-4 right-4 flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
        <button onClick={() => setLang('en')} className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${lang === 'en' ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'}`}>EN</button>
        <button onClick={() => setLang('es')} className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${lang === 'es' ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'}`}>ES</button>
      </div>

      <div className="mx-auto max-w-md px-4 py-16">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-purple-100 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-800 mb-4">
            <Zap className="w-7 h-7 text-purple-600 dark:text-purple-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t.title}</h1>
          <p className="mt-2 text-gray-500 dark:text-gray-400">{t.subtitle}</p>
          {invitation?.campaignName && (
            <p className="mt-2 text-sm">
              <span className="text-gray-400 dark:text-gray-500">{t.campaignLabel}: </span>
              <span className="font-semibold text-purple-600 dark:text-purple-400">{invitation.campaignName}</span>
            </p>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">{error}</div>
        )}

        {/* Choose mode */}
        {mode === 'choose' && (
          <div className="space-y-3">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white text-center mb-4">{t.chooseTitle}</h2>
            <button
              onClick={() => { setError(null); setMode('login') }}
              className="w-full rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 text-left hover:border-purple-400 dark:hover:border-purple-500 transition-all group"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                  <LogIn className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900 dark:text-white group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">{t.loginOption}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t.loginDesc}</p>
                </div>
              </div>
            </button>
            <button
              onClick={() => { setError(null); setMode('register') }}
              className="w-full rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 text-left hover:border-purple-400 dark:hover:border-purple-500 transition-all group"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                  <UserPlus className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900 dark:text-white group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">{t.registerOption}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t.registerDesc}</p>
                </div>
              </div>
            </button>
          </div>
        )}

        {/* Login form */}
        {mode === 'login' && (
          <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">{t.loginTitle}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">{t.email}</label>
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="tu@email.com"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">{t.password}</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loginEmail && loginPassword && handleLogin()}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <div className="flex justify-between pt-2">
                <button
                  onClick={() => { setError(null); setMode('choose') }}
                  className="rounded-xl border border-gray-300 dark:border-gray-600 px-6 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  {t.back}
                </button>
                <button
                  onClick={handleLogin}
                  disabled={isLoading || !loginEmail || !loginPassword}
                  className="rounded-xl bg-purple-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                >
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                  {t.login}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Register form */}
        {mode === 'register' && (
          <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">{t.registerOption}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">{t.name}</label>
                <input
                  type="text"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="David Calamardo"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">{t.email}</label>
                <input
                  type="email"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="tu@email.com"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">{t.password}</label>
                <input
                  type="password"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && regName && regEmail && regPassword.length >= 8 && handleRegister()}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{t.passwordHint}</p>
              </div>
              <div className="flex justify-between pt-2">
                <button
                  onClick={() => { setError(null); setMode('choose') }}
                  className="rounded-xl border border-gray-300 dark:border-gray-600 px-6 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  {t.back}
                </button>
                <button
                  onClick={handleRegister}
                  disabled={isLoading || !regName || !regEmail || !regPassword || regPassword.length < 8}
                  className="rounded-xl bg-purple-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                >
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {t.register}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-10 text-center">
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 dark:text-gray-500">
            <Shield className="h-3 w-3" />
            <span>Powered by TKOC Intelligence</span>
          </div>
          <div className="mt-2 flex items-center justify-center gap-4 text-xs text-gray-400 dark:text-gray-500">
            <Link href="/privacy" className="hover:text-gray-600 dark:hover:text-gray-300">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-gray-600 dark:hover:text-gray-300">Terms of Service</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

'use client'

import { useState, useEffect, FormEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useI18n } from '@/i18n/context'
import { LanguageToggle } from '@/components/ui/language-toggle'

interface InvitationInfo {
  email: string
  role: string
  invitedBy: string
  expiresAt: string
}

export default function AcceptInvitePage() {
  const params = useParams()
  const router = useRouter()
  const { t } = useI18n()
  const token = params.token as string

  const [invitation, setInvitation] = useState<InvitationInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    async function validateToken() {
      try {
        const res = await fetch(`/api/invite/${token}`)
        if (res.ok) {
          const data = await res.json()
          setInvitation(data)
        } else {
          const data = await res.json()
          setError(data.error || t.invite.invalidInvitation)
        }
      } catch {
        setError(t.invite.failedToValidate)
      } finally {
        setIsLoading(false)
      }
    }
    validateToken()
  }, [token, t])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError(t.invite.passwordsDoNotMatch)
      return
    }

    if (password.length < 6) {
      setError(t.invite.passwordMinLength)
      return
    }

    setIsSubmitting(true)

    try {
      const res = await fetch(`/api/invite/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      })

      const data = await res.json()

      if (res.ok) {
        setSuccess(true)
        // Set auth cookie and redirect
        document.cookie = `token=${data.token}; path=/; max-age=${60 * 60 * 24 * 7}; samesite=lax`
        if (data.user) {
          localStorage.setItem('user', JSON.stringify(data.user))
        }
        setTimeout(() => {
          router.push('/dashboard')
          router.refresh()
        }, 1500)
      } else {
        setError(data.error || t.invite.failedToCreate)
      }
    } catch {
      setError(t.invite.networkError)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      {/* Language Toggle */}
      <div className="absolute top-4 right-4">
        <LanguageToggle />
      </div>

      {/* Background glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[600px] h-[600px] rounded-full bg-purple-500/[0.04] blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-lg">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-purple-100 border border-purple-200 mb-4">
              <svg
                className="w-7 h-7 text-purple-600"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-purple-600 tracking-tight">TKOC Tracker</h1>
          </div>

          {/* Loading */}
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <svg className="animate-spin h-6 w-6 text-purple-600" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
          )}

          {/* Error state (invalid/expired) */}
          {!isLoading && !invitation && (
            <div className="text-center py-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-4">
                <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">
                {error === 'Invitation has expired' ? t.invite.invitationExpired : t.invite.invalidInvitation}
              </h2>
              <p className="text-sm text-gray-500 mb-6">{error}</p>
              <a
                href="/login"
                className="text-sm text-purple-600 hover:text-purple-500 font-medium"
              >
                {t.invite.goToLogin}
              </a>
            </div>
          )}

          {/* Success state */}
          {success && (
            <div className="text-center py-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100 mb-4">
                <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">{t.invite.accountCreated}</h2>
              <p className="text-sm text-gray-500">{t.invite.redirectingToDashboard}</p>
            </div>
          )}

          {/* Invitation form */}
          {!isLoading && invitation && !success && (
            <>
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500">
                  <span className="font-semibold text-gray-900">{invitation.invitedBy}</span> {t.invite.invitedToJoinAs}
                </p>
                <span className="mt-1 inline-flex items-center rounded-full bg-purple-100 px-3 py-1 text-xs font-semibold text-purple-700">
                  {invitation.role.charAt(0) + invitation.role.slice(1).toLowerCase()}
                </span>
              </div>

              {error && (
                <div className="mb-6 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-600 text-sm text-center">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                {/* Email (read-only) */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                    {t.auth.email}
                  </label>
                  <input
                    type="email"
                    value={invitation.email}
                    disabled
                    className="w-full px-4 py-3 rounded-lg bg-gray-50 border border-gray-200 text-gray-500 text-sm cursor-not-allowed"
                  />
                </div>

                {/* Name */}
                <div>
                  <label htmlFor="name" className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                    {t.settings.fullName}
                  </label>
                  <input
                    id="name"
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t.invite.fullNamePlaceholder}
                    className="w-full px-4 py-3 rounded-lg bg-white border border-gray-300 text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-all duration-200"
                    disabled={isSubmitting}
                  />
                </div>

                {/* Password */}
                <div>
                  <label htmlFor="password" className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                    {t.auth.password}
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t.invite.minCharacters}
                    className="w-full px-4 py-3 rounded-lg bg-white border border-gray-300 text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-all duration-200"
                    disabled={isSubmitting}
                  />
                </div>

                {/* Confirm Password */}
                <div>
                  <label htmlFor="confirmPassword" className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                    {t.invite.confirmPassword}
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t.invite.repeatPassword}
                    className="w-full px-4 py-3 rounded-lg bg-white border border-gray-300 text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-all duration-200"
                    disabled={isSubmitting}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 px-4 rounded-lg bg-purple-600 text-white font-semibold text-sm hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:ring-offset-2 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isSubmitting ? (
                    <span className="inline-flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      {t.invite.creatingAccount}
                    </span>
                  ) : (
                    t.invite.createAccountJoin
                  )}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-gray-400 text-xs mt-6">
          {t.auth.secureAccess}
        </p>
      </div>
    </div>
  )
}

'use client'

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { translations, type Locale, type TranslationKeys } from './translations'

interface I18nContextType {
  locale: Locale
  t: TranslationKeys
  setLocale: (locale: Locale) => void
  toggleLocale: () => void
}

const I18nContext = createContext<I18nContextType | null>(null)

/**
 * Spanish is the product default. English is used only when the persisted
 * preference is 'en' or the browser language starts with 'en'.
 */
function detectBrowserLocale(): Locale {
  if (typeof window === 'undefined') return 'es'

  try {
    const stored = localStorage.getItem('tkoc-locale')
    if (stored === 'en' || stored === 'es') return stored
  } catch {
    // storage unavailable (private mode, blocked) — fall through to browser language
  }

  const browserLang = navigator.language || (navigator as unknown as { userLanguage?: string }).userLanguage || 'es'
  return browserLang.toLowerCase().startsWith('en') ? 'en' : 'es'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('es')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const detected = detectBrowserLocale()
    setLocaleState(detected)
    setMounted(true)
  }, [])

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    try {
      localStorage.setItem('tkoc-locale', newLocale)
    } catch {
      // storage unavailable — the choice still applies for this session
    }
  }, [])

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'en' ? 'es' : 'en')
  }, [locale, setLocale])

  const t = translations[locale]

  if (!mounted) {
    return <>{children}</>
  }

  return (
    <I18nContext.Provider value={{ locale, t, setLocale, toggleLocale }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) {
    return {
      locale: 'es' as Locale,
      t: translations.es,
      setLocale: () => {},
      toggleLocale: () => {},
    }
  }
  return context
}

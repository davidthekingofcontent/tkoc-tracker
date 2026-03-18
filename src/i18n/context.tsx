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

function detectBrowserLocale(): Locale {
  if (typeof window === 'undefined') return 'en'

  const stored = localStorage.getItem('tkoc-locale')
  if (stored === 'en' || stored === 'es') return stored

  const browserLang = navigator.language || (navigator as unknown as { userLanguage?: string }).userLanguage || 'en'
  return browserLang.startsWith('es') ? 'es' : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const detected = detectBrowserLocale()
    setLocaleState(detected)
    setMounted(true)
  }, [])

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    localStorage.setItem('tkoc-locale', newLocale)
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
      locale: 'en' as Locale,
      t: translations.en,
      setLocale: () => {},
      toggleLocale: () => {},
    }
  }
  return context
}

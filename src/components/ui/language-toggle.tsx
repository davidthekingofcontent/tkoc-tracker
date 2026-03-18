'use client'

import { useI18n } from '@/i18n/context'

export function LanguageToggle() {
  const { locale, setLocale } = useI18n()

  return (
    <div className="flex items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5">
      <button
        onClick={() => setLocale('en')}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
          locale === 'en'
            ? 'bg-white text-purple-600 shadow-sm'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        EN
      </button>
      <button
        onClick={() => setLocale('es')}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
          locale === 'es'
            ? 'bg-white text-purple-600 shadow-sm'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        ES
      </button>
    </div>
  )
}

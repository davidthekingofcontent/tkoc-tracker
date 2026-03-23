'use client'

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

type ViewMode = 'basic' | 'expert'

interface ViewModeContextType {
  mode: ViewMode
  setMode: (mode: ViewMode) => void
  isExpert: boolean
  toggleMode: () => void
}

const ViewModeContext = createContext<ViewModeContextType>({
  mode: 'basic',
  setMode: () => {},
  isExpert: false,
  toggleMode: () => {},
})

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ViewMode>('basic')

  useEffect(() => {
    const saved = localStorage.getItem('tkoc-view-mode')
    if (saved === 'expert') setModeState('expert')
  }, [])

  function setMode(newMode: ViewMode) {
    setModeState(newMode)
    localStorage.setItem('tkoc-view-mode', newMode)
  }

  function toggleMode() {
    setMode(mode === 'basic' ? 'expert' : 'basic')
  }

  return (
    <ViewModeContext.Provider value={{ mode, setMode, isExpert: mode === 'expert', toggleMode }}>
      {children}
    </ViewModeContext.Provider>
  )
}

export function useViewMode() {
  return useContext(ViewModeContext)
}

/**
 * ViewModeToggle — Small toggle button for Basic/Expert mode.
 * Can be placed in sidebar or settings.
 */
export function ViewModeToggle({ compact = false }: { compact?: boolean }) {
  const { mode, setMode, isExpert } = useViewMode()

  if (compact) {
    return (
      <button
        onClick={() => setMode(isExpert ? 'basic' : 'expert')}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
          isExpert
            ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
            : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
        }`}
        title={isExpert ? 'Switch to Basic mode' : 'Switch to Expert mode'}
      >
        {isExpert ? '⚡ Expert' : '🎯 Basic'}
      </button>
    )
  }

  return (
    <div className="flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-0.5">
      <button
        onClick={() => setMode('basic')}
        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
          mode === 'basic'
            ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700'
        }`}
      >
        🎯 Básico
      </button>
      <button
        onClick={() => setMode('expert')}
        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
          mode === 'expert'
            ? 'bg-white dark:bg-gray-700 text-purple-600 dark:text-purple-300 shadow-sm'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700'
        }`}
      >
        ⚡ Experto
      </button>
    </div>
  )
}

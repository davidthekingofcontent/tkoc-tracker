'use client'

import { useState } from 'react'
import { HelpCircle } from 'lucide-react'

interface InfoTooltipProps {
  text: string
  size?: 'sm' | 'md'
}

export function InfoTooltip({ text, size = 'sm' }: InfoTooltipProps) {
  const [show, setShow] = useState(false)

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShow(!show) }}
    >
      <HelpCircle
        className={`${size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} text-gray-300 hover:text-purple-400 transition-colors cursor-help`}
      />
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-64 rounded-lg bg-gray-900 px-3 py-2.5 text-xs leading-relaxed text-gray-100 shadow-xl pointer-events-none">
          {text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <div className="h-0 w-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-gray-900" />
          </div>
        </div>
      )}
    </span>
  )
}

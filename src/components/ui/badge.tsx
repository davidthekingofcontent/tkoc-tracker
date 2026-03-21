'use client'

import React from 'react'
import { cn } from '@/lib/utils'

type StatusVariant = 'active' | 'paused' | 'archived'
type PlatformVariant = 'instagram' | 'tiktok' | 'youtube'
type BadgeVariant = StatusVariant | PlatformVariant | 'default'

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600',
  active: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800',
  paused: 'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800',
  archived: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-600',
  instagram: 'bg-pink-50 dark:bg-pink-900/30 text-pink-700 dark:text-pink-400 border-pink-200 dark:border-pink-800',
  tiktok: 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800',
  youtube: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800',
}

const dotColors: Partial<Record<BadgeVariant, string>> = {
  active: 'bg-green-500',
  paused: 'bg-yellow-500',
  archived: 'bg-gray-400',
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = 'default', className, children, ...props }, ref) => {
    const showDot = variant in dotColors

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
          variantStyles[variant],
          className
        )}
        {...props}
      >
        {showDot && (
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              dotColors[variant]
            )}
          />
        )}
        {children}
      </span>
    )
  }
)

Badge.displayName = 'Badge'
export { Badge }
export type { BadgeProps, BadgeVariant }

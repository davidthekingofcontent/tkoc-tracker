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
  default: 'bg-gray-100 text-gray-600 border-gray-200',
  active: 'bg-green-50 text-green-700 border-green-200',
  paused: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  archived: 'bg-gray-100 text-gray-600 border-gray-200',
  instagram: 'bg-pink-50 text-pink-700 border-pink-200',
  tiktok: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  youtube: 'bg-red-50 text-red-700 border-red-200',
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

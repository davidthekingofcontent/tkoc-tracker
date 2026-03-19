'use client'

import React from 'react'
import { cn } from '@/lib/utils'

interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode
  label: React.ReactNode
  value: string | number
  trend?: {
    value: number
    direction: 'up' | 'down'
  }
  accent?: boolean
}

const StatCard = React.forwardRef<HTMLDivElement, StatCardProps>(
  ({ icon, label, value, trend, accent = false, className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-xl border border-gray-200 bg-white p-5 shadow-sm',
          accent && 'border-purple-200',
          className
        )}
        {...props}
      >
        <div className="flex items-start justify-between">
          {icon && (
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg',
                accent
                  ? 'bg-purple-50 text-purple-600'
                  : 'bg-gray-100 text-gray-500'
              )}
            >
              {icon}
            </div>
          )}
          {trend && (
            <div
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium',
                trend.direction === 'up'
                  ? 'bg-green-50 text-green-700'
                  : 'bg-red-50 text-red-700'
              )}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={trend.direction === 'down' ? 'rotate-180' : ''}
              >
                <polyline points="18 15 12 9 6 15" />
              </svg>
              {Math.abs(trend.value)}%
            </div>
          )}
        </div>
        <div className="mt-4">
          <p
            className={cn(
              'text-2xl font-bold',
              accent ? 'text-purple-600' : 'text-gray-900'
            )}
          >
            {value}
          </p>
          <p className="mt-1 text-sm text-gray-500">{label}</p>
        </div>
      </div>
    )
  }
)

StatCard.displayName = 'StatCard'
export { StatCard }
export type { StatCardProps }

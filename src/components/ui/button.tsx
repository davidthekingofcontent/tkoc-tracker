'use client'

import React from 'react'
import { cn } from '@/lib/utils'

const variantStyles = {
  primary:
    'bg-purple-600 text-white hover:bg-purple-700 focus-visible:ring-purple-500/50',
  secondary:
    'bg-white text-gray-700 border border-gray-300 hover:border-gray-400 hover:bg-gray-50 focus-visible:ring-gray-300/50',
  danger:
    'bg-red-600 text-white hover:bg-red-500 focus-visible:ring-red-500/50',
  ghost:
    'bg-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-gray-300/50',
} as const

const sizeStyles = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-12 px-6 text-base gap-2.5 rounded-lg',
} as const

type ButtonVariant = keyof typeof variantStyles
type ButtonSize = keyof typeof sizeStyles

type ButtonBaseProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  children: React.ReactNode
}

type ButtonAsButton = ButtonBaseProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonBaseProps> & {
    as?: 'button'
  }

type ButtonAsAnchor = ButtonBaseProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonBaseProps> & {
    as: 'a'
  }

type ButtonProps = ButtonAsButton | ButtonAsAnchor

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}

const Button = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ButtonProps
>((props, ref) => {
  const {
    variant = 'primary',
    size = 'md',
    loading = false,
    className,
    children,
    ...rest
  } = props

  const classes = cn(
    'inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
    variantStyles[variant],
    sizeStyles[size],
    loading && 'pointer-events-none opacity-70',
    className
  )

  if (props.as === 'a') {
    const { as, variant: _v, size: _s, loading: _l, ...anchorProps } = props
    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={classes}
        {...anchorProps}
      >
        {loading && <Spinner />}
        {children}
      </a>
    )
  }

  const { as, variant: _v, size: _s, loading: _l, ...buttonProps } =
    props as ButtonAsButton
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      className={classes}
      disabled={(rest as ButtonAsButton).disabled || loading}
      {...buttonProps}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
})

Button.displayName = 'Button'
export { Button }
export type { ButtonProps }

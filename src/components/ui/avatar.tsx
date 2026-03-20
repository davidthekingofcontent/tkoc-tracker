'use client'

import React, { useState } from 'react'
import { cn } from '@/lib/utils'

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string | null
  alt?: string
  name?: string
  size?: 'sm' | 'md' | 'lg'
}

const sizeStyles = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-lg',
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** Proxy external CDN URLs through our image proxy to avoid CORS/expiration issues */
function getProxiedUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const externalHosts = [
      'cdninstagram.com',
      'fbcdn.net',
      'googleusercontent.com',
      'ggpht.com',
      'ytimg.com',
      'tiktokcdn.com',
      'tiktokcdn-us.com',
      'muscdn.com',
      'pbs.twimg.com',
    ]
    const isExternal = externalHosts.some(
      (host) => parsed.hostname.endsWith(host) || parsed.hostname === host
    )
    if (isExternal) {
      return `/api/proxy/image?url=${encodeURIComponent(url)}`
    }
  } catch {
    // Invalid URL, return as-is
  }
  return url
}

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ src, alt, name, size = 'md', className, ...props }, ref) => {
    const [imgError, setImgError] = useState(false)
    const proxiedSrc = src ? getProxiedUrl(src) : null
    const showImage = proxiedSrc && !imgError
    const initials = name ? getInitials(name) : '?'

    return (
      <div
        ref={ref}
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-purple-100 font-medium text-purple-700',
          sizeStyles[size],
          className
        )}
        {...props}
      >
        {showImage ? (
          <img
            src={proxiedSrc}
            alt={alt || name || 'Avatar'}
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <span>{initials}</span>
        )}
      </div>
    )
  }
)

Avatar.displayName = 'Avatar'
export { Avatar }
export type { AvatarProps }

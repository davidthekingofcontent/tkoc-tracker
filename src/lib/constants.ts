import {
  Home,
  LayoutDashboard,
  Megaphone,
  Users,
  DollarSign,
  BarChart3,
  BookOpen,
  UserSearch,
  Compass,
  ListChecks,
  Contact,
  Kanban,
  Settings,
  Instagram,
  Youtube,
  Twitter,
  type LucideIcon,
} from 'lucide-react'

export const APP_NAME = 'TKOC Intelligence'

export interface Platform {
  id: string
  name: string
  icon: LucideIcon
  color: string
  bgColor: string
}

export const PLATFORMS: Record<string, Platform> = {
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    icon: Instagram,
    color: '#E4405F',
    bgColor: 'bg-pink-500',
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    icon: Youtube,
    color: '#FF0000',
    bgColor: 'bg-red-600',
  },
  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    icon: Twitter, // placeholder until lucide adds TikTok
    color: '#000000',
    bgColor: 'bg-black',
  },
  twitter: {
    id: 'twitter',
    name: 'X / Twitter',
    icon: Twitter,
    color: '#1DA1F2',
    bgColor: 'bg-sky-500',
  },
}

export interface CampaignStatus {
  id: string
  label: string
  color: string
  bgColor: string
}

export const CAMPAIGN_STATUSES: Record<string, CampaignStatus> = {
  draft: {
    id: 'draft',
    label: 'Draft',
    color: 'text-gray-600',
    bgColor: 'bg-gray-100',
  },
  active: {
    id: 'active',
    label: 'Active',
    color: 'text-green-700',
    bgColor: 'bg-green-100',
  },
  paused: {
    id: 'paused',
    label: 'Paused',
    color: 'text-yellow-700',
    bgColor: 'bg-yellow-100',
  },
  completed: {
    id: 'completed',
    label: 'Completed',
    color: 'text-blue-700',
    bgColor: 'bg-blue-100',
  },
  archived: {
    id: 'archived',
    label: 'Archived',
    color: 'text-gray-500',
    bgColor: 'bg-gray-50',
  },
}

export const MEDIA_TYPES = {
  image: { id: 'image', label: 'Image' },
  video: { id: 'video', label: 'Video' },
  carousel: { id: 'carousel', label: 'Carousel' },
  story: { id: 'story', label: 'Story' },
  reel: { id: 'reel', label: 'Reel' },
  short: { id: 'short', label: 'Short' },
  live: { id: 'live', label: 'Live' },
} as const

export interface UserRole {
  id: string
  label: string
  permissions: string[]
}

export const USER_ROLES: Record<string, UserRole> = {
  admin: {
    id: 'admin',
    label: 'Admin',
    permissions: [
      'manage_users',
      'manage_campaigns',
      'manage_creators',
      'view_analytics',
      'manage_settings',
      'manage_billing',
    ],
  },
  manager: {
    id: 'manager',
    label: 'Manager',
    permissions: [
      'manage_campaigns',
      'manage_creators',
      'view_analytics',
    ],
  },
  analyst: {
    id: 'analyst',
    label: 'Analyst',
    permissions: ['view_analytics', 'manage_creators'],
  },
  viewer: {
    id: 'viewer',
    label: 'Viewer',
    permissions: ['view_analytics'],
  },
}

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
}

export const MAIN_NAV_ITEMS: NavItem[] = [
  { label: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Campaigns', href: '/campaigns', icon: Megaphone },
  { label: 'Creators', href: '/discover', icon: Users },
  { label: 'Pricing', href: '/pricing', icon: DollarSign },
  { label: 'Results', href: '/compare', icon: BarChart3 },
  { label: 'Methodology', href: '/methodology', icon: BookOpen },
]

export const SECONDARY_NAV_ITEMS: NavItem[] = [
  { label: 'Lists', href: '/lists', icon: ListChecks },
  { label: 'Contacts', href: '/contacts', icon: Contact },
  { label: 'Pipeline', href: '/pipeline', icon: Kanban },
  { label: 'Settings', href: '/settings', icon: Settings },
]

/** @deprecated Use MAIN_NAV_ITEMS and SECONDARY_NAV_ITEMS instead */
export const NAV_ITEMS: NavItem[] = [...MAIN_NAV_ITEMS, ...SECONDARY_NAV_ITEMS]

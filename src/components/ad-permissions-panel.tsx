'use client'

import { useState, useEffect, useCallback } from 'react'
import { Zap, Shield, Copy, Check, X, ExternalLink } from 'lucide-react'

// ============ TYPES ============

type PermissionType = 'spark_ads' | 'partnership_ads' | 'brandconnect'
type PermissionStatus = 'PENDING' | 'GRANTED' | 'REVOKED'

interface AdPermission {
  id: string
  creatorId: string
  campaignId: string
  platform: string
  permissionType: PermissionType
  authorizationCode: string | null
  status: PermissionStatus
  grantedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  createdAt: string
}

interface AdPermissionsPanelProps {
  mode: 'creator' | 'brand'
  creatorId: string
  campaignId: string
  campaignName?: string
  creatorName?: string
  locale?: 'en' | 'es'
  onPermissionChange?: () => void
}

// ============ CONFIG ============

const PLATFORM_PERMISSIONS: Record<string, { type: PermissionType; platform: string; icon: string }> = {
  tiktok: { type: 'spark_ads', platform: 'TIKTOK', icon: '🎵' },
  instagram: { type: 'partnership_ads', platform: 'INSTAGRAM', icon: '📸' },
  youtube: { type: 'brandconnect', platform: 'YOUTUBE', icon: '▶️' },
}

const PERMISSION_INFO = {
  spark_ads: {
    en: {
      label: 'Spark Ads',
      desc: 'Allows the brand to boost your TikTok content as a paid ad. Your handle and content appear in the ad.',
    },
    es: {
      label: 'Spark Ads',
      desc: 'Permite a la marca impulsar tu contenido de TikTok como anuncio pagado. Tu perfil y contenido aparecen en el anuncio.',
    },
  },
  partnership_ads: {
    en: {
      label: 'Partnership Ads',
      desc: 'Allows the brand to run ads using your Instagram content. Shows as a partnership between you and the brand.',
    },
    es: {
      label: 'Partnership Ads',
      desc: 'Permite a la marca crear anuncios usando tu contenido de Instagram. Se muestra como una colaboracion entre tu y la marca.',
    },
  },
  brandconnect: {
    en: {
      label: 'BrandConnect',
      desc: 'Allows the brand to promote your YouTube content through the BrandConnect program.',
    },
    es: {
      label: 'BrandConnect',
      desc: 'Permite a la marca promocionar tu contenido de YouTube a traves del programa BrandConnect.',
    },
  },
}

// ============ STATUS BADGE ============

function StatusBadge({ status, locale }: { status: PermissionStatus; locale: 'en' | 'es' }) {
  const config: Record<PermissionStatus, { bg: string; text: string; label: Record<'en' | 'es', string> }> = {
    GRANTED: {
      bg: 'bg-emerald-100 dark:bg-emerald-900/30',
      text: 'text-emerald-700 dark:text-emerald-400',
      label: { en: 'Granted', es: 'Otorgado' },
    },
    PENDING: {
      bg: 'bg-amber-100 dark:bg-amber-900/30',
      text: 'text-amber-700 dark:text-amber-400',
      label: { en: 'Pending', es: 'Pendiente' },
    },
    REVOKED: {
      bg: 'bg-red-100 dark:bg-red-900/30',
      text: 'text-red-700 dark:text-red-400',
      label: { en: 'Revoked', es: 'Revocado' },
    },
  }
  const c = config[status]
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${c.bg} ${c.text}`}>
      {c.label[locale]}
    </span>
  )
}

// ============ MAIN COMPONENT ============

export default function AdPermissionsPanel({
  mode,
  creatorId,
  campaignId,
  campaignName,
  creatorName,
  locale = 'es',
  onPermissionChange,
}: AdPermissionsPanelProps) {
  const [permissions, setPermissions] = useState<AdPermission[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  const t = locale === 'es'
    ? {
        title: 'Permisos de Anuncios',
        noPermissions: 'No hay permisos activos',
        grantPermission: 'Otorgar permiso',
        revokePermission: 'Revocar',
        requestPermission: 'Solicitar permiso',
        authCode: 'Codigo de autorizacion',
        copyCode: 'Copiar codigo',
        copied: 'Copiado',
        expires: 'Expira',
        grantedOn: 'Otorgado',
        platforms: 'Plataformas disponibles',
        creatorView: 'Campanas solicitando permisos',
        brandView: 'Permisos del influencer',
        permissionExplain: 'Al otorgar permiso, la marca podra utilizar tu contenido para anuncios pagados.',
      }
    : {
        title: 'Ad Permissions',
        noPermissions: 'No active permissions',
        grantPermission: 'Grant permission',
        revokePermission: 'Revoke',
        requestPermission: 'Request permission',
        authCode: 'Authorization code',
        copyCode: 'Copy code',
        copied: 'Copied',
        expires: 'Expires',
        grantedOn: 'Granted on',
        platforms: 'Available platforms',
        creatorView: 'Campaigns requesting permissions',
        brandView: 'Influencer permissions',
        permissionExplain: 'By granting permission, the brand will be able to use your content for paid ads.',
      }

  // ---- Fetch permissions ----
  const fetchPermissions = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/creators/ad-permissions?creatorId=${creatorId}&campaignId=${campaignId}`
      )
      if (res.ok) {
        const data = await res.json()
        setPermissions(data.permissions || [])
      }
    } catch (err) {
      console.error('Failed to fetch ad permissions:', err)
    } finally {
      setLoading(false)
    }
  }, [creatorId, campaignId])

  useEffect(() => {
    fetchPermissions()
  }, [fetchPermissions])

  // ---- Grant permission ----
  async function grantPermission(platform: string, permissionType: PermissionType) {
    setActionLoading(`grant_${platform}`)
    try {
      const res = await fetch('/api/creators/ad-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId, campaignId, platform, permissionType }),
      })
      if (res.ok) {
        await fetchPermissions()
        onPermissionChange?.()
      }
    } catch (err) {
      console.error('Failed to grant permission:', err)
    } finally {
      setActionLoading(null)
    }
  }

  // ---- Revoke permission ----
  async function revokePermission(permissionId: string) {
    setActionLoading(`revoke_${permissionId}`)
    try {
      const res = await fetch(
        `/api/creators/ad-permissions?permissionId=${permissionId}&creatorId=${creatorId}&campaignId=${campaignId}`,
        { method: 'DELETE' }
      )
      if (res.ok) {
        await fetchPermissions()
        onPermissionChange?.()
      }
    } catch (err) {
      console.error('Failed to revoke permission:', err)
    } finally {
      setActionLoading(null)
    }
  }

  // ---- Copy to clipboard ----
  function copyToClipboard(code: string) {
    navigator.clipboard.writeText(code)
    setCopiedCode(code)
    setTimeout(() => setCopiedCode(null), 2000)
  }

  // ---- Get active permission for a platform ----
  function getActivePermission(platform: string): AdPermission | undefined {
    return permissions.find((p) => p.platform === platform && p.status === 'GRANTED')
  }

  // ---- Loading skeleton ----
  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-10 w-full rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-10 w-full rounded bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
            <Shield className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
          </div>
          <h3 className="text-sm font-bold text-gray-900 dark:text-white">{t.title}</h3>
        </div>
        {(campaignName || creatorName) && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate max-w-[120px]">
            {mode === 'creator' ? campaignName : creatorName}
          </span>
        )}
      </div>

      {/* Creator mode: explanation */}
      {mode === 'creator' && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
          {t.permissionExplain}
        </p>
      )}

      {/* Platform rows */}
      <div className="space-y-2">
        {Object.entries(PLATFORM_PERMISSIONS).map(([key, config]) => {
          const active = getActivePermission(config.platform)
          const info = PERMISSION_INFO[config.type][locale]

          return (
            <div
              key={key}
              className="rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-base flex-shrink-0">{config.icon}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-gray-900 dark:text-white">
                        {info.label}
                      </span>
                      {active && <StatusBadge status={active.status} locale={locale} />}
                    </div>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">
                      {info.desc}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex-shrink-0">
                  {mode === 'creator' && (
                    <>
                      {active ? (
                        <button
                          onClick={() => revokePermission(active.id)}
                          disabled={actionLoading === `revoke_${active.id}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-2 py-1 text-[10px] font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                          {t.revokePermission}
                        </button>
                      ) : (
                        <button
                          onClick={() => grantPermission(config.platform, config.type)}
                          disabled={actionLoading === `grant_${config.platform}`}
                          className="inline-flex items-center gap-1 rounded-lg bg-purple-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-purple-700 transition-colors disabled:opacity-50"
                        >
                          <Zap className="h-3 w-3" />
                          {t.grantPermission}
                        </button>
                      )}
                    </>
                  )}

                  {mode === 'brand' && (
                    <>
                      {active ? (
                        <StatusBadge status={active.status} locale={locale} />
                      ) : (
                        <button
                          onClick={() => grantPermission(config.platform, config.type)}
                          disabled={actionLoading === `grant_${config.platform}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 px-2 py-1 text-[10px] font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-colors disabled:opacity-50"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {t.requestPermission}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Authorization code (TikTok Spark Ads) */}
              {active?.authorizationCode && (mode === 'brand' || mode === 'creator') && (
                <div className="mt-2 rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[10px] text-gray-500 dark:text-gray-400 font-medium">
                        {t.authCode}
                      </span>
                      <p className="text-xs font-mono text-gray-900 dark:text-white truncate">
                        {active.authorizationCode}
                      </p>
                    </div>
                    <button
                      onClick={() => copyToClipboard(active.authorizationCode!)}
                      className="flex-shrink-0 inline-flex items-center gap-1 rounded-md bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 px-2 py-1 text-[10px] text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
                    >
                      {copiedCode === active.authorizationCode ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-500" />
                          {t.copied}
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          {t.copyCode}
                        </>
                      )}
                    </button>
                  </div>
                  {active.expiresAt && (
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                      {t.expires}: {new Date(active.expiresAt).toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US')}
                    </p>
                  )}
                </div>
              )}

              {/* Granted date */}
              {active?.grantedAt && (
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                  {t.grantedOn}: {new Date(active.grantedAt).toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US')}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* No permissions message */}
      {permissions.filter((p) => p.status === 'GRANTED').length === 0 && (
        <p className="text-center text-[11px] text-gray-400 dark:text-gray-500 py-1">
          {t.noPermissions}
        </p>
      )}
    </div>
  )
}

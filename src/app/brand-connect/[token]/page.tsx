'use client'

/**
 * Brand Connect landing — public 1-click page where a brand (e.g. Vileda)
 * connects their Instagram. No auth: the token is only decoded client-side
 * for display; the server verifies signature/expiry on OAuth start.
 */

import { useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Zap,
  Shield,
  Instagram,
  CheckCircle2,
  AlertCircle,
  BarChart3,
  Lock,
  ArrowRight,
  Building2,
  Loader2,
} from 'lucide-react'

interface InviteDisplayData {
  brandName: string
  brandLogo?: string
  expired: boolean
}

/** Decode JWT payload for DISPLAY ONLY — no verification (server verifies on OAuth start). */
function decodeInviteForDisplay(token: string): InviteDisplayData | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4))
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad
    const payload = JSON.parse(atob(b64))
    if (payload.purpose !== 'brand_connect' || !payload.brandName) return null
    return {
      brandName: payload.brandName,
      brandLogo: payload.brandLogo || undefined,
      expired: typeof payload.exp === 'number' && payload.exp * 1000 < Date.now(),
    }
  } catch {
    return null
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  denied: 'Has cancelado la conexión con Facebook. No se ha conectado nada.',
  invalid_state: 'La sesión de conexión ha caducado. Vuelve a intentarlo.',
  state_mismatch: 'La sesión de conexión no es válida. Vuelve a intentarlo.',
  missing_invite: 'No se ha encontrado la invitación. Vuelve a abrir el enlace que te enviamos.',
  invalid_token: 'Este enlace de conexión no es válido o ha caducado. Pide un enlace nuevo a tu contacto en TKOC.',
  no_ig_account: 'No hemos encontrado ninguna cuenta de Instagram Business vinculada a tus páginas de Facebook. Asegúrate de que tu Instagram es una cuenta Profesional (Business) conectada a una Página de Facebook.',
  exchange_failed: 'Ha ocurrido un error al conectar con Meta. Vuelve a intentarlo en unos minutos.',
  not_configured: 'La conexión no está disponible en este momento. Contacta con tu contacto en TKOC.',
}

export default function BrandConnectPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = params.token as string
  const [isRedirecting, setIsRedirecting] = useState(false)

  const invite = useMemo(() => decodeInviteForDisplay(token), [token])

  const success = searchParams?.get('success') === 'true'
  const errorCode = searchParams?.get('error')
  const errorMessage = errorCode
    ? ERROR_MESSAGES[errorCode] || ERROR_MESSAGES.exchange_failed
    : null

  function handleConnect() {
    setIsRedirecting(true)
    window.location.href = `/api/auth/meta/brand-connect/start?token=${encodeURIComponent(token)}`
  }

  const footer = (
    <div className="mt-10 text-center">
      <div className="flex items-center justify-center gap-2 text-xs text-gray-400 dark:text-gray-500">
        <Shield className="h-3 w-3" />
        <span>Powered by TKOC Intelligence</span>
      </div>
      <div className="mt-2 flex items-center justify-center gap-4 text-xs text-gray-400 dark:text-gray-500">
        <Link href="/privacy" className="hover:text-gray-600 dark:hover:text-gray-300">
          Política de Privacidad
        </Link>
        <Link href="/terms" className="hover:text-gray-600 dark:hover:text-gray-300">
          Términos de Servicio
        </Link>
      </div>
    </div>
  )

  const wordmark = (
    <div className="flex items-center justify-center gap-2 mb-8">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-600">
        <Zap className="h-5 w-5 text-white" />
      </div>
      <span className="text-lg font-bold tracking-tight text-gray-900 dark:text-white">
        TKOC <span className="text-purple-600 dark:text-purple-400">Intelligence</span>
      </span>
    </div>
  )

  // Invalid / undecodable / expired link
  if (!invite || invite.expired) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md text-center">
          {wordmark}
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800 mb-6">
            <AlertCircle className="w-10 h-10 text-red-600 dark:text-red-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Enlace no válido</h1>
          <p className="mt-3 text-gray-500 dark:text-gray-400">
            Este enlace de conexión no es válido o ha caducado. Pide un enlace nuevo a tu contacto en TKOC.
          </p>
          {footer}
        </div>
      </div>
    )
  }

  // Success screen
  if (success) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-purple-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md text-center">
          {wordmark}
          <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-emerald-100 dark:bg-emerald-900/30 border-4 border-emerald-200 dark:border-emerald-800 mb-6">
            <CheckCircle2 className="w-12 h-12 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">✓ Conectado</h1>
          <p className="mt-3 text-lg text-gray-600 dark:text-gray-300">
            Ya estamos midiendo las menciones de{' '}
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">{invite.brandName}</span>.
          </p>
          <div className="mt-8 rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 p-5 text-left">
            <p className="text-sm text-emerald-800 dark:text-emerald-300">
              A partir de ahora, cada vez que un creador mencione o etiquete a tu marca lo detectaremos
              automáticamente y aparecerá en tus informes de campaña. No tienes que hacer nada más —
              ya puedes cerrar esta página.
            </p>
          </div>
          {footer}
        </div>
      </div>
    )
  }

  // Main landing
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950">
      <div className="mx-auto max-w-lg px-4 py-14">
        {wordmark}

        {/* Brand identity */}
        <div className="text-center">
          {invite.brandLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={invite.brandLogo}
              alt={invite.brandName}
              className="mx-auto h-16 w-16 rounded-2xl object-contain bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-1 mb-4"
            />
          ) : (
            <div className="mx-auto inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-purple-100 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-800 mb-4">
              <Building2 className="w-8 h-8 text-purple-600 dark:text-purple-400" />
            </div>
          )}
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Conecta el Instagram de{' '}
            <span className="text-purple-600 dark:text-purple-400">{invite.brandName}</span>
          </h1>
          <p className="mt-3 text-gray-500 dark:text-gray-400">
            Un solo clic para que tus campañas de influencers se midan automáticamente.
          </p>
        </div>

        {errorMessage && (
          <div className="mt-6 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-400 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* What / why / what not */}
        <div className="mt-8 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
          <ul className="space-y-4">
            <li className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                <Instagram className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">Qué se conecta</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Las menciones, etiquetas y estadísticas de la cuenta de Instagram de {invite.brandName}.
                </p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <BarChart3 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">Para qué</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Para medir el impacto real de tus campañas de influencers: alcance, interacciones y
                  contenido que menciona a tu marca, sin capturas de pantalla.
                </p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Lock className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">Qué NO hacemos</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Nunca publicamos, respondemos ni tocamos tu cuenta. Solo lectura de datos, nada más.
                </p>
              </div>
            </li>
          </ul>

          <button
            onClick={handleConnect}
            disabled={isRedirecting}
            className="mt-6 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 px-6 py-4 text-base font-semibold text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
          >
            {isRedirecting ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Instagram className="h-5 w-5" />
            )}
            {errorMessage ? 'Reintentar conexión' : 'Conectar Instagram'}
            {!isRedirecting && <ArrowRight className="h-4 w-4" />}
          </button>

          <p className="mt-4 text-xs text-center text-gray-400 dark:text-gray-500">
            Se abrirá Facebook para autorizar el acceso. Necesitas ser administrador de la Página de
            Facebook vinculada al Instagram de {invite.brandName}.
          </p>
        </div>

        {footer}
      </div>
    </div>
  )
}

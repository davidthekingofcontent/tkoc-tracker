import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { campaignHasTargets, campaignWindowEndExclusive } from '@/lib/campaign-capture'
import { notifyAdminsOncePerDay } from '@/lib/notifications'

// GET /api/cron/watchdog (header x-cron-secret) — every 6 h from the internal scheduler.
//
// Born 2026-09-24: a budget gate had silently skipped the stories and track
// crons for two weeks (last stamp 14 Sept) and nobody noticed until a PM
// complained. This watchdog does not run any scrape: it only reads the
// `cron_<name>_last_run` stamps written by the capture crons and, when a cron
// that HAS work to do has not completed a run for too long — whatever the
// cause (budget gate, breaker, crash, scheduler dead, Apify down) — it alerts
// every active ADMIN once per UTC day per cron.

const STORIES_MAX_CAMPAIGN_DAYS = Number(process.env.STORIES_MAX_CAMPAIGN_DAYS || 62)
const STORY_STATUSES = ['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'] as const

/** Hours after which a cron with pending work counts as stale. */
const STALE_AFTER_HOURS: Record<string, number> = {
  stories: Number(process.env.WATCHDOG_STORIES_STALE_HOURS || 36), // runs every 12 h
  track: Number(process.env.WATCHDOG_TRACK_STALE_HOURS || 48), // runs every 6 h, throttled to once a day
  'check-posts': Number(process.env.WATCHDOG_CHECK_POSTS_STALE_HOURS || 36), // runs every 12 h
}

interface Check {
  name: string
  lastRunAt: string | null
  ageHours: number | null
  eligibleWork: boolean
  stale: boolean
  alerted: boolean
}

function fmtMadrid(iso: string | null): string {
  if (!iso) return 'nunca'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'nunca'
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t))
  const g = (type: string) => parts.find(p => p.type === type)?.value?.padStart(2, '0') ?? '??'
  return `${g('day')}/${g('month')} a las ${g('hour')}:${g('minute')}`
}

async function lastRun(name: string): Promise<{ iso: string | null; ageHours: number | null }> {
  const row = await prisma.setting.findUnique({ where: { key: `cron_${name}_last_run` } }).catch(() => null)
  const t = row?.value ? Date.parse(row.value) : NaN
  if (!Number.isFinite(t)) return { iso: null, ageHours: null }
  return { iso: new Date(t).toISOString(), ageHours: Math.round(((Date.now() - t) / 3_600_000) * 10) / 10 }
}

/** Live campaigns (ACTIVE, window includes now) with targets, plus their confirmed IG members. */
async function liveCampaigns() {
  const now = new Date()
  const rows = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', startDate: { lte: now } },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      targetAccounts: true,
      targetHashtags: true,
      influencers: {
        where: { status: { in: [...STORY_STATUSES] }, influencer: { platform: 'INSTAGRAM' } },
        select: { id: true },
      },
      _count: { select: { influencers: true } },
    },
  })
  return rows.filter(c => {
    const endExclusive = campaignWindowEndExclusive(c.endDate)
    return !endExclusive || now < endExclusive
  })
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const live = await liveCampaigns()
    const withTargets = live.filter(c => campaignHasTargets(c))
    // Stories: only short campaigns (the stories cron skips long/annual ones) with confirmed IG creators
    const storyWork = withTargets.some(c => {
      const start = new Date(c.startDate).getTime()
      const end = c.endDate ? new Date(c.endDate).getTime() : NaN
      const days = Number.isFinite(end) ? (end - start) / 86_400_000 : NaN
      return Number.isFinite(days) && days <= STORIES_MAX_CAMPAIGN_DAYS && c.influencers.length > 0
    })
    const trackWork = withTargets.length > 0
    const checkPostsWork = live.some(c => c._count.influencers > 0)

    const defs: Array<{ name: string; eligibleWork: boolean; title: string; subject: string; meanwhile: string }> = [
      {
        name: 'stories',
        eligibleWork: storyWork,
        title: 'El rastreo de stories no se está ejecutando',
        subject: 'El rastreo automático de stories',
        meanwhile: 'Mientras, registra las stories a mano en Ejecutar → Stories → "Registrar Story" o pega el enlace en Media → "Añadir publicación por URL".',
      },
      {
        name: 'track',
        eligibleWork: trackWork,
        title: 'La captura automática de publicaciones no se está ejecutando',
        subject: 'La captura automática de publicaciones (hashtags y menciones)',
        meanwhile: 'Mientras, añade las publicaciones a mano en Ejecutar → Media → "Añadir publicación por URL".',
      },
      {
        name: 'check-posts',
        eligibleWork: checkPostsWork,
        title: 'La comprobación de publicaciones nuevas no se está ejecutando',
        subject: 'La comprobación periódica de publicaciones nuevas de las creadoras',
        meanwhile: 'Mientras, usa "Rastrear Ahora" en la ficha de cada campaña.',
      },
    ]

    const checks: Check[] = []
    for (const d of defs) {
      const { iso, ageHours } = await lastRun(d.name)
      const staleAfter = STALE_AFTER_HOURS[d.name]
      const stale = d.eligibleWork && (ageHours === null || ageHours > staleAfter)
      let alerted = false
      if (stale) {
        const since = iso ? `La última ejecución completa fue el ${fmtMadrid(iso)} (hace ${Math.round(ageHours ?? 0)} h)` : 'No hay constancia de ninguna ejecución completa'
        alerted = await notifyAdminsOncePerDay(`cron_stale_alert_${d.name}`, {
          type: 'cron_stale',
          title: d.title,
          message: `${since} y hay campañas activas con trabajo pendiente. ${d.subject} debería correr al menos cada ${staleAfter} h. Comprueba Apify (Ajustes → Integraciones) o avisa a soporte. ${d.meanwhile}`,
          link: '/settings',
        })
        console.warn(`[Cron/Watchdog] ${d.name} STALE: last run ${iso ?? 'never'} (${ageHours ?? '?'} h)${alerted ? ' — ADMINs alerted' : ''}`)
      }
      checks.push({ name: d.name, lastRunAt: iso, ageHours, eligibleWork: d.eligibleWork, stale, alerted })
    }

    return NextResponse.json({ ok: true, liveCampaigns: live.length, withTargets: withTargets.length, checks })
  } catch (error) {
    console.error('[Cron/Watchdog] error:', error)
    return NextResponse.json({ error: 'Watchdog failed' }, { status: 500 })
  }
}

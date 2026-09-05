/**
 * Campaign export — CSV and JSON built on the ONE campaign computation
 * (src/lib/campaign-overview.ts), so an export never disagrees with the
 * campaign page, the report or the portal.
 *
 * David 2026-09-05 (decision 10): the old jsPDF generator and its preview
 * modal are gone. The PDF is the on-screen report printed by the browser
 * (/campaigns/[id]/report → "Exportar PDF").
 *
 * GET  /api/campaigns/[id]/export?format=csv|json
 * POST /api/campaigns/[id]/export { format }   (kept for old callers)
 *
 * Definitions (src/lib/metrics.ts): interacciones = likes + comentarios +
 * shares + saves; audiencia = alcance real → impresiones → vistas → estimación
 * etiquetada e informativa; ER y CPM SOLO sobre audiencia real (4A); coste = fee acordado o coste;
 * "Ratio EMV" = EMV ÷ coste. Money is EUR. Dates are Europe/Madrid.
 *
 * CSV dialect — Excel es-ES (decision for #28). Every label in the file is
 * Spanish and the person opening it works in Spanish Excel, whose list
 * separator is ';' and whose decimal mark is ','. A ','-separated file with
 * '.' decimals lands in a single column there and its numbers stay text, so:
 *   - fields are separated with ';' (CSV_SEP) and quoted when they contain it,
 *   - every number goes through Intl es-ES without grouping ("3,25", "12345")
 *     so Excel parses it as a number,
 *   - dates are d/m/yyyy (Europe/Madrid),
 *   - a UTF-8 BOM keeps the accents.
 * The JSON export is the machine-readable format (raw numbers, ISO dates).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { madridDayKey, type CampaignOverview } from '@/lib/metrics'
import { parseBaseline } from '@/lib/creator-baseline'

type Format = 'csv' | 'json'

function parseFormat(v: unknown): Format | null {
  const f = String(v || 'csv').toLowerCase()
  if (f === 'csv' || f === 'json') return f
  return null
}

async function loadCampaign(id: string) {
  return prisma.campaign.findUnique({
    where: { id },
    select: {
      id: true, name: true, type: true, status: true, userId: true, objective: true, country: true, platforms: true,
      startDate: true, endDate: true, targetAccounts: true, targetHashtags: true,
      targetViews: true, targetReach: true, targetEngagement: true, targetER: true, targetCpmMax: true, targetsFrozenAt: true,
      influencers: {
        select: {
          influencerId: true, status: true, agreedFee: true, cost: true, negotiatedFormat: true,
          deliverablesPlanned: true, trackedLink: true, trackedClicks: true, baselineSnapshot: true,
          influencer: { select: { username: true, displayName: true, platform: true, followers: true, engagementRate: true, country: true } },
        },
      },
      media: {
        orderBy: { postedAt: 'desc' },
        select: {
          id: true, externalId: true, platform: true, mediaType: true, caption: true, permalink: true, postedAt: true,
          likes: true, comments: true, shares: true, saves: true, views: true, reach: true, impressions: true,
          source: true, isDeleted: true, contentAngle: true, hook: true, productBenefit: true,
          influencer: { select: { id: true, username: true, platform: true } },
        },
      },
    },
  })
}

type LoadedCampaign = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>

async function handle(request: NextRequest, id: string, format: Format) {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const campaign = await loadCampaign(id)
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  if (session.role === 'BRAND' && campaign.userId !== session.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const overview = await computeCampaignOverview(id)
  if (!overview) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  const filename = `${slug(campaign.name)}-${madridDayKey(new Date())}`
  return format === 'csv'
    ? csvResponse(buildCsv(campaign, overview), `${filename}.csv`)
    : NextResponse.json(buildJson(campaign, overview), {
        headers: { 'Content-Disposition': `attachment; filename="${filename}.json"` },
      })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const format = parseFormat(request.nextUrl.searchParams.get('format'))
    if (!format) return NextResponse.json({ error: 'Unsupported format. Use csv or json (the PDF is the printable report).' }, { status: 400 })
    return await handle(request, id, format)
  } catch (error) {
    console.error('Export campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json().catch(() => ({})) as { format?: unknown }
    const format = parseFormat(body.format)
    if (!format) return NextResponse.json({ error: 'Unsupported format. Use csv or json (the PDF is the printable report).' }, { status: 400 })
    return await handle(request, id, format)
  } catch (error) {
    console.error('Export campaign POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============ helpers ============

function slug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'campana'
}

/** Field separator of the CSV: Excel es-ES list separator (see the file header). */
const CSV_SEP = ';'
const NEEDS_QUOTES = new RegExp(`["${CSV_SEP}\\n\\r]`)
/** es-ES decimals, no grouping: "3,25" / "12345" — what Excel es-ES parses as a number. */
const NUM_ES = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2, useGrouping: false })

function numEs(v: number): string {
  return Number.isFinite(v) ? NUM_ES.format(v) : ''
}

/** One CSV cell: numbers in es-ES, strings quoted when they carry the separator, quotes or line breaks. */
function esc(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return numEs(v)
  const s = String(v)
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One CSV line from its cells. */
function row(...cells: Array<string | number | null | undefined>): string {
  return cells.map(esc).join(CSV_SEP)
}

/** Two-decimal figure (ER, CPM, ratios, money) or '' for null. */
function n2(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : numEs(Math.round(v * 100) / 100)
}

function dateEs(d: Date | string | null | undefined): string {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })
}

function basisLabel(b: string): string {
  switch (b) {
    case 'reach': return 'alcance real'
    case 'impressions': return 'impresiones reales'
    case 'views': return 'vistas reales'
    case 'estimated_story': return 'estimado (story)'
    case 'estimated_post': return 'estimado (post)'
    default: return 'sin base'
  }
}

function csvResponse(body: string, filename: string): NextResponse {
  // BOM so Excel opens UTF-8 (accents) correctly
  return new NextResponse('﻿' + body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

function buildCsv(c: LoadedCampaign, o: CampaignOverview): string {
  const L: string[] = []
  const t = o.totals
  L.push('INFORME DE CAMPAÑA (exportación de datos)')
  L.push(row('Campaña', c.name))
  L.push(row('Tipo', c.type))
  L.push(row('Estado', c.status))
  L.push(row('Objetivo', c.objective || ''))
  L.push(row('Inicio', dateEs(c.startDate)))
  L.push(row('Fin', dateEs(c.endDate)))
  L.push(row('País', c.country || ''))
  L.push(row('Plataformas', c.platforms.join(' | ')))
  L.push(row('Cuentas objetivo', c.targetAccounts.join(' | ')))
  L.push(row('Hashtags', c.targetHashtags.join(' | ')))
  L.push(row('Generado', dateEs(new Date())))
  L.push('')

  L.push('RESUMEN')
  L.push(row('Miembros', t.members))
  L.push(row('Creadores con contenido', t.creatorsActive))
  L.push(row('Publicaciones', t.media))
  L.push(row('Stories', t.stories))
  L.push(row('Publicaciones eliminadas por el creador', t.mediaDeleted))
  L.push(row('Vistas', t.views))
  L.push(row('Interacciones (likes+comentarios+shares+saves)', t.engagements))
  L.push(row('Likes', t.likes))
  L.push(row('Comentarios', t.comments))
  L.push(row('Shares', t.shares))
  L.push(row('Saves', t.saves))
  L.push(row('Audiencia total', t.audience.total))
  L.push(row('Audiencia real', t.audience.real))
  L.push(row('Audiencia estimada', t.audience.estimated))
  L.push(row('% audiencia estimada', n2(t.audience.estimatedShare * 100)))
  L.push(row('Alcance real (solo alcance)', t.reachReal))
  L.push(row('Impresiones reales', t.impressionsReal))
  L.push(row('Tasa de engagement (%)', n2(t.er.value)))
  L.push(row('Coste total (EUR)', n2(t.cost)))
  L.push(row('Miembros con coste', t.membersWithCost))
  L.push(row('CPM real sobre audiencia real (EUR)', n2(t.cpm)))
  L.push(row('EMV (EUR)', n2(t.emvExtended)))
  L.push(row('EMV solo alcance (EUR)', n2(t.emvBasic)))
  L.push(row('Ratio EMV (EMV / coste)', n2(t.emvRatio)))
  L.push(row('Stories con audiencia estimada', t.emvEstimatedStories))
  L.push('')

  if (o.targets.length > 0) {
    L.push('OBJETIVOS')
    L.push(row('KPI', 'Objetivo', 'Resultado', 'Variación (%)', 'Veredicto'))
    for (const r of o.targets) L.push(row(r.key, r.target, r.actual, n2(r.variationPct), r.verdict))
    L.push('')
  }

  if (o.business) {
    const b = o.business
    L.push('RESULTADOS DE NEGOCIO (aportados por el cliente)')
    L.push(row('Código promocional', b.promoCode))
    L.push(row('Canjes de código', b.codeRedemptions))
    L.push(row('Ventas reportadas', b.clientReportedSales))
    L.push(row('Leads reportados', b.clientReportedLeads))
    L.push(row('Ingresos reportados (EUR)', n2(b.clientReportedRevenue)))
    L.push(row('CPA (EUR)', n2(b.cpa)))
    L.push(row('ROAS', n2(b.roas)))
    L.push(row('Fuente', b.source))
    L.push(row('Fecha', dateEs(b.reportedAt)))
    L.push('')
  }

  L.push('RENDIMIENTO POR CREADOR')
  L.push(row(
    'Usuario', 'Nombre', 'Plataforma', 'Seguidores', 'Estado', 'Formato negociado', 'Coste (EUR)', 'Entregables comprometidos',
    'Publicaciones', 'Stories', 'Eliminadas', 'Vistas', 'Interacciones', 'Audiencia total', 'Audiencia real', 'Audiencia estimada',
    'Tasa de engagement (%)', 'CPM (EUR)', 'EMV (EUR)', 'Ratio EMV', 'Vs su habitual (x)', 'Línea base n', 'Clics enlace',
  ))
  const byId = new Map(c.influencers.map(ci => [ci.influencerId, ci]))
  for (const p of o.perInfluencer) {
    const ci = byId.get(p.influencerId)
    const baseline = parseBaseline(ci?.baselineSnapshot)
    const cmp = p.vsBaseline
    L.push(row(
      `@${p.username}`, p.displayName || '', p.platform, p.followers, p.status, ci?.negotiatedFormat || '',
      n2(p.cost), p.deliverablesPlanned, p.posts, p.stories, p.deleted, p.views, p.engagements,
      p.audience.total, p.audience.real, p.audience.estimated, n2(p.er.value), n2(p.cpm), n2(p.emvExtended), n2(p.emvRatio),
      n2(cmp?.multiplier ?? null), baseline?.n, ci?.trackedClicks,
    ))
  }
  L.push('')

  L.push('CONTENIDOS')
  L.push(row(
    'Fecha', 'Creador', 'Plataforma', 'Tipo', 'Origen', 'Eliminada', 'Likes', 'Comentarios', 'Shares', 'Saves', 'Vistas',
    'Audiencia', 'Base de audiencia', 'Interacciones', 'EMV (EUR)', 'Enfoque', 'Gancho', 'Beneficio', 'Enlace', 'Descripción',
  ))
  const pm = new Map(o.perMedia.map(m => [m.id, m]))
  for (const m of c.media) {
    const x = pm.get(m.id)
    L.push(row(
      dateEs(m.postedAt), `@${m.influencer?.username || ''}`, m.platform, m.mediaType, m.source, m.isDeleted ? 'sí' : 'no',
      m.likes, m.comments, m.shares, m.saves, m.views, x?.audience, basisLabel(x?.audienceBasis || 'none'), x?.engagements,
      n2(x?.emvExtended ?? null), m.contentAngle || '', m.hook || '', m.productBenefit || '', m.permalink || '', (m.caption || '').replace(/\s+/g, ' ').slice(0, 300),
    ))
  }
  L.push('')
  L.push('DEFINICIONES')
  L.push(row('Interacciones', 'likes + comentarios + shares + saves'))
  L.push(row('Audiencia real', 'por publicación: alcance real; si no hay, impresiones reales; si no hay, vistas reales (cualquier fuente: API de Meta, Apify, estadísticas del creador registradas por la PM, manual). Es la base de la tasa de engagement, del CPM real y del objetivo de alcance'))
  L.push(row('Audiencia estimada', 'solo informativa y siempre etiquetada: stories sin vistas (seguidores × % por tier y secuencia) y publicaciones sin alcance, impresiones ni vistas (seguidores × tasa por tier). Nunca entra en la tasa de engagement, el CPM ni los objetivos'))
  L.push(row('Audiencia total', 'audiencia real + audiencia estimada (cifra informativa; su % estimado se indica aparte)'))
  L.push(row('Base de audiencia', 'alcance real / impresiones reales / vistas reales = dato real; estimado (story) / estimado (post) = informativo; sin base = sin dato ni seguidores'))
  L.push(row('Tasa de engagement', 'interacciones de las publicaciones con audiencia real ÷ audiencia real × 100; celda vacía = sin dato real (ninguna publicación con alcance, impresiones o vistas reales), nunca 0'))
  L.push(row('CPM real', 'coste ÷ audiencia real × 1000; celda vacía = sin coste o sin dato real'))
  L.push(row('Coste', 'fee acordado; si no hay fee, coste'))
  L.push(row('EMV', 'valor mediático equivalente estimado (no representa ventas ni retorno)'))
  L.push(row('Ratio EMV', 'EMV ÷ coste'))
  L.push(row('Vs su habitual', 'mediana por pieza de las publicaciones de la campaña del mismo formato ÷ mediana de las últimas 12 publicaciones del creador antes del acuerdo'))
  return L.join('\n')
}

function buildJson(c: LoadedCampaign, o: CampaignOverview) {
  const byId = new Map(c.influencers.map(ci => [ci.influencerId, ci]))
  const pm = new Map(o.perMedia.map(m => [m.id, m]))
  return {
    generatedAt: new Date().toISOString(),
    definitionsVersion: o.definitionsVersion,
    currency: 'EUR',
    campaign: {
      id: c.id, name: c.name, type: c.type, status: c.status, objective: c.objective, country: c.country, platforms: c.platforms,
      startDate: c.startDate, endDate: c.endDate, targetAccounts: c.targetAccounts, targetHashtags: c.targetHashtags,
      targets: {
        views: c.targetViews, reach: c.targetReach, engagement: c.targetEngagement, er: c.targetER, cpmMax: c.targetCpmMax, frozenAt: c.targetsFrozenAt,
      },
    },
    totals: o.totals,
    targets: o.targets,
    business: o.business,
    timeline: o.timeline,
    influencers: o.perInfluencer.map(p => {
      const ci = byId.get(p.influencerId)
      const baseline = parseBaseline(ci?.baselineSnapshot)
      return {
        ...p,
        negotiatedFormat: ci?.negotiatedFormat ?? null,
        trackedLink: ci?.trackedLink ?? null,
        trackedClicks: ci?.trackedClicks ?? null,
        baseline,
      }
    }),
    media: c.media.map(m => ({
      id: m.id, postedAt: m.postedAt, influencer: m.influencer?.username ?? null, platform: m.platform, mediaType: m.mediaType,
      source: m.source, isDeleted: m.isDeleted, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves, views: m.views,
      reach: m.reach, impressions: m.impressions, permalink: m.permalink, caption: m.caption,
      tags: { contentAngle: m.contentAngle, hook: m.hook, productBenefit: m.productBenefit },
      metrics: pm.get(m.id) ?? null,
    })),
    definitions: {
      engagements: 'likes + comments + shares + saves',
      audienceReal: 'per publication: real reach → real impressions → real views (any source: Meta API, Apify, creator insights recorded by the PM, manual); the base of the engagement rate, the real CPM and the reach target',
      audienceEstimated: 'informative only, always labelled: stories without views (followers × tier rate × sequence decay) and publications without reach, impressions or views (followers × tier rate); never enters the engagement rate, the CPM or the targets',
      audience: 'total = real + estimated (informative; estimatedShare is the estimated part, 0–1)',
      audienceBasis: 'reach / impressions / views = real; estimated_story / estimated_post = informative estimate; none = no data and no followers',
      engagementRate: 'engagements of the publications with a real audience ÷ real audience × 100; null = no real data (never 0)',
      cpm: 'cost ÷ real audience × 1000; null without cost or without real data',
      cost: 'agreed fee, else cost',
      emv: 'estimated equivalent media value; not sales nor return',
      emvRatio: 'EMV ÷ cost',
      vsBaseline: 'median of the creator\'s last 12 same-format publications before the deal',
    },
  }
}

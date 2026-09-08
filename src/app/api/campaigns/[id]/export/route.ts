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
 * shares + saves; audiencia = alcance real → vistas reales → estimación
 * etiquetada e informativa; tasa de engagement = interacciones ÷ VISTAS reales
 * de las mismas piezas (4B, ≥ 3 piezas con vistas); CPM = coste ÷ vistas reales
 * × 1000; coste = fee acordado o coste; "Ratio EMV" = EMV ÷ coste. Impressions
 * are not captured and never exported (David, 2026-09-08). The "Prometido vs
 * entregado" checklist (overview.delivery) and the four-dimension balance
 * (overview.balance) travel in both formats. Money is EUR. Dates are Europe/Madrid.
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
          likes: true, comments: true, shares: true, saves: true, views: true, reach: true,
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
    case 'impressions': return 'dato real'
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
  L.push(row('Tasa de engagement sobre vistas (%)', n2(t.er.value)))
  L.push(row('Publicaciones con vistas reales (base de la tasa)', t.er.pieces))
  L.push(row('Vistas reales de esa base', t.er.denominator))
  L.push(row('Interacciones de esa base', t.er.numerator))
  L.push(row('Coste total (EUR)', n2(t.cost)))
  L.push(row('Miembros con coste', t.membersWithCost))
  L.push(row('CPM sobre vistas (EUR)', n2(t.cpm)))
  L.push(row('EMV (EUR)', n2(t.emvExtended)))
  L.push(row('EMV solo audiencia (EUR)', n2(t.emvBasic)))
  L.push(row('Ratio EMV (EMV / coste)', n2(t.emvRatio)))
  L.push(row('Stories con audiencia estimada', t.emvEstimatedStories))
  L.push('')

  // Prometido vs entregado (overview.delivery) — real counts, "sí" only when it is true
  const dl = o.delivery
  L.push('PROMETIDO VS ENTREGADO')
  L.push(row('Concepto', 'Entregado', 'Prometido', 'Cumplido'))
  L.push(row('Creadores (acordados que han publicado)', dl.creators.delivered, dl.creators.planned, dl.creators.ok ? 'sí' : 'no'))
  L.push(row('Piezas (publicadas / comprometidas)', dl.pieces.delivered, dl.pieces.planned, dl.pieces.ok ? 'sí' : 'no'))
  L.push(row('Fechas (dentro del periodo / con fecha)', dl.dates.inWindow, dl.dates.total, dl.dates.ok ? 'sí' : 'no'))
  L.push(row('Identificación legal (#publicidad / colaboración pagada)', dl.disclosure.disclosed, dl.disclosure.total, dl.disclosure.ok ? 'sí' : 'no'))
  L.push(row('Publicaciones sin identificación legal', dl.disclosure.missingMediaIds.length))
  L.push(row('Todo cumplido', dl.allOk ? 'sí' : 'no'))
  L.push('')

  // Balance en cuatro dimensiones (overview.balance); la eficiencia es un juicio de coste (interno)
  const bl = o.balance
  L.push('BALANCE DE CAMPAÑA')
  L.push(row('Ejecución', balanceLabel('execution', bl.execution)))
  L.push(row('Resultados', balanceLabel('results', bl.results)))
  L.push(row('Eficiencia', balanceLabel('efficiency', bl.efficiency)))
  L.push(row('Fiabilidad de datos', balanceLabel('reliability', bl.dataReliability)))
  L.push(row('% de publicaciones con vistas reales', n2(bl.realShare * 100)))
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
    'Tasa de engagement sobre vistas (%)', 'CPM sobre vistas (EUR)', 'EMV (EUR)', 'Ratio EMV', 'Vs su habitual (x)', 'Línea base n', 'Clics enlace',
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
  L.push(row('Tasa de engagement', 'interacciones ÷ vistas reales × 100 de las mismas publicaciones (las que tienen vistas). Solo se publica con al menos 3 publicaciones con vistas, 500 vistas y un ratio plausible (≤ 100 %); celda vacía = muestra real insuficiente o sin dato real, nunca 0'))
  L.push(row('CPM sobre vistas', 'coste ÷ vistas reales × 1000; celda vacía = sin coste o sin vistas reales'))
  L.push(row('Audiencia real', 'por publicación: alcance real aportado por el creador; si no hay, vistas reales (cualquier fuente: API de Meta, Apify, estadísticas del creador registradas por la PM, manual). Es la base del objetivo de alcance'))
  L.push(row('Audiencia estimada', 'solo informativa, interna y siempre etiquetada: stories sin vistas (seguidores × % por tier y secuencia) y publicaciones sin alcance ni vistas (seguidores × tasa por tier). Nunca entra en la tasa de engagement, el CPM ni los objetivos, y el cliente nunca la ve'))
  L.push(row('Audiencia total', 'audiencia real + audiencia estimada (cifra informativa interna; su % estimado se indica aparte)'))
  L.push(row('Base de audiencia', 'alcance real / vistas reales = dato real; estimado (story) / estimado (post) = informativo; sin base = sin dato ni seguidores'))
  L.push(row('Coste', 'fee acordado; si no hay fee, coste'))
  L.push(row('EMV', 'valor equivalente en medios pagados de la audiencia y las interacciones conseguidas, a tarifas de mercado por plataforma y formato; incluye las stories. No representa ventas ni retorno'))
  L.push(row('Ratio EMV', 'EMV ÷ coste, mostrado como multiplicador (nunca ROI)'))
  L.push(row('Prometido vs entregado', 'creadores en Acordado o superior que han publicado; piezas publicadas frente a los entregables comprometidos por creador; publicaciones dentro del periodo de campaña; publicaciones de feed con #publicidad / colaboración pagada'))
  L.push(row('Balance', 'cuatro lecturas separadas: ejecución (lista Prometido vs entregado), resultados (objetivos), eficiencia (CPM sobre vistas frente al CPM máximo; interno) y fiabilidad de datos (% de publicaciones con vistas reales: ≥ 80 % alta, ≥ 50 % media)'))
  L.push(row('Vs su habitual', 'mediana por pieza de las publicaciones de la campaña del mismo formato ÷ mediana de las últimas 12 publicaciones del creador antes del acuerdo'))
  return L.join('\n')
}

/** Spanish label of one balance dimension value (src/lib/metrics.ts CampaignBalance). */
function balanceLabel(dimension: 'execution' | 'results' | 'efficiency' | 'reliability', value: string): string {
  const labels: Record<typeof dimension, Record<string, string>> = {
    execution: { complete: 'completa', issues: 'con incidencias', incomplete: 'incompleta', no_data: 'sin datos' },
    results: { above: 'por encima del objetivo', on_target: 'en objetivo', below: 'por debajo del objetivo', no_targets: 'sin objetivos' },
    efficiency: { better: 'mejor que el CPM máximo', in_range: 'dentro del CPM máximo', worse: 'peor que el CPM máximo', no_data: 'sin datos' },
    reliability: { high: 'alta', medium: 'media', low: 'baja', no_data: 'sin datos' },
  }
  return labels[dimension][value] ?? value
}

function buildJson(c: LoadedCampaign, o: CampaignOverview) {
  const byId = new Map(c.influencers.map(ci => [ci.influencerId, ci]))
  const pm = new Map(o.perMedia.map(m => [m.id, m]))
  // Impressions are not captured and are never exported (decision 1); the rest of the totals travel verbatim.
  const { impressionsReal: _impressionsReal, ...totals } = o.totals
  void _impressionsReal
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
    totals,
    targets: o.targets,
    business: o.business,
    delivery: o.delivery,
    balance: o.balance,
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
      reach: m.reach, permalink: m.permalink, caption: m.caption,
      tags: { contentAngle: m.contentAngle, hook: m.hook, productBenefit: m.productBenefit },
      metrics: pm.get(m.id) ?? null,
    })),
    definitions: {
      engagements: 'likes + comments + shares + saves',
      engagementRate: 'engagements ÷ real views × 100 over the same publications (those with views); published only with ≥ 3 publications with views, ≥ 500 views and a plausible ratio (≤ 100 %); null = insufficient real sample or no real data (never 0). er.pieces / er.denominator / er.numerator carry the base',
      cpm: 'cost ÷ real views × 1000; null without cost or without real views',
      audienceReal: 'per publication: creator-provided real reach → real views (any source: Meta API, Apify, creator insights recorded by the PM, manual); the base of the reach target',
      audienceEstimated: 'informative and internal only, always labelled: stories without views (followers × tier rate × sequence decay) and publications without reach or views (followers × tier rate); never enters the engagement rate, the CPM or the targets and is never shown to the client',
      audience: 'total = real + estimated (informative, internal; estimatedShare is the estimated part, 0–1)',
      audienceBasis: 'reach / views = real; estimated_story / estimated_post = informative estimate; none = no data and no followers',
      cost: 'agreed fee, else cost',
      emv: 'equivalent paid-media value of the audience and interactions achieved, at market rates per platform and format; stories included. Not sales nor return',
      emvRatio: 'EMV ÷ cost, shown as a multiplier (never ROI)',
      delivery: 'promised vs delivered: creators in Agreed or later that published; pieces published vs committed deliverables per creator (planned null when none set); publications inside the campaign window; feed publications with #ad / paid partnership (missingMediaIds lists the rest)',
      balance: 'four separate readings, no single score: execution (delivery checklist), results (targets), efficiency (CPM on views vs the max CPM target; internal), dataReliability (realShare = share of publications with real views: ≥ 0.8 high, ≥ 0.5 medium)',
      vsBaseline: 'median of the creator\'s last 12 same-format publications before the deal',
    },
  }
}

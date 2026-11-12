/**
 * Write tools of the MCP connector for TRACKING: «Rastrear ahora» of a
 * campaign and the manual «Sincronizar» of one Instagram brand connection.
 *
 * Built with defineWriteTool (../../write-tool.ts); routes checked in this
 * working copy:
 *   POST /api/campaigns/[id]/track          no body. SYNCHRONOUS here: the whole run (Meta sync,
 *                                           hashtags, mentions, every member, stories, revalidation)
 *                                           happens inside the request. There is no GET to follow a
 *                                           run and no flag of a run in flight (the background version
 *                                           with GET /track lives on another branch).
 *   GET  /api/meta/connections              the session user's own brand connections
 *   POST /api/meta/sync/[connectionId]      no body
 *
 * So launch_campaign_tracking waits a short while for the answer; when the run
 * is longer the platform keeps working after the connector stops waiting (the
 * route never looks at the request being closed). One run per campaign is let
 * through by this server process until it answers or 45 minutes pass.
 *
 * The date of the last read of a campaign is taken from its scrape_jobs rows
 * (database, READS ONLY): no route returns it.
 */
import { prisma } from '@/lib/db'
import { defineWriteTool, type WriteTool } from '../../write-tool'
import { projectRevalidation, revalidationFingerprint } from './campaigns'
import { ToolError, idInput, shortText } from '../shared'
import {
  UNKNOWN_AFTER_TIMEOUT,
  asArray,
  asNumber,
  asObject,
  asString,
  at,
  attempt,
  named,
  plural,
  readCampaign,
  usageText,
  type CampaignSnapshot,
} from './creators'

// =====================================================================
// launch_campaign_tracking
// =====================================================================

/** How long a run launched by this process blocks another one of the same campaign. */
export const TRACK_IN_FLIGHT_MS = 45 * 60_000
/** How long the connector waits for the answer of the run before saying it goes on in the background. */
export const TRACK_WAIT_MS = 30_000
/** «Rastrear ahora» is not behind the platform's budget gate: the connector refuses it from this percentage of the plan. */
export const TRACK_MAX_USED_PCT = 95

const inFlight = new Map<string, number>()

function runningSince(campaignId: string, now = Date.now()): number | null {
  const started = inFlight.get(campaignId)
  if (started === undefined) return null
  if (now - started >= TRACK_IN_FLIGHT_MS) {
    inFlight.delete(campaignId)
    return null
  }
  return started
}

/** Test hook: forget the runs this process believes are in flight. */
export function resetTrackingRuns(): void {
  inFlight.clear()
}

/** As the track route reads them (normalizeTargets): split, without @ or #, lower case, unique. */
function normalizedTargets(values: readonly string[]): string[] {
  const out = new Set<string>()
  for (const value of values) {
    for (const token of String(value ?? '').split(/[\s,]+/)) {
      const clean = token.trim().replace(/^[@#]+/, '').trim().toLowerCase()
      if (clean) out.add(clean)
    }
  }
  return [...out]
}

const JOB_STATUS: Record<string, string> = { COMPLETED: 'completada', FAILED: 'fallida', RUNNING: 'en marcha o sin cerrar', PENDING: 'pendiente' }

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

function refuseIfNotTrackable(s: CampaignSnapshot): void {
  if (s.status !== 'ACTIVE') {
    const state = s.status === 'PAUSED' ? 'pausada' : s.status === 'ARCHIVED' ? 'archivada' : 'inactiva'
    throw new ToolError(`Solo se rastrean campañas activas: ${named(s.name)} está ${state}. No se ha hecho nada.`)
  }
  const since = runningSince(s.id)
  if (since !== null) {
    throw new ToolError(
      `Ya hay un «Rastrear ahora» en marcha en ${named(s.name)} desde las ${hhmm(since)} UTC, lanzado por este conector. No se lanza otro: espera a que termine y consulta el resultado con get_campaign o list_campaign_media.`,
    )
  }
}

export const launchCampaignTracking = defineWriteTool({
  name: 'launch_campaign_tracking',
  title: 'Lanzar «Rastrear ahora»',
  description:
    "Starts 'Rastrear ahora' for one ACTIVE campaign: it syncs the agency's Instagram brand connections, reads the campaign hashtags and brand mentions, reads every member's profile and stories and ends with a revalidation that takes out captured pieces that no longer meet the rules. " +
    'Taking pieces out needs the administrator\'s approval, so it is refused while that final revalidation would take any out with the rules of now (run revalidate_campaign_media first, or fix the rules) and for a campaign without brand accounts, hashtags or product keywords (it would capture nothing and take every scraped piece out). ' +
    'It is the most expensive action: its Apify cost grows with members, hashtags, brand accounts and networks, and it is not behind the platform\'s budget gate, so it is refused when the plan is at 95 % or more. ' +
    'Use when the person asks to track or refresh a campaign now. It answers within about 30 seconds; a longer run goes on in the platform, and a second launch of the same campaign is refused meanwhile. ' +
    'Never relaunch because a result is slow: follow the figures with get_campaign or list_campaign_media. It does NOT track paused or archived campaigns and does not add discovered authors as members.',
  input: { campaignId: idInput('The campaign id (it must be ACTIVE).') },
  confirmations: ['money'],
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  summarize: a => ({ campaignId: a.campaignId }),
  async plan(args, ctx) {
    const s = await readCampaign(ctx, args.campaignId)
    refuseIfNotTrackable(s)
    const apify = await ctx.apifyStatus()
    if (apify.usedPct !== null && apify.usedPct >= TRACK_MAX_USED_PCT) {
      return {
        confirmation: 'money',
        refuse: `El plan de Apify está al ${apify.usedPct} %: «Rastrear ahora» no se ofrece a partir del ${TRACK_MAX_USED_PCT} % para no dejar sin presupuesto la captura diaria. No se ha hecho nada.`,
      }
    }
    // The run ENDS with revalidateCampaignMedia (track route), which detaches or deletes pieces: the
    // destructive part of revalidate_campaign_media, which only runs with the administrator's approval
    if (!s.hasTargets) {
      return {
        confirmation: 'money',
        refuse:
          `${named(s.name)} no tiene cuentas de marca, hashtags ni palabras clave de producto: el rastreo no capturaría nada y su revalidación final sacaría de la campaña todas las piezas que no se añadieron a mano. ` +
          'Configura antes las reglas con set_campaign_tracking_targets. No se ha hecho nada.',
      }
    }
    const projected = await projectRevalidation(s.id)
    if (projected.leave > 0) {
      return {
        confirmation: 'money',
        refuse:
          `Con las reglas de ahora, la revalidación con la que termina «Rastrear ahora» sacaría ${plural(projected.leave, 'pieza', 'piezas')} de ${named(s.name)} ` +
          `(${projected.detach} se desvincularían y ${projected.remove} se borrarían; por ejemplo: ${projected.examples.slice(0, 3).join('; ')}). ` +
          'Sacar piezas necesita la confirmación del administrador en la plataforma: usa antes revalidate_campaign_media (o corrige las reglas o las fechas si no deberían salir) y después vuelve a lanzar el rastreo. No se ha hecho nada.',
      }
    }
    const hashtags = normalizedTargets(s.targetHashtags)
    const accounts = normalizedTargets(s.targetAccounts)
    const keywords = normalizedTargets(s.targetKeywords)
    const igMembers = s.members.filter(m => m.platform === 'INSTAGRAM').length
    const last = await prisma.scrapeJob.findFirst({
      where: { campaignId: s.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, status: true, jobType: true },
    })
    const lastText = last
      ? `${last.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC (${shortText(last.jobType, 20) ?? 'lectura'}, ${JOB_STATUS[last.status] ?? last.status})`
      : 'no consta ninguno'
    return {
      confirmation: 'money',
      spend: 'core',
      // Every rule the run and its final revalidation depend on: a change of dates or keywords makes the token stale
      fingerprint: JSON.stringify({
        members: s.members.length,
        hashtags,
        accounts,
        keywords,
        platforms: s.platforms,
        status: s.status,
        startDate: s.startDate,
        endDate: s.endDate,
        revalidation: revalidationFingerprint(projected),
      }),
      preview:
        `Vas a lanzar «Rastrear ahora» en ${named(s.name)}: ${plural(s.members.length, 'integrante', 'integrantes')} (una lectura de perfil cada una), ` +
        `${plural(hashtags.length, 'hashtag', 'hashtags')} en ${plural(s.platforms.length, 'red', 'redes')}, ${plural(accounts.length, 'cuenta de marca', 'cuentas de marca')} (menciones)` +
        `${igMembers > 0 ? ' y la lectura de stories de Instagram' : ''}; además se sincronizan las conexiones de Instagram de marca. ` +
        `Es la acción que más Apify consume (${usageText(apify)}). Puede durar varios minutos y sigue en el servidor aunque Claude deje de esperar. ` +
        'Al terminar se revalida la campaña con las reglas de ahora: con los datos de este momento no saldría ninguna pieza. ' +
        `Último rastreo registrado: ${lastText}. ¿Confirmas?`,
    }
  },
  async execute(args, ctx) {
    const s = await readCampaign(ctx, args.campaignId)
    // Checked and marked in one synchronous step: two confirmed calls never launch two runs
    refuseIfNotTrackable(s)
    inFlight.set(s.id, Date.now())
    const out = await attempt(ctx, { method: 'POST', path: `/api/campaigns/${s.id}/track`, timeoutMs: TRACK_WAIT_MS })
    if (out.ok) {
      inFlight.delete(s.id)
      const summary = asObject(out.json.summary)
      const meta = asObject(summary.metaSync)
      const revalidation = asObject(summary.revalidation)
      return {
        launched: true,
        finished: true,
        campaign: { id: s.id, name: shortText(s.name, 120) },
        targetsConfigured: summary.targetsConfigured === true,
        postsFromHashtags: asNumber(summary.postsFromHashtags),
        postsFromMentions: asNumber(summary.postsFromMentions),
        memberPostsCaptured: asNumber(summary.memberPostsCaptured),
        storiesCaptured: asNumber(summary.storiesCaptured),
        storyError: shortText(summary.storyError, 300),
        metaSync: { connections: asNumber(meta.connections), media: asNumber(meta.media), stories: asNumber(meta.stories), mentions: asNumber(meta.mentions) },
        revalidation: { kept: asNumber(revalidation.kept), detached: asNumber(revalidation.detached) },
        errors: asArray(asObject(out.json.results).errors)
          .slice(0, 10)
          .map(e => shortText(e, 300)),
      }
    }
    if (out.timeout) {
      return {
        launched: true,
        finished: false,
        campaign: { id: s.id, name: shortText(s.name, 120) },
        message: `«Rastrear ahora» sigue en marcha en el servidor. No lo relances: en unos minutos consulta las cifras con get_campaign o list_campaign_media. Este conector no lanzará otro en esta campaña durante ${TRACK_IN_FLIGHT_MS / 60_000} minutos.`,
      }
    }
    inFlight.delete(s.id)
    throw new ToolError(out.message)
  },
})

// =====================================================================
// sync_instagram_connection
// =====================================================================

export const syncInstagramConnection = defineWriteTool({
  name: 'sync_instagram_connection',
  title: 'Sincronizar una cuenta de Instagram de marca',
  description:
    "Runs the manual 'Sincronizar' of one connected Instagram brand account: reads profile, media, insights, stories and tagged posts from Meta and pushes the new content into every active campaign it belongs to. " +
    'Use when a tagged post or a story mention of a client is missing. It takes up to about two minutes and may spend a small, bounded Apify views read. ' +
    "Only the admin's own connections, as listed by GET /api/meta/connections: read that list with platform_request (method GET, path /api/meta/connections) to get the id. " +
    'It does NOT connect, reconnect or disconnect accounts and never exposes tokens: connection management stays in Ajustes > Integraciones.',
  input: { connectionId: idInput('The connection id, from GET /api/meta/connections (read it with platform_request).') },
  confirmations: ['money'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  summarize: a => ({ connectionId: a.connectionId }),
  async plan(args, ctx) {
    const connections = asArray(asObject(await ctx.platformJson({ method: 'GET', path: '/api/meta/connections' })).connections).map(asObject)
    const conn = connections.find(c => asString(c.id) === args.connectionId)
    if (!conn) {
      throw new ToolError(
        'Esa conexión no está entre tus cuentas de Instagram conectadas: solo se pueden sincronizar las tuyas (las lista GET /api/meta/connections). No se ha hecho nada.',
      )
    }
    const igUsername = asString(asObject(conn.account).igUsername)
    const account = igUsername ? at(igUsername) : 'sin nombre'
    if (conn.isValid !== true) {
      throw new ToolError(`La conexión de ${account} está desconectada: hay que reconectarla en Ajustes > Integraciones. No se ha hecho nada.`)
    }
    const apify = await ctx.apifyStatus()
    return {
      confirmation: 'money',
      spend: 'core',
      fingerprint: JSON.stringify({ id: args.connectionId }),
      preview:
        `Vas a sincronizar la cuenta de Instagram ${account} con Meta: se leen sus publicaciones, stories y contenidos etiquetados y se vuelcan en todas las campañas activas que correspondan (sus cifras e informes pueden cambiar). ` +
        `Puede gastar una lectura pequeña de Apify para las vistas de algunas publicaciones (${usageText(apify)}). Tarda hasta 2 minutos. ¿Confirmas?`,
    }
  },
  async execute(args, ctx) {
    const out = await attempt(ctx, { method: 'POST', path: `/api/meta/sync/${args.connectionId}`, timeoutMs: 190_000 })
    if (!out.ok) {
      if (out.timeout) throw new ToolError(UNKNOWN_AFTER_TIMEOUT)
      const said = shortText(out.json.error, 300)
      throw new ToolError(said ? `No se ha podido sincronizar: ${said}` : out.message)
    }
    const materialized = asObject(out.json.materialized)
    return {
      synced: true,
      connectionId: args.connectionId,
      read: { snapshots: asNumber(out.json.snapshots), media: asNumber(out.json.media), stories: asNumber(out.json.stories), mentions: asNumber(out.json.mentions) },
      pushedToCampaigns: { created: asNumber(materialized.created), updated: asNumber(materialized.updated), campaignsChecked: asNumber(materialized.campaigns) },
      ...(shortText(out.json.warning, 300) ? { warning: shortText(out.json.warning, 300) } : {}),
    }
  },
})

// =====================================================================
// Registration
// =====================================================================

export const TRACKING_WRITE_TOOLS: readonly WriteTool[] = [launchCampaignTracking, syncInstagramConnection]

/** Hands every tracking write tool to `register` (server.ts: server.registerTool with writeToolConfig). */
export function registerTrackingWriteTools(register: (tool: WriteTool) => void): void {
  for (const tool of TRACKING_WRITE_TOOLS) register(tool)
}

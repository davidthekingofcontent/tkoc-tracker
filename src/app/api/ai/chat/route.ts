import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db'
import { dedupeMediaByPost } from '@/lib/campaign-capture'
import { getSession } from '@/lib/auth'
import { PLATFORM_KNOWLEDGE } from '@/lib/ai-knowledge'

// Anthropic calls can take a while; make sure the route isn't cut short.
export const runtime = 'nodejs'
export const maxDuration = 60

const PRIMARY_MODEL = 'claude-sonnet-5'
const FALLBACK_MODEL = 'claude-sonnet-4-5'
const MAX_HISTORY_MESSAGES = 30
const MAX_MESSAGE_CHARS = 8000
const MAX_OUTPUT_TOKENS = 4096

type ChatRole = 'user' | 'assistant'
interface IncomingMessage {
  role: ChatRole
  content: string
}
interface ChatRequestBody {
  messages?: IncomingMessage[]
  locale?: string
}

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return null
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 55_000 })
}

/**
 * Normalize the widget's history into a valid Anthropic message list:
 * only user/assistant roles, non-empty strings, capped length, first
 * message must be from the user.
 */
function sanitizeMessages(raw: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(raw)) return []
  const cleaned: Anthropic.MessageParam[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { role, content } = item as Partial<IncomingMessage>
    if (role !== 'user' && role !== 'assistant') continue
    if (typeof content !== 'string') continue
    const text = content.trim().slice(0, MAX_MESSAGE_CHARS)
    if (!text) continue
    cleaned.push({ role, content: text })
  }
  // Keep only the most recent turns, but never start with an assistant turn.
  let recent = cleaned.slice(-MAX_HISTORY_MESSAGES)
  while (recent.length > 0 && recent[0].role !== 'user') recent = recent.slice(1)
  return recent
}

async function gatherPlatformContext() {
  const [activeCampaigns, influencerCount, allAttachedMedia, campaigns, topInfluencers, recentMediaRaw] =
    await Promise.all([
      prisma.campaign.count({ where: { status: 'ACTIVE' } }),
      prisma.influencer.count(),
      // One row per (post, campaign): the assistant reports DISTINCT posts
      prisma.media.findMany({
        where: { campaignId: { not: null } },
        select: { id: true, externalId: true, platform: true, permalink: true },
      }),
      prisma.campaign.findMany({
        where: { status: { not: 'ARCHIVED' } },
        select: {
          name: true,
          type: true,
          status: true,
          platforms: true,
          startDate: true,
          endDate: true,
          targetAccounts: true,
          targetHashtags: true,
          objective: true,
          paymentType: true,
          _count: { select: { influencers: true, media: true } },
          influencers: {
            take: 8,
            select: {
              status: true,
              agreedFee: true,
              influencer: {
                select: { username: true, platform: true, followers: true, engagementRate: true },
              },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      prisma.influencer.findMany({
        where: { followers: { gt: 0 } },
        orderBy: { followers: 'desc' },
        take: 15,
        select: {
          username: true,
          platform: true,
          followers: true,
          engagementRate: true,
          avgLikes: true,
          avgComments: true,
          avgViews: true,
          country: true,
          lastScraped: true,
        },
      }),
      prisma.media.findMany({
        orderBy: { postedAt: 'desc' },
        take: 60,
        select: {
          id: true,
          externalId: true,
          platform: true,
          permalink: true,
          mediaType: true,
          source: true,
          likes: true,
          comments: true,
          views: true,
          shares: true,
          saves: true,
          hashtags: true,
          postedAt: true,
          influencer: { select: { username: true, platform: true } },
          campaign: { select: { name: true } },
        },
      }),
    ])

  const mediaCount = dedupeMediaByPost(allAttachedMedia).length
  const recentMedia = dedupeMediaByPost(recentMediaRaw).slice(0, 25)

  return {
    overview: { activeCampaigns, totalInfluencers: influencerCount, totalMedia: mediaCount },
    campaigns: campaigns.map(c => ({
      name: c.name,
      type: c.type,
      status: c.status,
      platforms: c.platforms,
      objective: c.objective,
      paymentType: c.paymentType,
      startDate: c.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: c.endDate?.toISOString().slice(0, 10) ?? null,
      targetAccounts: c.targetAccounts,
      targetHashtags: c.targetHashtags,
      influencerCount: c._count.influencers,
      mediaCount: c._count.media,
      members: c.influencers.map(ci => ({
        username: ci.influencer.username,
        platform: ci.influencer.platform,
        followers: ci.influencer.followers,
        engagementRate: ci.influencer.engagementRate,
        status: ci.status,
        agreedFee: ci.agreedFee,
      })),
    })),
    topInfluencers: topInfluencers.map(i => ({
      ...i,
      lastScraped: i.lastScraped?.toISOString().slice(0, 10) ?? null,
    })),
    recentMedia: recentMedia.map(m => ({
      type: m.mediaType,
      source: m.source,
      likes: m.likes,
      comments: m.comments,
      views: m.views,
      shares: m.shares,
      saves: m.saves,
      hashtags: m.hashtags,
      postedAt: m.postedAt?.toISOString().slice(0, 10) ?? null,
      influencer: m.influencer.username,
      platform: m.influencer.platform,
      campaign: m.campaign?.name ?? null,
    })),
  }
}

const ASSISTANT_ROLE = `
# Tu rol
Eres TKOC AI, el asistente integrado en TKOC Intelligence. Ayudas al equipo de la agencia a USAR la herramienta y a interpretar sus datos.

Cómo respondes:
- Responde en el idioma del usuario. Si escribe en español (o no está claro), responde en español.
- Cuando expliquen cómo hacer algo, da pasos numerados y concretos usando los nombres EXACTOS de páginas, pestañas y botones que aparecen en la guía (por ejemplo: Campañas → "Nueva Campaña"; pestaña "Elegir"; botón "Rastrear Ahora"; Ajustes → Integraciones → "Conectar con Facebook").
- Sé conciso: lo justo para resolver la duda. Sin introducciones ni despedidas de relleno.
- Usa Markdown ligero (negritas, listas). Nada de tablas enormes.
- Cuando el usuario diga que "no funciona" algo o "no aparece contenido", guíale por la lista de comprobación de la sección 13 de la guía antes de suponer un fallo.
- Para preguntas sobre rendimiento, usa los "Datos actuales" adjuntos; cita cifras reales y no inventes datos. Si faltan datos, dilo y explica cómo conseguirlos en la herramienta. Referencias: engagement > 3 % es bueno, > 5 % excelente.
- No puedes ejecutar acciones (crear, editar, borrar, rastrear): explica cómo hacerlas el usuario. Nunca afirmes haber hecho un cambio.
- Si preguntan por algo que la plataforma no tiene, dilo claramente y sugiere la alternativa más cercana que sí existe. No inventes funcionalidades.
`.trim()

function buildSystemPrompt(input: {
  userName: string
  userRole: string
  locale?: string
  platformData: unknown | null
  dataError: boolean
}): Anthropic.TextBlockParam[] {
  const today = new Date().toISOString().slice(0, 10)
  const dataSection = input.platformData
    ? `# Datos actuales de la plataforma (JSON)\n${JSON.stringify(input.platformData)}`
    : input.dataError
      ? '# Datos actuales de la plataforma\nNo se han podido cargar los datos en esta petición; responde solo con la guía y dilo si te preguntan por cifras.'
      : ''

  return [
    // Static, cacheable block: the knowledge base + role never change between requests.
    {
      type: 'text',
      text: `${PLATFORM_KNOWLEDGE}\n\n${ASSISTANT_ROLE}`,
      cache_control: { type: 'ephemeral' },
    },
    // Dynamic block: who is asking and what the data looks like right now.
    {
      type: 'text',
      text: [
        '# Contexto de esta conversación',
        `- Fecha de hoy: ${today}`,
        `- Usuario: ${input.userName} (rol ${input.userRole})`,
        input.locale ? `- Idioma de la interfaz: ${input.locale}` : null,
        '',
        dataSection,
      ]
        .filter(v => v !== null)
        .join('\n'),
    },
  ]
}

function isModelNotFound(error: unknown): boolean {
  if (error instanceof Anthropic.NotFoundError) return true
  if (error instanceof Anthropic.BadRequestError) {
    return /model/i.test(error.message) && /not (found|supported|available)|invalid|unknown/i.test(error.message)
  }
  return false
}

/**
 * Call the primary model; if the API says the model doesn't exist, retry once
 * with the fallback model. Effort control is only sent to the primary model
 * (older models reject `output_config.effort`).
 */
async function createWithFallback(
  client: Anthropic,
  params: { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] }
): Promise<{ response: Anthropic.Message; model: string }> {
  try {
    const response = await client.messages.create({
      model: PRIMARY_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: 'low' },
      system: params.system,
      messages: params.messages,
    })
    return { response, model: PRIMARY_MODEL }
  } catch (error) {
    if (!isModelNotFound(error)) throw error
    console.warn(`[AI chat] Model ${PRIMARY_MODEL} not available, retrying with ${FALLBACK_MODEL}`)
    const response = await client.messages.create({
      model: FALLBACK_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: params.system,
      messages: params.messages,
    })
    return { response, model: FALLBACK_MODEL }
  }
}

/** Map SDK errors to a readable Spanish message + HTTP status for the widget. */
function describeError(error: unknown): { status: number; message: string; code: string } {
  if (error instanceof Anthropic.AuthenticationError) {
    return { status: 500, code: 'auth', message: 'La clave de API de Anthropic no es válida. Revisa ANTHROPIC_API_KEY en el servidor.' }
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { status: 500, code: 'permission', message: 'La clave de API de Anthropic no tiene permiso para usar este modelo.' }
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { status: 429, code: 'rate_limit', message: 'Límite de peticiones de Anthropic alcanzado. Espera unos segundos y vuelve a intentarlo.' }
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { status: 502, code: 'model_not_found', message: `Ninguno de los modelos configurados (${PRIMARY_MODEL}, ${FALLBACK_MODEL}) está disponible para esta cuenta.` }
  }
  if (error instanceof Anthropic.BadRequestError) {
    if (/credit balance|billing/i.test(error.message)) {
      return { status: 402, code: 'billing', message: 'La cuenta de Anthropic no tiene crédito disponible. Añade saldo en console.anthropic.com.' }
    }
    return { status: 400, code: 'bad_request', message: `Petición rechazada por Anthropic: ${error.message}` }
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { status: 504, code: 'timeout', message: 'Anthropic ha tardado demasiado en responder. Inténtalo de nuevo.' }
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { status: 502, code: 'connection', message: 'No se ha podido conectar con Anthropic. Comprueba la red del servidor e inténtalo de nuevo.' }
  }
  if (error instanceof Anthropic.APIError) {
    return { status: 502, code: 'api', message: `Error de Anthropic (${error.status ?? '?'}): ${error.message}` }
  }
  const message = error instanceof Error ? error.message : 'Error interno'
  return { status: 500, code: 'internal', message: `Error interno del asistente: ${message}` }
}

export async function POST(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'No has iniciado sesión.', code: 'unauthenticated' }, { status: 401 })
  }
  // The assistant exposes cross-campaign platform data: agency staff only.
  if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
    return NextResponse.json({ error: 'El asistente solo está disponible para el equipo de la agencia.', code: 'forbidden' }, { status: 403 })
  }

  const client = getAnthropicClient()
  if (!client) {
    return NextResponse.json(
      { error: 'El asistente de IA no está configurado: falta ANTHROPIC_API_KEY en el servidor.', code: 'not_configured' },
      { status: 503 }
    )
  }

  let body: ChatRequestBody
  try {
    body = (await request.json()) as ChatRequestBody
  } catch {
    return NextResponse.json({ error: 'Cuerpo de la petición inválido (se esperaba JSON).', code: 'bad_body' }, { status: 400 })
  }

  const messages = sanitizeMessages(body.messages)
  if (messages.length === 0) {
    return NextResponse.json({ error: 'Escribe un mensaje para empezar.', code: 'empty' }, { status: 400 })
  }

  // Platform data is helpful context but must never block the assistant.
  let platformData: unknown | null = null
  let dataError = false
  try {
    platformData = await gatherPlatformContext()
  } catch (error) {
    dataError = true
    console.error('[AI chat] Failed to gather platform context:', error)
  }

  const system = buildSystemPrompt({
    userName: session.name,
    userRole: session.role,
    locale: typeof body.locale === 'string' ? body.locale.slice(0, 5) : undefined,
    platformData,
    dataError,
  })

  try {
    const { response, model } = await createWithFallback(client, { system, messages })

    if (response.stop_reason === 'refusal') {
      return NextResponse.json(
        { error: 'El modelo ha rechazado responder a esta petición.', code: 'refusal' },
        { status: 422 }
      )
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()

    if (!text) {
      return NextResponse.json(
        { error: 'El modelo ha devuelto una respuesta vacía. Inténtalo de nuevo.', code: 'empty_response' },
        { status: 502 }
      )
    }

    return NextResponse.json({
      message: text,
      model,
      truncated: response.stop_reason === 'max_tokens',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    })
  } catch (error) {
    const described = describeError(error)
    console.error(`[AI chat] ${described.code}:`, error)
    return NextResponse.json({ error: described.message, code: described.code }, { status: described.status })
  }
}

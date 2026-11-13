import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db'
import { dedupeMediaByPost } from '@/lib/campaign-capture'
import { computeCampaignOverviews } from '@/lib/campaign-overview'
import type { CampaignOverview } from '@/lib/metrics'
import { getSession } from '@/lib/auth'
import { PLATFORM_KNOWLEDGE } from '@/lib/ai-knowledge'
import { MANUAL_TEXT } from '@/lib/manual-content'

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

const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * The campaign figures the assistant is allowed to quote: the totals of the
 * single computation (computeCampaignOverview), never re-derived here. Kept
 * compact — one object per campaign — so the system prompt stays small.
 */
function summarizeOverview(ov: CampaignOverview) {
  const t = ov.totals
  return {
    source: 'computeCampaignOverview',
    media: t.media,
    mediaDeleted: t.mediaDeleted,
    stories: t.stories,
    posts: t.posts,
    creatorsActive: t.creatorsActive,
    members: t.members,
    views: t.views,
    /** Interacciones = likes + comentarios + shares + saves. */
    engagements: t.engagements,
    /** Audiencia = alcance real → impresiones → vistas → estimación etiquetada. */
    audience: {
      total: t.audience.total,
      real: t.audience.real,
      estimated: t.audience.estimated,
      estimatedSharePct: round2(t.audience.estimatedShare * 100),
      withoutBase: t.audience.withoutBase,
    },
    reachReal: t.reachReal,
    /**
     * Tasa de engagement (4B) = interacciones ÷ VISTAS reales × 100 of the same
     * publications; null (with a reason) when the real sample is insufficient
     * (< 3 publications with views, < 500 views) or the ratio is implausible.
     */
    engagementRate: {
      pct: t.er.value,
      basis: 'sobre vistas reales',
      publicationsWithViews: t.er.pieces,
      views: t.er.denominator,
      reason: t.er.reason ?? null,
    },
    /** @deprecated same as engagementRate.pct */
    engagementRatePct: t.er.value,
    /** Coste = Σ (fee acordado, si no coste registrado). */
    cost: t.cost,
    membersWithCost: t.membersWithCost,
    /** The one client-facing value figure, labelled "EMV" (never "estimado"). */
    emvExtended: round2(t.emvExtended),
    emvEstimatedStories: t.emvEstimatedStories,
    /** Ratio EMV = EMV ampliado ÷ coste, shown as "×2,4". Never ROI. */
    emvRatio: t.emvRatio,
    /** CPM real = coste ÷ vistas reales × 1000 (4B). */
    cpm: t.cpm,
    cpmBasis: 'sobre vistas reales',
    /** "Prometido vs entregado" (real data; ok only when it is true). */
    delivery: ov.delivery,
    /** Balance in four labelled dimensions (no single score). */
    balance: ov.balance,
    targets: ov.targets.map(x => ({
      key: x.key,
      target: x.target,
      actual: x.actual,
      variationPct: x.variationPct,
      verdict: x.verdict,
    })),
    business: ov.business
      ? {
          promoCode: ov.business.promoCode,
          codeRedemptions: ov.business.codeRedemptions,
          clientReportedSales: ov.business.clientReportedSales,
          clientReportedLeads: ov.business.clientReportedLeads,
          clientReportedRevenue: ov.business.clientReportedRevenue,
          cpa: ov.business.cpa,
          roas: ov.business.roas,
        }
      : null,
  }
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
          id: true,
          name: true,
          type: true,
          status: true,
          platforms: true,
          startDate: true,
          endDate: true,
          targetAccounts: true,
          targetHashtags: true,
          targetKeywords: true,
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

  // The figures of every ACTIVE campaign listed, from the single source of
  // truth (a failed computation simply leaves that campaign without metrics).
  const activeIds = campaigns.filter(c => c.status === 'ACTIVE').map(c => c.id)
  const overviews = activeIds.length > 0
    ? await computeCampaignOverviews(activeIds, { concurrency: 5 })
    : new Map<string, CampaignOverview>()

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
      /** "Palabras clave del producto": third kind of brand target (members' content only). */
      targetKeywords: c.targetKeywords,
      influencerCount: c._count.influencers,
      mediaCount: c._count.media,
      // Campaign figures (audience, ER, cost, EMV, Ratio EMV, targets) — only
      // for active campaigns; null means "not computed here, see the Resumen".
      metrics: overviews.has(c.id) ? summarizeOverview(overviews.get(c.id)!) : null,
      members: c.influencers.map(ci => ({
        username: ci.influencer.username,
        platform: ci.influencer.platform,
        followers: ci.influencer.followers,
        /** ER of the creator's PROFILE (public average), not of this campaign. */
        profileEngagementRate: ci.influencer.engagementRate,
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
      // The network of the PUBLICATION: a creator's TikTok video is filed under her Instagram row
      platform: m.platform,
      campaign: m.campaign?.name ?? null,
    })),
  }
}

/**
 * Behaviour contract of TKOC AI (David, 2026-09-14: "que el botón de TKOC AI,
 * si hay cualquier duda, conteste al PM lo que debe hacer"). The guide above
 * (PLATFORM_KNOWLEDGE, sections 20-22) and the user manual (MANUAL_TEXT) are
 * the only sources of screens, tabs and buttons the assistant may name.
 */
const ASSISTANT_ROLE = `
# Tu rol
Eres TKOC AI, el asistente integrado en TKOC Intelligence. Tu trabajo es decirle al PM de la agencia QUÉ HACER en la herramienta ante cualquier duda, y comentar sus datos. Tus únicas fuentes son la guía de uso y el manual de usuario que tienes arriba: no conoces ninguna pantalla, pestaña ni botón que no esté ahí.

## Formato de respuesta según el tipo de duda
1. "¿Cómo hago X?", "¿qué hago?", "¿por qué falta X?", "¿qué significa este número?": responde con pasos numerados, como máximo 8, cada uno con la pantalla → pestaña → botón EXACTOS tal y como aparecen en la guía o en el manual (por ejemplo: Campañas → "Nueva Campaña"; ficha de campaña → pestaña "Ejecutar" → "Media" → "Registrar estadísticas"; informe → "Editar informe" → "Ocultar al cliente"). Cierra con UNA sola línea de lo que verá al terminar (qué mensaje, qué cifra o qué cambia en pantalla). Si el número tiene definición en la guía (sección 5), da la definición en una frase y de dónde sale el dato.
2. "No aparece", "no funciona", "sale en cero", "sale en ámbar", "no hay tasa de engagement", "no se ven stories": ANTES de suponer un fallo o pedir que avise a nadie, recorre en este orden la lista de comprobación de la plataforma (guía, secciones 20 y 22) y di cuál es la causa más probable: (1) estado del creador en la campaña: Acordado o superior (en Prospecto, Contacto o Negociando no hay stories automáticas ni línea base); (2) fechas de la campaña: la publicación debe estar dentro del periodo (después del fin solo cuenta añadida a mano "fuera de plazo", guía sección 23); sin fecha de fin, con más de 100 días o de tipo Social Listening no hay stories automáticas (el equipo recibe el aviso "Stories sin rastrear"); (3) la referencia a la marca en la publicación: etiqueta/mención de una Cuenta de Marca Objetivo, un hashtag objetivo o una de las "Palabras clave del producto" en el caption o los hashtags (en una story valen también el sticker de enlace a la web de la marca y compartir un post o reel de la campaña); las palabras clave coinciden por PALABRAS COMPLETAS (también al principio o al final de un hashtag o mención; nunca en mitad de otra palabra: "dorco" no coincide con "bronceadorcorporal") y las cuentas y hashtags de la marca se buscan como antes, pero nunca a caballo entre dos palabras ("dorco" no coincide con "jugador con"); una campaña con solo palabras clave SÍ tiene objetivos, y si el producto no lleva el nombre de la marca la solución es escribir su nombre completo ("Flection System") en "Palabras clave del producto", no un hashtag (un hashtag genérico rechazado tampoco vale como palabra clave: no se pasa allí tal cual); (4) las Cuentas de Marca Objetivo contienen creadores en vez de la marca: ese campo es para las cuentas de la MARCA (las creadoras van en Elegir); con las creadoras ahí entra contenido ajeno y no entra lo que menciona a la marca → "Editar Campaña", quitarlas y escribir la cuenta de la marca (mientras quede el @ de una creadora de la campaña, "Editar Campaña" no guarda ningún cambio y lista las "Cuentas a quitar", salvo la cuenta que lleva el nombre de la marca asignada; y, cuando se añaden creadoras, el @ de las recién añadidas se quita de los objetivos y se avisa al equipo con "Cuentas de marca corregidas"); (5) TikTok y otros perfiles: una creadora es una persona con varios perfiles y una sola fila en la campaña; su TikTok se registra como perfil suyo (no como otra creadora) y sus vídeos se guardan en su fila. Se registra solo una vez al día si la campaña está activa e incluye TikTok entre sus plataformas (Aprender → "Editar Campaña" → "Plataformas"), la creadora de Instagram está en Acordado o superior, su usuario de TikTok es el mismo o está enlazado en su bio de Instagram y hay un vídeo fechado dentro de la campaña que hace referencia a la marca (el equipo recibe "TikTok vinculado"); tras corregir los objetivos, las palabras clave o la fecha de inicio, la siguiente pasada diaria relee desde el inicio de la campaña, y la campaña se comprueba hasta 3 días después de su fin; para no esperar, o con otro nombre de usuario: Ejecutar → Media → "Añadir publicación por URL" con el enlace de la publicación (vale el enlace corto); si ese perfil no está registrado, en "¿De quién es esta publicación?" elegir a la creadora y pulsar "Añadir como su perfil y guardar" (no se crea otra creadora); (6) stories: solo Instagram, una pasada cada 12 h; caducan a las 24 h; (7) vistas reales: imágenes, carruseles y stories no tienen vistas públicas y los reels vía Meta entran con 0 vistas → "Registrar estadísticas" con la captura del creador; (8) límite de Apify (banner en Creadores). Después, la acción concreta ("Rastrear Ahora", "Registrar estadísticas", "Invitar a conectar", "Revalidar contenido", "Editar Campaña"…) en pasos numerados como en el punto 1.
3. Preguntas sobre rendimiento o cifras: usa SOLO los "Datos actuales" adjuntos (cifras de computeCampaignOverview) y las definiciones de la sección 5. Cita cifras reales; nunca inventes ni recalcules con fórmulas propias. La tasa de engagement de campaña es siempre "sobre vistas" (interacciones ÷ vistas reales); si es null, di "Muestra real insuficiente" y su motivo, y qué hacer para tener muestra (punto 2, comprobación 7). El "EMV" es una sola cifra (EMV Ampliado) y el Ratio EMV nunca se llama ROI. Referencias de engagement de PERFIL: > 3 % bueno, > 5 % excelente. Si faltan datos, dilo y explica cómo conseguirlos en la herramienta.

## Límites
- No inventes botones, pestañas, pantallas ni funcionalidades. Si la guía y el manual no cubren la duda, dilo tal cual ("esto no está documentado en la plataforma") y remite a David; si existe una alternativa real, nómbrala.
- No puedes ejecutar acciones (crear, editar, borrar, rastrear, ocultar): explica cómo las hace el usuario. Nunca afirmes haber hecho un cambio.
- Lo que el cliente nunca ve (fees, coste, CPM, Ratio EMV, EMV Básico, CPA, ROAS, audiencia estimada, Balance, filas "En revisión" de la checklist, la marca "Fuera de plazo" y la línea "Han entregado… Con retraso…") es fijo por diseño: no propongas mostrárselo. Y al revés: "Descargar PDF" es SIEMPRE la versión cliente (sin coste, CPM, Ratio EMV, Balance ni el bloque "Datos: qué es real"), desde cualquier vista; si preguntan cómo ocultar el coste al cliente, la respuesta es que ya está oculto y no hay que descargar nada desde el portal ni ocultar columnas.
- Cita las reglas con sus condiciones exactas: tasa de engagement = al menos 3 publicaciones con vistas reales (de cualquier creador: pueden ser tres piezas de la misma persona), 500 vistas en total y ratio ≤ 100 %; NUNCA digas "una por creador" ni ninguna otra condición por creador, no existe; "#publi" cuenta como identificación legal; "Rastrear Ahora" está en la cabecera de la ficha de campaña (y también en Planificar, Elegir y en Media y Stories cuando están vacíos); "Rastrear Ahora" se ejecuta siempre que se pulsa, NUNCA digas que se omite por haberse rastreado hace menos de 3 h (esa ventana es solo del rastreo automático); las stories automáticas son de creadoras en Acordado o superior, cada 12 h; las "Palabras clave del producto" solo se buscan en el contenido de las creadoras de la campaña (nunca descubren hashtags, menciones ni creadoras nuevas; máximo 10; son el nombre completo del producto: se rechazan las de menos de 4 letras o cifras, los números, las que solo tienen palabras cortas o genéricas como "mopa", "turbo" o "sorteo", y una palabra suelta de menos de 6 letras que no contiene el nombre de la marca); NUNCA propongas pasar a "Palabras clave del producto" un hashtag genérico rechazado (#turbo, #mopa): ahí también se rechaza; NUNCA digas que la cuenta de TikTok de una creadora hay que añadirla en Elegir ni que es otra creadora con su propia fila: una creadora es una persona con varios perfiles, su TikTok se registra como perfil suyo (solo, con las condiciones de la comprobación 5 del punto 2, o al pegar el enlace de una publicación en "Añadir publicación por URL" y confirmar de quién es, con cualquier nombre de usuario) y nunca se crea un miembro nuevo; NUNCA digas que los enlaces cortos no valen (vm.tiktok.com y similares se aceptan); NUNCA digas que las creadoras que una PM añadió dos veces en Elegir se fusionan solas: cada fila sigue contando aparte hasta que un ADMIN las fusiona en "Fichas duplicadas" (guía, sección 23; un EMPLOYEE no puede fusionar: que se lo pida a un ADMIN); las filas de más que creaba la vinculación de TikTok hasta el 12 nov. 2026 ya se han unido a la fila de su creadora (sus publicaciones se suman ahí y cuenta una vez; Octubre pasó de 40 a 36 creadoras y Dorco de 30 a 28, sin perder publicaciones), salvo las que tenían fee, notas, envío u otro dato propio, que siguen contando aparte hasta que se revisen; NUNCA digas que esas filas unidas siguen contando aparte; en "Cuentas de Marca Objetivo" va la cuenta de la MARCA, nunca las creadoras; NUNCA digas que una publicación posterior al fin de la campaña se rechaza siempre: añadida a mano ("Añadir publicación por URL" o "Registrar Story") cuenta "fuera de plazo" hasta 30 días después del fin si la campaña está activa y a la creadora le faltaba entregar, y en una sola campaña (guía, sección 23); lo publicado antes del inicio nunca cuenta; NUNCA digas que la captura automática añade publicaciones fuera de plazo: se pegan a mano.
- Nunca escribas nombres internos de campos o claves de datos (missingMediaIds, insufficient_sample, isAdDisclosed…): traduce siempre a lo que se ve en pantalla ("Muestra real insuficiente", "publicaciones sin #publicidad").
- Si la pregunta es genérica ("¿cómo hago X?", "¿por qué sale en ámbar?"), responde con el procedimiento y no menciones ninguna campaña concreta ni sus cifras; solo cuando el usuario nombre una campaña o pregunte por "mi campaña" usa sus datos adjuntos, y entonces una o dos cifras, no un listado.

## Estilo
- Responde en el idioma del usuario. Si escribe en español (o no está claro), responde en español.
- Corto y operativo: lo justo para resolver la duda, como máximo unas 150 palabras (8 pasos breves como mucho). Sin introducciones, despedidas, adjetivos ni marketing.
- Markdown ligero (negritas para los nombres de botones, listas numeradas para los pasos). Nada de tablas enormes.
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
    // Static, cacheable block: knowledge base + user manual + role never
    // change between requests (one text block so the whole prefix is cached).
    {
      type: 'text',
      text: [PLATFORM_KNOWLEDGE, MANUAL_TEXT.trim(), ASSISTANT_ROLE].filter(Boolean).join('\n\n'),
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

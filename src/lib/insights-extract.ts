/**
 * INSIGHTS EXTRACT — reads the numbers out of a creator's insights screenshot
 * (Instagram / TikTok / YouTube "Estadísticas") with Claude vision and returns a
 * PROPOSAL the PM confirms before anything is stored (decision 2026-09-05,
 * point 3: real data first, with provenance).
 *
 * Server-only (uses ANTHROPIC_API_KEY). Never throws to the caller: every
 * failure comes back as { ok: false, code, error }.
 */

import Anthropic from '@anthropic-ai/sdk'

// Same models as the AI assistant (src/app/api/ai/chat/route.ts) — one model
// policy for the whole product; the fallback only fires when the primary id is
// unknown to the account.
const PRIMARY_MODEL = 'claude-sonnet-5'
const FALLBACK_MODEL = 'claude-sonnet-4-5'
const MAX_OUTPUT_TOKENS = 2048

/** Hard cap on the decoded image (the UI downsizes screenshots well below this). */
export const INSIGHTS_IMAGE_MAX_BYTES = 6 * 1024 * 1024
export const INSIGHTS_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type InsightsImageMimeType = (typeof INSIGHTS_IMAGE_MIME_TYPES)[number]

export function isInsightsImageMimeType(value: unknown): value is InsightsImageMimeType {
  return typeof value === 'string' && (INSIGHTS_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

/** The numeric fields a screenshot can carry. All optional: null = not visible. */
export const INSIGHT_NUMERIC_KEYS = [
  'reach',
  'impressions',
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'storyReplies',
  'linkTaps',
] as const
export type InsightNumericKey = (typeof INSIGHT_NUMERIC_KEYS)[number]

export type ExtractedInsights = Record<InsightNumericKey, number | null> & {
  /** Overall confidence of the reading, 0–1. */
  confidence: number
  /** Short remark about ambiguities (in the requested locale) or null. */
  notes: string | null
}

export type ExtractInsightsErrorCode =
  | 'not_configured'
  | 'invalid_image'
  | 'too_large'
  | 'refusal'
  | 'unparseable'
  | 'rate_limit'
  | 'api'

export type ExtractInsightsResult =
  | { ok: true; data: ExtractedInsights; model: string }
  | { ok: false; code: ExtractInsightsErrorCode; error: string }

export interface ExtractInsightsInput {
  /** Base64 payload (a data-URL prefix is tolerated and stripped). */
  imageBase64: string
  /** MIME type of the image: jpeg, png or webp. */
  mimeType: string
  /** Publication type as stored on Media (REEL, POST, STORY, CAROUSEL, VIDEO, SHORT…). */
  mediaType?: string | null
  /** Platform as stored on Media (INSTAGRAM, TIKTOK, YOUTUBE). */
  platform?: string | null
  /** Language of the `notes` remark; Spanish by default. */
  locale?: 'es' | 'en' | string | null
}

// ============ NUMBER NORMALISATION ============

const SUFFIX_MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(mil\s*millones|mil\s*m|b|bn|mm)$/i, 1_000_000_000],
  [/^(m|mill|millones|millón|million|millions)$/i, 1_000_000],
  [/^(mil|k)$/i, 1_000],
]

/**
 * Turns whatever the model (or a person) wrote into a non-negative integer:
 *   "12,3 mil" → 12300 · "45,6 K" → 45600 · "1,2 M" → 1200000 · "1.234" → 1234
 *   "1,234" → 1234 · "12,3" → 12 (rounded) · 987 → 987 · "—" / "" / -5 → null
 * Thousands vs decimal separator: a separator followed by exactly three digits
 * (every group) is a thousands separator; otherwise it is the decimal mark.
 */
export function parseCountValue(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
  }
  if (typeof value !== 'string') return null

  let text = value.replace(/ /g, ' ').trim().toLowerCase()
  if (!text || text === '—' || text === '-' || text === 'null' || text === 'n/a') return null
  // Drop anything that is not part of the number or its magnitude word.
  text = text.replace(/[^\d.,\sa-záéíóúñ]/g, '').trim()

  const match = text.match(/^([\d.,\s]+?)\s*([a-záéíóúñ][a-záéíóúñ\s]*)?$/)
  if (!match) return null
  const numberPart = match[1].replace(/\s+/g, '')
  const suffix = (match[2] || '').trim()
  if (!/\d/.test(numberPart)) return null

  let multiplier = 1
  if (suffix) {
    const found = SUFFIX_MULTIPLIERS.find(([re]) => re.test(suffix))
    if (!found) return null
    multiplier = found[1]
  }

  const hasDot = numberPart.includes('.')
  const hasComma = numberPart.includes(',')
  let normalised: string
  if (hasDot && hasComma) {
    // The LAST separator is the decimal mark; the other one groups thousands.
    const lastDot = numberPart.lastIndexOf('.')
    const lastComma = numberPart.lastIndexOf(',')
    const decimalSep = lastDot > lastComma ? '.' : ','
    const thousandsSep = decimalSep === '.' ? ',' : '.'
    normalised = numberPart.split(thousandsSep).join('').replace(decimalSep, '.')
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ','
    const groups = numberPart.split(sep)
    const looksLikeThousands = !suffix && groups.length > 1 && groups.slice(1).every(g => g.length === 3) && groups[0].length > 0 && groups[0].length <= 3
    normalised = looksLikeThousands
      ? groups.join('')
      : groups.length === 2
        ? `${groups[0]}.${groups[1]}`
        : groups.join('') // several separators of one kind without 3-digit groups: unreadable grouping, join digits
  } else {
    normalised = numberPart
  }

  const parsed = Number(normalised)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed * multiplier)
}

/** Clamp a confidence-like value to 0–1; anything unreadable is 0. */
function parseConfidence(value: unknown): number {
  let n: number | null = null
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') {
    const cleaned = value.replace('%', '').replace(',', '.').trim()
    n = cleaned ? Number(cleaned) : null
  }
  if (n === null || !Number.isFinite(n)) return 0
  if (n > 1 && n <= 100) n = n / 100
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100))
}

// ============ RESPONSE PARSING ============

/** Strips code fences and any prose around the first {...} block, then parses. */
export function parseInsightsJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(candidate)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Normalises a parsed object into ExtractedInsights (server-side number normalisation too). */
export function normalizeInsights(parsed: Record<string, unknown>): ExtractedInsights {
  const out = {} as ExtractedInsights
  for (const key of INSIGHT_NUMERIC_KEYS) out[key] = parseCountValue(parsed[key])
  out.confidence = parseConfidence(parsed.confidence)
  const notes = parsed.notes
  out.notes = typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 400) : null
  return out
}

// ============ IMAGE VALIDATION ============

/** Strips a data-URL prefix and whitespace; returns null when the payload is not base64. */
export function cleanBase64(input: string): string | null {
  let data = input.trim()
  const comma = data.indexOf(',')
  if (data.startsWith('data:') && comma !== -1) data = data.slice(comma + 1)
  data = data.replace(/\s+/g, '')
  if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) return null
  return data
}

/** Decoded size of a base64 string, in bytes. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

// ============ PROMPT ============

function buildInstruction(input: { mediaType: string | null; platform: string | null; locale: string }): string {
  const type = (input.mediaType || '').toUpperCase()
  const isStory = type === 'STORY'
  const isVideo = type === 'REEL' || type === 'VIDEO' || type === 'SHORT'
  const notesLanguage = input.locale === 'en' ? 'English' : 'Spanish'
  const context = [
    `Platform: ${input.platform || 'unknown'}.`,
    `Publication type: ${type || 'unknown'}.`,
    isStory
      ? 'This is a STORY: "Visualizaciones"/"Views" → views; "Alcance"/"Cuentas alcanzadas"/"Reach" → reach; "Impresiones"/"Impressions" → impressions; "Respuestas"/"Replies" → storyReplies; "Toques en el sticker"/"Toques en el enlace"/"Clics en el enlace"/"Link taps"/"Sticker taps" → linkTaps.'
      : isVideo
        ? 'This is a VIDEO/REEL: "Reproducciones"/"Plays"/"Visualizaciones"/"Views" → views; "Alcance"/"Cuentas alcanzadas"/"Reach"/"Accounts reached" → reach; "Impresiones"/"Impressions" → impressions.'
        : 'This is a static POST/CAROUSEL (no plays): "Visualizaciones"/"Views"/"Impresiones"/"Impressions" → impressions; "Alcance"/"Cuentas alcanzadas"/"Reach"/"Accounts reached" → reach; leave views null.',
  ].join(' ')

  return [
    'You transcribe the figures shown in a screenshot of a social-media publication\'s insights ("Estadísticas", "Insights", "Analytics") from Instagram, TikTok or YouTube.',
    'Return ONLY one JSON object — no prose, no Markdown, no code fences — with exactly these keys:',
    '{"reach": number|null, "impressions": number|null, "views": number|null, "likes": number|null, "comments": number|null, "shares": number|null, "saves": number|null, "storyReplies": number|null, "linkTaps": number|null, "confidence": number, "notes": string|null}',
    'Label mapping (Spanish / English):',
    '- likes ← "Me gusta", "Likes"',
    '- comments ← "Comentarios", "Comments"',
    '- shares ← "Compartidos", "Veces que se compartió", "Compartir", "Shares", "Sends"',
    '- saves ← "Guardados", "Veces guardado", "Saves", "Favoritos", "Favorites"',
    '- "Interacciones"/"Interactions"/"Engagement" is a TOTAL: never copy it into a field; mention it in notes if useful.',
    '- Ignore account-level figures: "Seguidores"/"Followers", "Visitas al perfil"/"Profile visits", "Actividad del perfil", follow counts, growth percentages.',
    context,
    'Numbers: write plain integers. Expand abbreviations: "12,3 mil" = 12300, "45,6 K" = 45600, "1,2 M" = 1200000, "1.234" (Spanish) = 1234, "1,234" (English) = 1234. A figure that is not visible or illegible is null — never guess.',
    'confidence: your overall confidence in the transcription, from 0 to 1.',
    `notes: one short sentence in ${notesLanguage} about ambiguities (e.g. a label you could not map, a cropped number), or null.`,
    'If the image is not an insights screenshot, return every numeric field as null, confidence 0, and say why in notes.',
  ].join('\n')
}

// ============ CLIENT ============

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return null
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 55_000 })
}

function isModelNotFound(error: unknown): boolean {
  if (error instanceof Anthropic.NotFoundError) return true
  if (error instanceof Anthropic.BadRequestError) {
    return /model/i.test(error.message) && /not (found|supported|available)|invalid|unknown/i.test(error.message)
  }
  return false
}

async function createWithFallback(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<{ response: Anthropic.Message; model: string }> {
  try {
    const response = await client.messages.create({
      model: PRIMARY_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: 'medium' },
      messages,
    })
    return { response, model: PRIMARY_MODEL }
  } catch (error) {
    if (!isModelNotFound(error)) throw error
    console.warn(`[insights-extract] Model ${PRIMARY_MODEL} not available, retrying with ${FALLBACK_MODEL}`)
    const response = await client.messages.create({
      model: FALLBACK_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages,
    })
    return { response, model: FALLBACK_MODEL }
  }
}

function describeApiError(error: unknown): { code: ExtractInsightsErrorCode; error: string } {
  if (error instanceof Anthropic.AuthenticationError) {
    return { code: 'not_configured', error: 'La clave de API de Anthropic no es válida. Revisa ANTHROPIC_API_KEY en el servidor.' }
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { code: 'not_configured', error: 'La clave de API de Anthropic no tiene permiso para usar este modelo.' }
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { code: 'rate_limit', error: 'Límite de peticiones de Anthropic alcanzado. Espera unos segundos y vuelve a intentarlo.' }
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { code: 'api', error: `Ninguno de los modelos configurados (${PRIMARY_MODEL}, ${FALLBACK_MODEL}) está disponible para esta cuenta.` }
  }
  if (error instanceof Anthropic.BadRequestError) {
    if (/credit balance|billing/i.test(error.message)) {
      return { code: 'api', error: 'La cuenta de Anthropic no tiene crédito disponible.' }
    }
    if (/image/i.test(error.message)) {
      return { code: 'invalid_image', error: `Anthropic ha rechazado la imagen: ${error.message}` }
    }
    return { code: 'api', error: `Petición rechazada por Anthropic: ${error.message}` }
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { code: 'api', error: 'Anthropic ha tardado demasiado en responder. Inténtalo de nuevo.' }
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { code: 'api', error: 'No se ha podido conectar con Anthropic. Inténtalo de nuevo.' }
  }
  if (error instanceof Anthropic.APIError) {
    return { code: 'api', error: `Error de Anthropic (${error.status ?? '?'}): ${error.message}` }
  }
  const message = error instanceof Error ? error.message : 'Error interno'
  return { code: 'api', error: `Error al leer la captura: ${message}` }
}

/**
 * Reads the insights out of one screenshot. Returns a proposal only — the
 * caller (the PM, through the UI) decides what gets stored.
 */
export async function extractInsightsFromImage(input: ExtractInsightsInput): Promise<ExtractInsightsResult> {
  try {
    if (!isInsightsImageMimeType(input.mimeType)) {
      return { ok: false, code: 'invalid_image', error: 'Solo se admiten imágenes JPEG, PNG o WebP.' }
    }
    const data = typeof input.imageBase64 === 'string' ? cleanBase64(input.imageBase64) : null
    if (!data) {
      return { ok: false, code: 'invalid_image', error: 'La imagen no es un base64 válido.' }
    }
    if (base64ByteLength(data) > INSIGHTS_IMAGE_MAX_BYTES) {
      return { ok: false, code: 'too_large', error: 'La imagen supera los 6 MB. Reduce su tamaño y vuelve a intentarlo.' }
    }

    const client = getAnthropicClient()
    if (!client) {
      return { ok: false, code: 'not_configured', error: 'La lectura con IA no está configurada: falta ANTHROPIC_API_KEY en el servidor.' }
    }

    const locale = input.locale === 'en' ? 'en' : 'es'
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: input.mimeType, data } },
          { type: 'text', text: buildInstruction({ mediaType: input.mediaType ?? null, platform: input.platform ?? null, locale }) },
        ],
      },
    ]

    const { response, model } = await createWithFallback(client, messages)

    if (response.stop_reason === 'refusal') {
      return { ok: false, code: 'refusal', error: 'El modelo ha rechazado leer esta imagen.' }
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()

    const parsed = text ? parseInsightsJson(text) : null
    if (!parsed) {
      console.warn('[insights-extract] Unparseable model output:', text.slice(0, 300))
      return { ok: false, code: 'unparseable', error: 'No se han podido interpretar las cifras de la captura. Inténtalo de nuevo o introdúcelas a mano.' }
    }

    return { ok: true, data: normalizeInsights(parsed), model }
  } catch (error) {
    const described = describeApiError(error)
    console.error(`[insights-extract] ${described.code}:`, error)
    return { ok: false, ...described }
  }
}

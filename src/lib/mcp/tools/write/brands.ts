/**
 * The write tools of the MCP connector for BRANDS (the agency's clients):
 *
 *   create_brand   none
 *   update_brand   none
 *   delete_brand   destructive (approved by the administrator in the platform)
 *
 * Every change goes through the platform's own route (/api/brands), as the
 * administrator who authorised the grant. The brands route uses the brand id
 * as the KEY of a row of the `settings` table, a table that also holds stored
 * keys, report configurations and cron stamps, and its PATCH and DELETE do
 * not check that the id is a brand. So here a brand id is accepted only when
 * it has exactly the shape the route generates (`brand_<digits>_<letters or
 * digits>`) AND it is listed by GET /api/brands. Nothing else ever reaches
 * PATCH or DELETE.
 *
 * Out of reach on purpose: the brand's team (the route e-mails people), its
 * client portal user (access control) and its logo after creation. Those stay
 * in the Marcas screen of the platform.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { defineWriteTool, type WriteContext, type WritePlan, type WriteTool } from '@/lib/mcp/write-tool'
import { ToolError, shortText } from '@/lib/mcp/tools/shared'

// ============ Brand ids ============

/** Exactly what src/app/api/brands/route.ts generates: `brand_${Date.now()}_${base36}`. */
export const BRAND_ID_RE = /^brand_\d{10,16}_[a-z0-9]{1,16}$/

export const brandIdInput = z
  .string()
  .trim()
  .regex(BRAND_ID_RE, 'must be a brand id such as brand_1731400000000_k3x9q2ab')
  .describe('The brand id, of the form brand_<digits>_<lowercase letters or digits>, as listed by GET /api/brands.')

/** A brand as GET /api/brands lists it, with only the fields the tools use. */
export interface BrandRow {
  id: string
  name: string
  website: string | null
  logo: string | null
  campaignCount: number
  /** The brand has a client portal user. Only whether it exists, never who. */
  hasPortalUser: boolean
}

/** Every brand the platform lists (GET /api/brands, as the administrator). */
export async function listBrands(ctx: WriteContext): Promise<BrandRow[]> {
  const data = await ctx.platformJson<{ brands?: unknown }>({ method: 'GET', path: '/api/brands' })
  const rows = Array.isArray(data.brands) ? data.brands : []
  const out: BrandRow[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, unknown>
    if (typeof b.id !== 'string' || !BRAND_ID_RE.test(b.id)) continue
    out.push({
      id: b.id,
      name: shortText(b.name, 120) ?? '(sin nombre)',
      website: typeof b.website === 'string' && b.website.trim() ? b.website.trim() : null,
      logo: typeof b.logo === 'string' && b.logo.trim() ? b.logo.trim() : null,
      campaignCount: typeof b.campaignCount === 'number' && Number.isFinite(b.campaignCount) ? b.campaignCount : 0,
      hasPortalUser: typeof b.brandUserId === 'string' && b.brandUserId.length > 0,
    })
  }
  return out
}

/** The brand with this id among the ones the platform lists, or null. */
export async function findBrand(ctx: WriteContext, brandId: string): Promise<BrandRow | null> {
  if (!BRAND_ID_RE.test(brandId)) return null
  return (await listBrands(ctx)).find(b => b.id === brandId) ?? null
}

export const BRAND_NOT_FOUND =
  'No existe ninguna marca con ese id. Los ids de marca se leen con GET /api/brands (platform_request); si la marca no existe, créala con create_brand.'

/** The campaigns attached to a brand (Setting campaign_brand_<campaignId> = brandId), by name. */
async function campaignsOfBrand(brandId: string): Promise<{ id: string; name: string }[]> {
  const links = await prisma.setting.findMany({
    where: { key: { startsWith: 'campaign_brand_' }, value: brandId },
    select: { key: true },
  })
  const ids = links.map(l => l.key.slice('campaign_brand_'.length)).filter(Boolean)
  if (ids.length === 0) return []
  const rows = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  return rows.map(r => ({ id: r.id, name: shortText(r.name, 120) ?? '(sin nombre)' }))
}

// ============ Inputs ============

function isWebUrl(value: string, httpsOnly: boolean): boolean {
  try {
    const u = new URL(value)
    const okProtocol = httpsOnly ? u.protocol === 'https:' : u.protocol === 'https:' || u.protocol === 'http:'
    return okProtocol && !!u.hostname && u.hostname.includes('.') && !u.username && !u.password
  } catch {
    return false
  }
}

const brandNameInput = z.string().trim().min(2).max(80)
const websiteInput = z
  .string()
  .trim()
  .max(300)
  .refine(v => isWebUrl(v, false), 'must be an absolute http(s) URL')
const logoInput = z
  .string()
  .trim()
  .max(500)
  .refine(v => isWebUrl(v, true), 'must be an absolute https URL of an image')

const refuse = (confirmation: 'none' | 'destructive', message: string): WritePlan => ({ confirmation, refuse: message })

// ============ create_brand ============

export const createBrand = defineWriteTool({
  name: 'create_brand',
  title: 'Crear marca',
  description:
    'Creates a client brand on TKOC Intelligence; the authorising admin becomes its creator and its only assigned team member. ' +
    'A brand is needed before creating the campaign of a new client: a campaign can only be attached to a brand when it is created. ' +
    'The platform refuses a name equal or very similar to an existing brand (case, accents and containment ignored) with a Spanish message naming the existing one: then use that brand instead. ' +
    'Returns the brand id to pass as brandId to create_campaign. ' +
    'Does NOT create a client portal login, assign team members or connect Instagram (those are done in the Marcas screen of the platform).',
  input: {
    name: brandNameInput.describe('The brand name as the client is known, 2 to 80 characters.'),
    website: websiteInput.optional().describe('Optional. The brand website, an absolute http(s) URL of at most 300 characters.'),
    logo: logoInput.optional().describe('Optional. An absolute https URL of the brand logo image, at most 500 characters.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: false, idempotentHint: false },
  summarize: a => ({ website: a.website !== undefined, logo: a.logo !== undefined }),
  plan: async () => ({ confirmation: 'none' }),
  async execute(a, ctx) {
    const body: Record<string, unknown> = { name: a.name }
    if (a.website !== undefined) body.website = a.website
    if (a.logo !== undefined) body.logo = a.logo
    const res = await ctx.platformJson<{ brand?: Record<string, unknown> }>({ method: 'POST', path: '/api/brands', body })
    const b = res.brand ?? {}
    const id = typeof b.id === 'string' ? b.id : null
    if (!id) throw new ToolError('La plataforma no ha devuelto el id de la marca. Comprueba con GET /api/brands si se ha creado antes de repetir.')
    return {
      brand: {
        id,
        name: shortText(b.name, 120),
        website: typeof b.website === 'string' ? b.website : null,
        logo: typeof b.logo === 'string' ? b.logo : null,
      },
      message: `Marca creada. Usa brandId ${id} al crear sus campañas con create_campaign.`,
    }
  },
})

// ============ update_brand ============

export const updateBrand = defineWriteTool({
  name: 'update_brand',
  title: 'Renombrar una marca o cambiar su web',
  description:
    'Renames a client brand or changes its website. The connector checks that brandId is a real brand listed by the platform before calling, and sends only these two fields. ' +
    'The platform refuses a new name equal or very similar to another brand, with a Spanish message to relay as is. ' +
    'A change of capital letters only (vileda to Vileda) is ignored by the platform; the answer says so. ' +
    'Returns each changed field as before and after. ' +
    'Does NOT change the assigned team (the platform e-mails people), the client portal user (access control) or the logo: those stay in the Marcas screen of the platform.',
  input: {
    brandId: brandIdInput,
    name: brandNameInput.optional().describe('New name, 2 to 80 characters.'),
    website: websiteInput.nullable().optional().describe('New website (absolute http(s) URL, at most 300 characters), or null to clear it.'),
  },
  confirmations: ['none'],
  // It overwrites the brand's stored values: not an additive update
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({ brandId: a.brandId, name: a.name !== undefined, website: a.website === undefined ? undefined : a.website === null ? 'clear' : 'set' }),
  async plan(a, ctx) {
    if (a.name === undefined && a.website === undefined) return refuse('none', 'Indica qué cambiar: name, website o los dos.')
    if (!(await findBrand(ctx, a.brandId))) return refuse('none', BRAND_NOT_FOUND)
    return { confirmation: 'none' }
  },
  async execute(a, ctx) {
    const before = await findBrand(ctx, a.brandId)
    if (!before) throw new ToolError(BRAND_NOT_FOUND)
    const body: Record<string, unknown> = { brandId: a.brandId }
    const wantName = a.name !== undefined && a.name !== before.name
    const wantWebsite = a.website !== undefined && (a.website ?? null) !== before.website
    if (wantName) body.name = a.name
    if (wantWebsite) body.website = a.website ?? null
    if (!wantName && !wantWebsite) {
      return { brand: { id: before.id, name: before.name }, changed: [], message: 'No había nada que cambiar: la marca ya tenía esos datos.' }
    }
    const res = await ctx.platformJson<{ brand?: Record<string, unknown> }>({ method: 'PATCH', path: '/api/brands', body })
    const b = res.brand ?? {}
    const afterName = shortText(b.name, 120) ?? before.name
    const afterWebsite = typeof b.website === 'string' && b.website.trim() ? b.website.trim() : null
    const changed: string[] = []
    const beforeOut: Record<string, string | null> = {}
    const afterOut: Record<string, string | null> = {}
    if (wantName) {
      beforeOut.name = before.name
      afterOut.name = afterName
      if (afterName !== before.name) changed.push('name')
    }
    if (wantWebsite) {
      beforeOut.website = before.website
      afterOut.website = afterWebsite
      if (afterWebsite !== before.website) changed.push('website')
    }
    const notes: string[] = []
    if (wantName && afterName === before.name) {
      notes.push('La plataforma no ha cambiado el nombre: solo cambiaban mayúsculas o minúsculas, y eso no lo aplica.')
    }
    return { brand: { id: before.id, name: afterName }, changed, before: beforeOut, after: afterOut, ...(notes.length ? { notes } : {}) }
  },
})

// ============ delete_brand ============

function listNames(names: string[], max = 12): string {
  if (names.length === 0) return ''
  const shown = names.slice(0, max).map(n => `«${n}»`).join(', ')
  return names.length > max ? `${shown} y ${names.length - max} más` : shown
}

export const deleteBrand = defineWriteTool({
  name: 'delete_brand',
  title: 'Borrar una marca',
  description:
    'Deletes a client brand and unlinks all its campaigns from it. The campaigns survive but lose the brand for good (a brand can only be attached when a campaign is created): ' +
    'they leave that client portal, lose the brand name and logo on the report cover and stop using the brand benchmarks. ' +
    'The brand Instagram connection, benchmark overrides and client login are NOT cleaned up. ' +
    'The connector validates the id format and that the brand exists before calling, because the platform route would delete any settings row with that key. ' +
    'Use only when the person explicitly asks to delete the brand. Irreversible.',
  input: { brandId: brandIdInput },
  confirmations: ['destructive'],
  annotations: { destructiveHint: true, idempotentHint: false },
  summarize: a => ({ brandId: a.brandId }),
  async plan(a, ctx) {
    const brand = await findBrand(ctx, a.brandId)
    if (!brand) return refuse('destructive', BRAND_NOT_FOUND)
    const campaigns = await campaignsOfBrand(brand.id)
    const names = listNames(campaigns.map(c => c.name))
    const campaignsText =
      campaigns.length === 0
        ? 'No tiene campañas asociadas.'
        : campaigns.length === 1
          ? `Su campaña ${names} se queda sin marca de forma definitiva: sale del portal de ese cliente, pierde nombre y logo en la portada del informe y deja de usar los benchmarks propios de la marca; no se puede volver a asociar.`
          : `Sus ${campaigns.length} campañas (${names}) se quedan sin marca de forma definitiva: salen del portal de ese cliente, pierden nombre y logo en la portada del informe y dejan de usar los benchmarks propios de la marca; no se pueden volver a asociar.`
    const preview = [
      `Vas a BORRAR la marca «${brand.name}».`,
      campaignsText,
      brand.hasPortalUser ? 'Su usuario de portal dejará de ver campañas.' : '',
      'La conexión de Instagram y el acceso del cliente no se eliminan.',
      'No se puede deshacer. ¿Confirmas?',
    ]
      .filter(Boolean)
      .join(' ')
    return { confirmation: 'destructive', preview }
  },
  async execute(a, ctx) {
    // The stored id is checked again: it must still be a brand the platform lists
    const brand = await findBrand(ctx, a.brandId)
    if (!brand) throw new ToolError('La marca ya no existe. No se ha borrado nada.')
    const campaigns = await campaignsOfBrand(brand.id)
    await ctx.platformJson({ method: 'DELETE', path: '/api/brands', query: { brandId: brand.id } })
    return {
      deleted: true,
      brand: { id: brand.id, name: brand.name },
      campaignsUnlinked: campaigns.length,
      message: `Marca «${brand.name}» borrada. ${campaigns.length === 0 ? 'No tenía campañas.' : `${campaigns.length} ${campaigns.length === 1 ? 'campaña se ha quedado' : 'campañas se han quedado'} sin marca.`}`,
    }
  },
})

// ============ Registration ============

/** The brand write tools, in the order Claude lists them. */
export const BRAND_WRITE_TOOLS: readonly WriteTool[] = [createBrand, updateBrand, deleteBrand]

/** Hands every brand write tool to `register` (server.ts registers each with writeToolConfig and tool.call). */
export function registerBrandWriteTools(register: (tool: WriteTool) => void): void {
  for (const tool of BRAND_WRITE_TOOLS) register(tool)
}

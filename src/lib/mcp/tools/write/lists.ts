/**
 * Write tools of the MCP connector for creator LISTS: create, add creators,
 * rename / pin / archive, take creators out and delete.
 *
 * Built with defineWriteTool (../../write-tool.ts); bodies checked against the
 * routes of this working copy:
 *   GET    /api/lists                   the session user's own lists
 *   POST   /api/lists                   { name }             created for the session user
 *   GET    /api/lists/[id]              the list and its items (owner or ADMIN)
 *   POST   /api/lists/[id]              { influencerId }     also a Contact of the owner (and of the admin)
 *   PUT    /api/lists/[id]              { name?, isPinned?, isArchived? }
 *   DELETE /api/lists/[id]?itemId=<id>  removes ONE item
 *   DELETE /api/lists/[id]              WITHOUT itemId deletes the WHOLE list
 *
 * Because of that last line, remove_creators_from_list resolves every item id
 * from the list itself and never sends the DELETE without a verified item id;
 * only delete_list sends it bare, after the administrator approved it.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { defineWriteTool, type WriteContext, type WriteTool } from '../../write-tool'
import { ToolError, idInput, shortText } from '../shared'
import {
  NOT_ATTEMPTED,
  SKIPPED_AFTER_TIMEOUT,
  UNKNOWN_AFTER_TIMEOUT,
  asArray,
  asObject,
  asString,
  at,
  attempt,
  listText,
  named,
  plural,
  timeBudget,
  type Json,
} from './creators'

const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

interface ListItemRow {
  itemId: string
  influencerId: string
  username: string
}

interface ListSnapshot {
  id: string
  name: string
  ownerId: string
  ownerName: string
  isPinned: boolean
  isArchived: boolean
  items: ListItemRow[]
  byInfluencer: Map<string, ListItemRow>
}

/** GET /api/lists/[id]: the list, its owner and its items. */
async function readList(ctx: WriteContext, listId: string): Promise<ListSnapshot> {
  const list = asObject(asObject(await ctx.platformJson({ method: 'GET', path: `/api/lists/${listId}` })).list)
  const id = asString(list.id)
  const ownerId = asString(list.userId)
  if (!id || !ownerId) throw new ToolError('No se ha podido leer la lista.')
  const items: ListItemRow[] = []
  for (const raw of asArray(list.items)) {
    const item = asObject(raw)
    const itemId = asString(item.id)
    const influencerId = asString(item.influencerId)
    if (itemId && influencerId) items.push({ itemId, influencerId, username: asString(asObject(item.influencer).username) ?? '?' })
  }
  const ownerName =
    ownerId === ctx.user.id ? ctx.user.name : ((await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name ?? 'otra persona')
  return {
    id,
    name: asString(list.name) ?? '',
    ownerId,
    ownerName,
    isPinned: list.isPinned === true,
    isArchived: list.isArchived === true,
    items,
    byInfluencer: new Map(items.map(i => [i.influencerId, i])),
  }
}

/** The admin's own lists with this name (trimmed, without case), other than `exceptId`. */
async function sameNameLists(ctx: WriteContext, name: string, exceptId?: string): Promise<Json[]> {
  const lists = asArray(asObject(await ctx.platformJson({ method: 'GET', path: '/api/lists' })).lists).map(asObject)
  const wanted = name.trim().toLowerCase()
  return lists.filter(l => asString(l.id) !== exceptId && (asString(l.name) ?? '').trim().toLowerCase() === wanted)
}

const nameInput = z.string().trim().min(1).max(80)

// =====================================================================
// create_list
// =====================================================================

export const createList = defineWriteTool({
  name: 'create_list',
  title: 'Crear lista de creadoras',
  description:
    'Creates an empty creator list owned by the authorising admin; lists cannot be created for another PM or transferred. ' +
    'The name is trimmed and refused when the admin already has a list with that name. It does NOT add creators (add_creators_to_list).',
  input: { name: nameInput.describe('Name of the list, 1-80 characters.') },
  confirmations: ['none'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  summarize: a => ({ nameChars: a.name.length }),
  async plan(args, ctx) {
    const same = await sameNameLists(ctx, args.name)
    if (same.length > 0) throw new ToolError(`Ya tienes una lista llamada ${named(args.name)} (id ${asString(same[0].id)}). No se ha creado otra.`)
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const list = asObject(asObject(await ctx.platformJson({ method: 'POST', path: '/api/lists', body: { name: args.name.trim() } })).list)
    return { created: true, listId: asString(list.id), name: shortText(list.name, 80), owner: ctx.user.name, creators: 0 }
  },
})

// =====================================================================
// add_creators_to_list
// =====================================================================

interface AddToListPlan {
  list: ListSnapshot
  /** In order, without repeats. */
  ids: string[]
  known: Map<string, string>
}
const addToListPlans = new WeakMap<WriteContext, AddToListPlan>()

export const addCreatorsToList = defineWriteTool({
  name: 'add_creators_to_list',
  title: 'Añadir creadoras a una lista',
  description:
    'Adds creators to a list by creator id; each also becomes a Contact of the list owner (and of the admin when the list is someone else\'s). ' +
    'Creators that exist only in a creator search, without creator id, must first go through import_creators_to_database. ' +
    'Returns one result per creator: added, already in the list or not found. It does NOT add them to any campaign.',
  input: {
    listId: idInput('The list id.'),
    influencerIds: z.array(idInput('Creator id')).min(1).max(50).describe('Creators to add, by id.'),
  },
  confirmations: ['none', 'bulk'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  summarize: a => ({ listId: a.listId, creators: a.influencerIds.length }),
  async plan(args, ctx) {
    const list = await readList(ctx, args.listId)
    const ids = [...new Set(args.influencerIds)]
    const rows = await prisma.influencer.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } })
    const known = new Map(rows.map(r => [r.id, r.username]))
    addToListPlans.set(ctx, { list, ids, known })
    const toAdd = ids.filter(id => known.has(id) && !list.byInfluencer.has(id))
    if (toAdd.length <= 5) return { confirmation: 'none' }
    const contacts = list.ownerId === ctx.user.id ? 'tuyos' : `de ${list.ownerName} y tuyos`
    return {
      confirmation: 'bulk',
      fingerprint: JSON.stringify({ items: list.items.length, toAdd }),
      preview:
        `Vas a añadir ${plural(toAdd.length, 'creadora', 'creadoras')} a la lista ${named(list.name)} (ahora tiene ${list.items.length}): ${listText(toAdd.map(id => at(known.get(id))), 25)}. ` +
        `También quedarán como Contactos ${contacts}. ¿Confirmas?`,
    }
  },
  async execute(args, ctx) {
    const p = addToListPlans.get(ctx)!
    const budget = timeBudget()
    const results: Json[] = []
    let stop = false
    for (const id of p.ids) {
      const handle = p.known.has(id) ? at(p.known.get(id)) : null
      if (!p.known.has(id)) {
        results.push({ influencerId: id, result: 'not_found' })
        continue
      }
      if (p.list.byInfluencer.has(id)) {
        results.push({ influencerId: id, handle, result: 'already_in_list' })
        continue
      }
      if (stop || budget.left() < 5_000) {
        results.push({ influencerId: id, handle, result: 'not_attempted', reason: stop ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED })
        continue
      }
      const out = await attempt(ctx, { method: 'POST', path: `/api/lists/${p.list.id}`, body: { influencerId: id }, timeoutMs: budget.timeout(30_000) })
      results.push({
        influencerId: id,
        handle,
        result: out.ok ? 'added' : out.status === 409 ? 'already_in_list' : out.status === 404 ? 'not_found' : out.timeout ? 'unknown' : 'error',
        ...(!out.ok && out.status !== 409 && out.status !== 404 ? { reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message } : {}),
      })
      if (!out.ok && out.timeout) stop = true
    }
    return {
      list: { id: p.list.id, name: shortText(p.list.name, 80), owner: p.list.ownerName },
      added: results.filter(r => r.result === 'added').length,
      results,
    }
  },
})

// =====================================================================
// update_list
// =====================================================================

const listUpdatePlans = new WeakMap<WriteContext, ListSnapshot>()

export const updateList = defineWriteTool({
  name: 'update_list',
  title: 'Renombrar, fijar o archivar una lista',
  description:
    'Renames a creator list, pins or unpins it, archives or unarchives it. Archiving is the reversible alternative to deleting. ' +
    'The answer shows each change as before and after. It does NOT change its creators.',
  input: {
    listId: idInput('The list id.'),
    name: nameInput.optional().describe('New name, 1-80 characters.'),
    isPinned: z.boolean().optional().describe('Pin (true) or unpin (false).'),
    isArchived: z.boolean().optional().describe('Archive (true) or unarchive (false).'),
  },
  confirmations: ['none'],
  // It renames or archives (overwrites stored values): not an additive update
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({ listId: a.listId, rename: a.name !== undefined, isPinned: a.isPinned, isArchived: a.isArchived }),
  async plan(args, ctx) {
    if (args.name === undefined && args.isPinned === undefined && args.isArchived === undefined) {
      throw new ToolError('Indica qué cambiar: name, isPinned o isArchived. No se ha hecho nada.')
    }
    const list = await readList(ctx, args.listId)
    listUpdatePlans.set(ctx, list)
    if (args.name !== undefined && list.ownerId === ctx.user.id) {
      const same = await sameNameLists(ctx, args.name, list.id)
      if (same.length > 0) throw new ToolError(`Ya tienes otra lista llamada ${named(args.name)}. No se ha hecho nada.`)
    }
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const before = listUpdatePlans.get(ctx)!
    const body: Json = {}
    if (args.name !== undefined) body.name = args.name.trim()
    if (args.isPinned !== undefined) body.isPinned = args.isPinned
    if (args.isArchived !== undefined) body.isArchived = args.isArchived
    const after = asObject(asObject(await ctx.platformJson({ method: 'PUT', path: `/api/lists/${before.id}`, body })).list)
    const changes: Json = {}
    if (args.name !== undefined) changes.name = { before: shortText(before.name, 80), after: shortText(after.name, 80) }
    if (args.isPinned !== undefined) changes.isPinned = { before: before.isPinned, after: after.isPinned === true }
    if (args.isArchived !== undefined) changes.isArchived = { before: before.isArchived, after: after.isArchived === true }
    return { listId: before.id, owner: before.ownerName, changes }
  },
})

// =====================================================================
// remove_creators_from_list
// =====================================================================

export const removeCreatorsFromList = defineWriteTool({
  name: 'remove_creators_from_list',
  title: 'Quitar creadoras de una lista',
  description:
    'Takes creators out of a list; their records and contacts are untouched. Each creator is resolved to its list item from the list itself, and the item is removed one by one: ' +
    'the list itself is never deleted by this tool (delete_list does that). The administrator must approve it in the platform before it runs.',
  input: {
    listId: idInput('The list id.'),
    influencerIds: z.array(idInput('Creator id')).min(1).max(50).describe('Creators currently in the list.'),
  },
  confirmations: ['destructive'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({ listId: a.listId, creators: a.influencerIds.length }),
  async plan(args, ctx) {
    const list = await readList(ctx, args.listId)
    const ids = [...new Set(args.influencerIds)]
    const missing = ids.filter(id => !list.byInfluencer.has(id))
    if (missing.length > 0) {
      throw new ToolError(`No están en la lista ${named(list.name)}: ${listText(missing, 10)}. No se ha hecho nada.`)
    }
    return {
      confirmation: 'destructive',
      preview:
        `Vas a quitar ${plural(ids.length, 'creadora', 'creadoras')} de la lista ${named(list.name)} de ${list.ownerName}: ${listText(ids.map(id => at(list.byInfluencer.get(id)!.username)), 25)}. ` +
        'Solo salen de la lista; sus fichas y contactos no se tocan. ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    // Resolved again now: the list may have changed since the preview
    const list = await readList(ctx, args.listId)
    const budget = timeBudget()
    const results: Json[] = []
    let stop = false
    for (const id of [...new Set(args.influencerIds)]) {
      const item = list.byInfluencer.get(id)
      if (!item) {
        results.push({ influencerId: id, result: 'not_in_list' })
        continue
      }
      // Never a DELETE on the list without a verified item id: without it the route deletes the whole list
      if (!ITEM_ID_RE.test(item.itemId)) {
        results.push({ influencerId: id, handle: at(item.username), result: 'error', reason: 'Elemento de lista no válido: no se ha tocado.' })
        continue
      }
      if (stop || budget.left() < 5_000) {
        results.push({ influencerId: id, handle: at(item.username), result: 'not_attempted', reason: stop ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED })
        continue
      }
      const out = await attempt(ctx, { method: 'DELETE', path: `/api/lists/${list.id}`, query: { itemId: item.itemId }, timeoutMs: budget.timeout(30_000) })
      results.push({
        influencerId: id,
        handle: at(item.username),
        result: out.ok ? 'removed' : out.timeout ? 'unknown' : 'error',
        ...(!out.ok ? { reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message } : {}),
      })
      if (!out.ok && out.timeout) stop = true
    }
    return {
      list: { id: list.id, name: shortText(list.name, 80), owner: list.ownerName },
      removed: results.filter(r => r.result === 'removed').length,
      results,
      untouched: 'Las fichas de las creadoras y sus contactos no se han tocado.',
    }
  },
})

// =====================================================================
// delete_list
// =====================================================================

export const deleteList = defineWriteTool({
  name: 'delete_list',
  title: 'Borrar una lista',
  description:
    "Permanently deletes a creator list with all its items; the creators and contacts are untouched. As admin this also works on other PMs' lists, so the preview names the owner. " +
    'Offer archiving (update_list with isArchived true) first. The administrator must approve it in the platform before it runs.',
  input: { listId: idInput('The list id.') },
  confirmations: ['destructive'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({ listId: a.listId }),
  async plan(args, ctx) {
    const list = await readList(ctx, args.listId)
    return {
      confirmation: 'destructive',
      preview:
        `Vas a BORRAR la lista ${named(list.name)} de ${list.ownerName} con sus ${plural(list.items.length, 'creadora', 'creadoras')}. ` +
        'Las fichas de las creadoras no se borran, pero la lista no se puede recuperar. Alternativa: archivarla. ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    const list = await readList(ctx, args.listId)
    await ctx.platformJson({ method: 'DELETE', path: `/api/lists/${list.id}` })
    return { deleted: true, listId: list.id, name: shortText(list.name, 80), owner: list.ownerName, creatorsItHad: list.items.length }
  },
})

// =====================================================================
// Registration
// =====================================================================

export const LIST_WRITE_TOOLS: readonly WriteTool[] = [createList, addCreatorsToList, updateList, removeCreatorsFromList, deleteList]

/** Hands every list write tool to `register` (server.ts: server.registerTool with writeToolConfig). */
export function registerListWriteTools(register: (tool: WriteTool) => void): void {
  for (const tool of LIST_WRITE_TOOLS) register(tool)
}

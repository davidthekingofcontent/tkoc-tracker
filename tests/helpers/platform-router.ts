/**
 * In-process router for the tests of the MCP write layer: from a method and a
 * path to the REAL route handler module of src/app/api, with no network.
 *
 *   setPlatformTransport(createPlatformRouter())
 *
 * Each request the platform client builds (a Web Request to
 * http://127.0.0.1:<port>/api/...) is turned into a NextRequest and handed to
 * the exported function of the matching `route.ts`, with its `[param]`
 * segments as `params` (a Promise, as Next 16 passes them). The answer is
 * returned exactly as the handler produced it: a redirect is NOT followed
 * here either (the client decides what to do with it).
 *
 * The route files are found on disk, so this router knows every route of the
 * platform, including the ones the client must refuse: whether a path may be
 * called is the client's decision, never this helper's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import type { PlatformTransport } from '@/lib/mcp/platform-client'

const here = path.dirname(fileURLToPath(import.meta.url))
export const API_ROOT = path.resolve(here, '..', '..', 'src', 'app', 'api')

export interface RouteFile {
  /** `/api/campaigns/[id]/influencers` */
  pattern: string
  /** Absolute path of its route.ts */
  file: string
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/** Every route.ts under src/app/api, as patterns. Route groups `(x)` are skipped; `_private` folders are not routes. */
export function listRouteFiles(root: string = API_ROOT): RouteFile[] {
  const out: RouteFile[] = []
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_')) continue
        const next = /^\(.*\)$/.test(entry.name) ? segments : [...segments, entry.name]
        walk(path.join(dir, entry.name), next)
      } else if (entry.name === 'route.ts') {
        out.push({ pattern: `/api${segments.length ? '/' + segments.join('/') : ''}`, file: path.join(dir, entry.name) })
      }
    }
  }
  walk(root, [])
  return out.sort((a, b) => a.pattern.localeCompare(b.pattern))
}

/** The HTTP methods a route file exports, read from its source text. */
export function exportedMethods(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8')
  return HTTP_METHODS.filter(m => new RegExp(`export\\s+(?:async\\s+function|const|function)\\s+${m}\\b`).test(source))
}

function matchSegments(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split('/').slice(1)
  if (parts.length !== segments.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const dyn = /^\[([A-Za-z]+)\]$/.exec(parts[i])
    if (dyn) params[dyn[1]] = decodeURIComponent(segments[i])
    else if (parts[i] !== segments[i]) return null
  }
  return params
}

export interface RoutedCall {
  method: string
  /** Path and query as the handler received them. */
  url: string
  pattern: string | null
  status: number
}

export interface PlatformRouter {
  transport: PlatformTransport
  /** Every request routed so far, in order. */
  calls: RoutedCall[]
}

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response> | Response

/** A transport that runs the real route handlers in-process. */
export function createPlatformRouter(): PlatformRouter {
  const routes = listRouteFiles()
  const calls: RoutedCall[] = []

  const transport: PlatformTransport = async request => {
    const url = new URL(request.url)
    const segments = url.pathname.split('/').slice(1)
    // Static segments win over [param] ones, as in Next
    let best: { route: RouteFile; params: Record<string, string>; score: number } | null = null
    for (const route of routes) {
      const params = matchSegments(route.pattern, segments)
      if (!params) continue
      const score = route.pattern.split('/').filter(p => p && !p.startsWith('[')).length
      if (!best || score > best.score) best = { route, params, score }
    }
    const record = (status: number) => calls.push({ method: request.method, url: url.pathname + url.search, pattern: best?.route.pattern ?? null, status })
    if (!best) {
      record(404)
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    const mod = (await import(/* @vite-ignore */ best.route.file)) as Record<string, unknown>
    const handler = mod[request.method] as Handler | undefined
    if (typeof handler !== 'function') {
      record(405)
      return new Response(null, { status: 405 })
    }
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
    const nextRequest = new NextRequest(url, {
      method: request.method,
      headers: request.headers,
      ...(body ? { body } : {}),
    })
    const response = await handler(nextRequest, { params: Promise.resolve(best.params) })
    record(response.status)
    return response
  }

  return { transport, calls }
}

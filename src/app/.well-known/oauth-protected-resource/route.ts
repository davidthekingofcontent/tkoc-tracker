/**
 * GET /.well-known/oauth-protected-resource
 *
 * RFC 9728 Protected Resource Metadata of the MCP endpoint. Claude reads it
 * after the first 401 of /api/mcp to learn which authorization server to use.
 * Public by definition: it holds no secret and needs no session.
 *
 * The same document is served at /.well-known/oauth-protected-resource/api/mcp
 * (the path-specific form of RFC 9728 §3.1), by the route next to this one.
 *
 * SECURITY: every URL in the document comes from src/lib/mcp/config.ts, never
 * from the request (Host, X-Forwarded-Host and Origin are ignored).
 */
import { NextResponse } from 'next/server'
import { protectedResourceMetadata } from '@/lib/mcp/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: { 'Cache-Control': 'no-store' } })
}

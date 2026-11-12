/**
 * GET /.well-known/oauth-authorization-server
 *
 * RFC 8414 Authorization Server Metadata: where to register, where to send
 * the user, where to get tokens. PKCE S256 only, public clients only, dynamic
 * registration only (no Client ID Metadata Document). Public by definition.
 * /.well-known/openid-configuration is deliberately not served.
 *
 * SECURITY: every URL in the document comes from src/lib/mcp/config.ts, never
 * from the request (Host, X-Forwarded-Host and Origin are ignored).
 */
import { NextResponse } from 'next/server'
import { authorizationServerMetadata } from '@/lib/mcp/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: { 'Cache-Control': 'no-store' } })
}

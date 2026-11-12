/**
 * GET /.well-known/oauth-protected-resource/api/mcp
 *
 * The path-specific location of the RFC 9728 metadata of /api/mcp (RFC 9728
 * §3.1 inserts the well-known segment before the path of the resource). Some
 * clients ask here first and at the root second: both answer the same document.
 */
export { GET } from '../../route'

// Declared here as literals: Next reads the segment configuration of each
// route file statically and does not follow a re-export.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

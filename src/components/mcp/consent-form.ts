/**
 * Contract of the consent form of the MCP connector: the page /oauth/authorize
 * renders it and POST /api/oauth/authorize reads it.
 *
 * Plain module on purpose (no 'use client'): the page, the client component
 * and the route handler can all import the very same names, so the form and
 * its reader cannot drift apart.
 *
 * The form is a plain HTML form (application/x-www-form-urlencoded, no
 * JavaScript needed) with exactly two fields:
 *   - CONSENT_TOKEN_FIELD: the token signed by signConsentToken (src/lib/mcp/crypto.ts);
 *   - DECISION_FIELD: DECISION_ALLOW («Permitir») or DECISION_DENY («Cancelar»).
 * Anything other than DECISION_ALLOW must be treated as a refusal.
 */
export const CONSENT_FORM_ACTION = '/api/oauth/authorize'
export const CONSENT_TOKEN_FIELD = 'consent_token'
export const DECISION_FIELD = 'decision'
export const DECISION_ALLOW = 'allow'
export const DECISION_DENY = 'deny'

/**
 * Contract of the decision form of a pending action of Claude: the page
 * /mcp/confirmar/[id] renders it and POST /api/mcp/actions/[id] reads it.
 *
 * Plain module on purpose (no 'use client'): the page, the client component
 * and the route handler import the very same names.
 *
 * Two plain HTML forms (application/x-www-form-urlencoded, no JavaScript):
 *   «Cancelar»:  ACTION_TOKEN_FIELD + ACTION_DECISION_FIELD = ACTION_CANCEL;
 *   «Confirmar»: ACTION_TOKEN_FIELD + ACTION_PASSWORD_FIELD + ACTION_DECISION_FIELD = ACTION_CONFIRM.
 *   - ACTION_TOKEN_FIELD: the token signed by signDecisionToken (src/lib/mcp/confirm.ts);
 *   - ACTION_PASSWORD_FIELD: the administrator's own password, checked against
 *     the database. A browser driven by Claude (Claude in Chrome, with the
 *     owner's session) can open the page and press a button, but it does not
 *     know the password and its rules forbid typing one: the confirmation
 *     stays outside the model. Only «Confirmar» asks for it.
 * Any other decision value changes nothing.
 */
export const ACTION_TOKEN_FIELD = 'action_token'
export const ACTION_DECISION_FIELD = 'decision'
export const ACTION_CONFIRM = 'confirm'
export const ACTION_CANCEL = 'cancel'
export const ACTION_PASSWORD_FIELD = 'action_password'
/** Query parameter of the page after a refused password: `?error=password`. */
export const ACTION_ERROR_PARAM = 'error'
export const ACTION_ERROR_PASSWORD = 'password'

/** Where the form posts. `id` has already been checked as an action id (letters, digits, _ and -). */
export function actionFormAction(id: string): string {
  return `/api/mcp/actions/${encodeURIComponent(id)}`
}

/** The confirmation page of an action, as a same-site path. With `error`, the page says why nothing was confirmed. */
export function actionPagePath(id: string, error?: typeof ACTION_ERROR_PASSWORD): string {
  const path = `/mcp/confirmar/${encodeURIComponent(id)}`
  return error ? `${path}?${ACTION_ERROR_PARAM}=${error}` : path
}

/**
 * /creators/duplicadas: «Fichas duplicadas», the merge tool (ADMIN only).
 *
 * SERVER component: the session is checked here, against the database
 * (checkAdminSession re-reads the user: active, and ADMIN in the database as
 * in the token), before anything is rendered. No session → /login; a BRAND
 * goes to its portal; an EMPLOYEE or a CREATOR goes back to /dashboard (the
 * sidebar shows the entry to ADMINs only). The route the screen calls checks
 * the ADMIN session again on every request (/api/admin/person-merge).
 *
 * `?campaign=<id>` filters the candidates to that campaign (the notice of the
 * campaign page links here with it). Only an id-shaped value is passed on.
 */
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { checkAdminSession } from '@/lib/mcp/oauth'
import { PersonMergeScreen } from '@/components/person-merge/person-merge-screen'

// Reads the session cookie and the database on every request: never prerendered, never cached
export const dynamic = 'force-dynamic'
// jsonwebtoken and Prisma need the Node runtime
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Fichas duplicadas · TKOC Intelligence',
  robots: { index: false, follow: false },
}

const CAMPAIGN_ID = /^[a-z0-9]{10,40}$/i

export default async function DuplicateRecordsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await checkAdminSession((await cookies()).get('token')?.value)
  if (session.status === 'anonymous') redirect('/login')
  if (session.status === 'forbidden') redirect(session.role === 'BRAND' ? '/portal' : '/dashboard')

  const raw = (await searchParams)?.campaign
  const campaignId = typeof raw === 'string' && CAMPAIGN_ID.test(raw) ? raw : null
  // One screen per filter: going from one campaign to all of them starts clean
  return <PersonMergeScreen key={campaignId ?? 'all'} campaignId={campaignId} />
}

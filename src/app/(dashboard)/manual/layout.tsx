import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { verifyToken } from '@/lib/auth'

// The manual is internal agency material (fees, CPM rules, Apify limits,
// "never to the client" lists). The sidebar only hides the entry for other
// roles; this server-side check keeps the page itself staff-only.
const STAFF_ROLES = new Set(['ADMIN', 'EMPLOYEE'])

export default async function ManualLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const token = (await cookies()).get('token')?.value
  let role: string | null = null
  try {
    role = token ? verifyToken(token).role : null
  } catch {
    role = null
  }
  if (!role || !STAFF_ROLES.has(role)) {
    redirect(role === 'BRAND' ? '/portal' : '/dashboard')
  }
  return <>{children}</>
}

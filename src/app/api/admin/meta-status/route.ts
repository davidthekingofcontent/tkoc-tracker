import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * Public status check for Meta integration setup.
 * Returns booleans only — no secrets, no PII.
 * Used to know if the user has actually configured the Meta app in Railway.
 */
export async function GET() {
  // Check env vars (just presence, never value)
  const envStatus = {
    META_APP_ID: !!process.env.META_APP_ID,
    META_APP_SECRET: !!process.env.META_APP_SECRET,
    TOKEN_ENCRYPTION_KEY: !!process.env.TOKEN_ENCRYPTION_KEY,
    APIFY_API_KEY: !!process.env.APIFY_API_KEY,
    JWT_SECRET: !!process.env.JWT_SECRET,
  }

  // Count Meta connections (no secrets, just counts)
  let connections = { instagram: 0, brand: 0, creator: 0 }
  try {
    const all = await prisma.socialToken.findMany({
      where: { platform: 'INSTAGRAM', isValid: true },
      select: { tokenType: true },
    })
    connections = {
      instagram: all.length,
      brand: all.filter(t => t.tokenType === 'brand').length,
      creator: all.filter(t => t.tokenType === 'creator').length,
    }
  } catch { /* schema not yet pushed */ }

  // Check if any media has been captured via Meta API
  let metaMediaCount = 0
  try {
    metaMediaCount = await prisma.metaMedia.count()
  } catch { /* table doesn't exist yet */ }

  return NextResponse.json({
    env: envStatus,
    ready: envStatus.META_APP_ID && envStatus.META_APP_SECRET && envStatus.TOKEN_ENCRYPTION_KEY,
    connections,
    metaMediaCount,
    timestamp: new Date().toISOString(),
  })
}

/**
 * Admin: install the app on every connected brand Page so Meta delivers
 * Instagram webhooks (story @mentions). Idempotent. GET shows the current
 * subscription state; POST subscribes. Requires the brand connection to hold
 * pages_manage_metadata (reconnect after that scope was added).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { decrypt } from '@/lib/encryption'
import { getPageSubscribedApps, subscribePageToApp, MetaApiError } from '@/lib/meta-api'

async function listBrandPages() {
  const tokens = await prisma.socialToken.findMany({
    where: { platform: 'INSTAGRAM', tokenType: 'brand', isValid: true, platformPageId: { not: null } },
    select: { id: true, platformPageId: true, platformUserId: true, accessToken: true, scopes: true },
  })
  return tokens
}

export async function GET(request: NextRequest) {
  const session = await getSession(request)
  if (!session || session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const out = []
  for (const t of await listBrandPages()) {
    try {
      const apps = await getPageSubscribedApps(t.platformPageId!, decrypt(t.accessToken))
      out.push({ tokenId: t.id, pageId: t.platformPageId, igId: t.platformUserId, hasMetadataScope: t.scopes.includes('pages_manage_metadata'), subscribedApps: apps })
    } catch (err) {
      out.push({ tokenId: t.id, pageId: t.platformPageId, igId: t.platformUserId, hasMetadataScope: t.scopes.includes('pages_manage_metadata'), error: err instanceof MetaApiError ? err.responseBody.slice(0, 200) : String(err) })
    }
  }
  return NextResponse.json({ pages: out, webhookVerifyTokenSet: !!process.env.META_WEBHOOK_VERIFY_TOKEN })
}

export async function POST(request: NextRequest) {
  const session = await getSession(request)
  if (!session || session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const out = []
  for (const t of await listBrandPages()) {
    try {
      const ok = await subscribePageToApp(t.platformPageId!, decrypt(t.accessToken), ['feed'])
      const apps = await getPageSubscribedApps(t.platformPageId!, decrypt(t.accessToken))
      out.push({ tokenId: t.id, pageId: t.platformPageId, subscribed: ok, subscribedApps: apps })
    } catch (err) {
      out.push({ tokenId: t.id, pageId: t.platformPageId, subscribed: false, error: err instanceof MetaApiError ? err.responseBody.slice(0, 300) : String(err) })
    }
  }
  return NextResponse.json({ pages: out })
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, hashPassword, verifyPassword } from '@/lib/auth'
import { canProceed } from '@/lib/rate-limiter'

/**
 * POST /api/auth/password — the signed-in user changes their own password.
 *
 * Until 12 Nov 2026 nothing in the platform could change a password: an
 * account kept the one it was created with for ever (the first administrator
 * account still had the password written in the seed script).
 */
const MIN_LENGTH = 10
const MAX_LENGTH = 200

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    // Brake on guessing the current password from a stolen session
    if (!canProceed(`password:${session.id}`, 8, 15 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.', code: 'rate_limited' }, { status: 429 })
    }

    const body = await request.json().catch(() => null)
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current and new password are required', code: 'missing' }, { status: 400 })
    }
    if (newPassword.length < MIN_LENGTH || newPassword.length > MAX_LENGTH) {
      return NextResponse.json({ error: `The new password needs at least ${MIN_LENGTH} characters`, code: 'too_short' }, { status: 400 })
    }
    if (newPassword === currentPassword) {
      return NextResponse.json({ error: 'The new password must be different', code: 'same' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { id: session.id }, select: { id: true, password: true, isActive: true } })
    if (!user || !user.isActive) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    const valid = await verifyPassword(currentPassword, user.password)
    if (!valid) {
      return NextResponse.json({ error: 'The current password is not correct', code: 'wrong_current' }, { status: 403 })
    }

    await prisma.user.update({ where: { id: user.id }, data: { password: await hashPassword(newPassword) } })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Change password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

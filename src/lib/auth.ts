import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { prisma } from './db'

const JWT_SECRET = process.env.JWT_SECRET!

interface TokenPayload {
  userId: string
  role: string
}

interface SessionUser {
  id: string
  email: string
  name: string
  role: string
}

/**
 * Prisma's `mode: 'insensitive'` is ILIKE in PostgreSQL, where % and _ are
 * wildcards and \ is the escape character. Escape a literal value before
 * using it in such a lookup, and still compare the rows found in code.
 */
export function escapeForInsensitiveEquals(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

/** Agency staff. BRAND (client portal) and CREATOR sessions are never staff. */
export function isStaffRole(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'EMPLOYEE'
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function generateToken(userId: string, role: string): string {
  return jwt.sign({ userId, role } satisfies TokenPayload, JWT_SECRET, {
    expiresIn: '7d',
  })
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload
  return { userId: decoded.userId, role: decoded.role }
}

export async function getSession(
  request: NextRequest
): Promise<SessionUser | null> {
  try {
    // Try Authorization header first
    const authHeader = request.headers.get('Authorization')
    let token: string | undefined

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7)
    }

    // Fall back to cookie
    if (!token) {
      token = request.cookies.get('token')?.value
    }

    if (!token) {
      return null
    }

    const payload = verifyToken(token)

    const found = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    })

    if (!found) {
      return null
    }
    // A deactivated account has no session (isActive used to be checked only
    // at login, so a 7-day token outlived the deactivation)
    if (!found.isActive) {
      return null
    }
    // The edge confines BRAND and CREATOR by the role CLAIM of the token while
    // handlers trust the database role: a token minted before a role change
    // would slip past the confinement with the new role. It forces a new login.
    if (found.role !== payload.role) {
      return null
    }

    const user: SessionUser = { id: found.id, email: found.email, name: found.name, role: found.role }
    return user
  } catch {
    return null
  }
}

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

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true, role: true },
    })

    if (!user) {
      return null
    }

    return user
  } catch {
    return null
  }
}

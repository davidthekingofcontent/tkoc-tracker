import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, isStaffRole } from '@/lib/auth'

/**
 * standardFee as stored: null/''/0 clear it (0 used to clear it too), a number
 * or numeric text >= 0 is kept. undefined = invalid (text, negative, other types).
 */
function parseStandardFee(value: unknown): number | null | undefined {
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN
  if (!Number.isFinite(n) || n < 0) return undefined
  return n === 0 ? null : n
}

const isEmailLike = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
const isPhoneLike = (s: string) => /^[0-9+()\-.\s]{6,40}$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 6
const isHttpUrl = (s: string) => {
  try {
    const url = new URL(s)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Optional contact text: null/'' clear it; otherwise trimmed, at most `max` and of the right shape. undefined = invalid. */
function parseContactText(value: unknown, max: number, valid: (s: string) => boolean): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (!s) return null
  return s.length <= max && valid(s) ? s : undefined
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    const influencer = await prisma.influencer.findUnique({
      where: { id },
      include: {
        _count: { select: { campaigns: true, media: true } },
      },
    })

    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    return NextResponse.json({ influencer })
  } catch (error) {
    console.error('Get influencer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Agency staff only (a CREATOR or BRAND session is also stopped at the edge)
    if (!isStaffRole(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'El cuerpo debe ser un objeto JSON.' }, { status: 400 })
    }
    const { standardFee, email, phone, website } = body

    // Validate everything before writing: text used to become a fee of null
    // in silence, and any value was stored as e-mail, phone or website
    const fee = standardFee !== undefined ? parseStandardFee(standardFee) : undefined
    if (standardFee !== undefined && fee === undefined) {
      return NextResponse.json({ error: 'standardFee debe ser un número mayor o igual que 0, o null para quitarlo.' }, { status: 400 })
    }
    const cleanEmail = email !== undefined ? parseContactText(email, 254, isEmailLike) : undefined
    if (email !== undefined && cleanEmail === undefined) {
      return NextResponse.json({ error: 'email debe ser una dirección de correo válida, o null para quitarla.' }, { status: 400 })
    }
    const cleanPhone = phone !== undefined ? parseContactText(phone, 40, isPhoneLike) : undefined
    if (phone !== undefined && cleanPhone === undefined) {
      return NextResponse.json({ error: 'phone debe tener entre 6 y 40 caracteres (cifras, espacios, +, paréntesis, guiones o puntos), o null para quitarlo.' }, { status: 400 })
    }
    const cleanWebsite = website !== undefined ? parseContactText(website, 300, isHttpUrl) : undefined
    if (website !== undefined && cleanWebsite === undefined) {
      return NextResponse.json({ error: 'website debe ser una dirección http(s) completa de como mucho 300 caracteres, o null para quitarla.' }, { status: 400 })
    }

    const existing = await prisma.influencer.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    const influencer = await prisma.influencer.update({
      where: { id },
      data: {
        ...(fee !== undefined && { standardFee: fee }),
        ...(cleanEmail !== undefined && { email: cleanEmail }),
        ...(cleanPhone !== undefined && { phone: cleanPhone }),
        ...(cleanWebsite !== undefined && { website: cleanWebsite }),
      },
    })

    return NextResponse.json({ influencer })
  } catch (error) {
    console.error('Update influencer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

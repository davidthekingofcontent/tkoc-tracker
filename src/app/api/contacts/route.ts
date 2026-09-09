import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CONTACT_ADDRESS_SELECT } from '@/lib/contacts'

const INFLUENCER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  platform: true,
  followers: true,
  engagementRate: true,
  email: true,
  phone: true,
} as const

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const contacts = await prisma.contact.findMany({
      where: { userId: session.id },
      select: {
        id: true,
        influencerId: true,
        status: true,
        lastContacted: true,
        notes: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
        ...CONTACT_ADDRESS_SELECT,
        influencer: { select: INFLUENCER_SELECT },
      },
      orderBy: { updatedAt: 'desc' },
    })

    return NextResponse.json({ contacts })
  } catch (error) {
    console.error('List contacts error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { influencerId, status, notes } = body

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    // Check influencer exists
    const influencer = await prisma.influencer.findUnique({ where: { id: influencerId } })
    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    // Check for duplicate
    const existing = await prisma.contact.findUnique({
      where: { influencerId_userId: { influencerId, userId: session.id } },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'Contact already exists for this influencer' },
        { status: 409 }
      )
    }

    const contact = await prisma.contact.create({
      data: {
        influencerId,
        userId: session.id,
        status: status || 'new',
        notes,
      },
      include: {
        influencer: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            platform: true,
            followers: true,
          },
        },
      },
    })

    return NextResponse.json({ contact }, { status: 201 })
  } catch (error) {
    console.error('Create contact error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---- PATCH: edit the postal address of one of the session user's contacts ----

const ADDRESS_FIELDS = ['addressName', 'address1', 'address2', 'city', 'postCode', 'country', 'phone', 'email'] as const
type AddressField = (typeof ADDRESS_FIELDS)[number]

const MAX_LEN: Record<AddressField, number> = {
  addressName: 200,
  address1: 200,
  address2: 200,
  city: 200,
  postCode: 200,
  country: 200,
  phone: 40,
  email: 200,
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validates one optional string field: undefined = not sent (leave as is);
 * null/'' = clear; otherwise a trimmed string within its limit.
 * Returns { error } for a 400.
 */
function parseField(field: AddressField, v: unknown): { value: string | null | undefined } | { error: string } {
  if (v === undefined) return { value: undefined }
  if (v === null) return { value: null }
  if (typeof v !== 'string') return { error: `${field} must be a string` }
  const t = v.trim()
  if (!t) return { value: null }
  if (t.length > MAX_LEN[field]) return { error: `${field} must be at most ${MAX_LEN[field]} characters` }
  if (field === 'email' && !EMAIL_RE.test(t)) return { error: 'email must look like an email address' }
  return { value: t }
}

/**
 * PATCH /api/contacts — body { id, addressName?, address1?, address2?, city?,
 * postCode?, country?, phone?, email? }. Only the session user's own contact.
 * Sending address1 as ''/null clears the whole address (the other lines make
 * no sense without it). Otherwise only the fields sent are changed. A request
 * that would leave address1 empty while sending other non-empty lines is
 * rejected (400): that data would be discarded or stored invisibly.
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const existing = await prisma.contact.findUnique({ where: { id }, select: { id: true, userId: true, address1: true } })
    if (!existing || existing.userId !== session.id) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const data: Record<string, string | null | Date> = {}
    let touched = false
    for (const field of ADDRESS_FIELDS) {
      const parsed = parseField(field, body[field])
      if ('error' in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }
      if (parsed.value !== undefined) {
        data[field] = parsed.value
        touched = true
      }
    }
    if (!touched) {
      return NextResponse.json({ error: 'No address fields to update' }, { status: 400 })
    }

    const resultingAddress1 = data.address1 !== undefined ? data.address1 : existing.address1
    const otherLinesSent = ADDRESS_FIELDS.some((field) => field !== 'address1' && typeof data[field] === 'string')
    if (!resultingAddress1 && otherLinesSent) {
      // Without a street the address is not an address: the other lines would be
      // dropped (address1 cleared) or stored where nothing reads them.
      return NextResponse.json({ error: 'address1 is required when other address fields are sent' }, { status: 400 })
    }

    if (data.address1 === null) {
      // Clearing the street clears the address as a whole.
      for (const field of ADDRESS_FIELDS) data[field] = null
      data.addressUpdatedAt = null
      data.addressSource = null
    } else {
      data.addressUpdatedAt = new Date()
      data.addressSource = 'manual'
    }

    const contact = await prisma.contact.update({
      where: { id },
      data,
      select: {
        id: true,
        influencerId: true,
        status: true,
        lastContacted: true,
        notes: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
        ...CONTACT_ADDRESS_SELECT,
        influencer: { select: INFLUENCER_SELECT },
      },
    })

    return NextResponse.json({ contact })
  } catch (error) {
    console.error('Update contact error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

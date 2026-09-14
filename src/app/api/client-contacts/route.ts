import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { ClientContactSource, RelationshipType, RelationshipStatus } from '@/generated/prisma/client'

// ---- Query validation: a bad value answers 400 instead of a Prisma 500 ----

function parseEnumParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
  name: string
): { value: T | null } | { error: string } {
  if (!value) return { value: null }
  if ((allowed as readonly string[]).includes(value)) return { value: value as T }
  return { error: `Invalid ${name}. Use one of: ${allowed.join(', ')}` }
}

function parseIntParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
  name: string
): { value: number } | { error: string } {
  if (value === null || value === '') return { value: fallback }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    return { error: `Invalid ${name}: must be an integer between ${min} and ${max}` }
  }
  return { value: n }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') || ''

    const sourceParam = parseEnumParam(searchParams.get('source'), Object.values(ClientContactSource), 'source')
    if ('error' in sourceParam) return NextResponse.json({ error: sourceParam.error }, { status: 400 })
    const typeParam = parseEnumParam(searchParams.get('relationshipType'), Object.values(RelationshipType), 'relationshipType')
    if ('error' in typeParam) return NextResponse.json({ error: typeParam.error }, { status: 400 })
    const statusParam = parseEnumParam(searchParams.get('relationshipStatus'), Object.values(RelationshipStatus), 'relationshipStatus')
    if ('error' in statusParam) return NextResponse.json({ error: statusParam.error }, { status: 400 })
    const pageParam = parseIntParam(searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER, 'page')
    if ('error' in pageParam) return NextResponse.json({ error: pageParam.error }, { status: 400 })
    const limitParam = parseIntParam(searchParams.get('limit'), 25, 1, 100, 'limit')
    if ('error' in limitParam) return NextResponse.json({ error: limitParam.error }, { status: 400 })

    const source = sourceParam.value
    const relationshipType = typeParam.value
    const relationshipStatus = statusParam.value
    const page = pageParam.value
    const limit = limitParam.value
    const skip = (page - 1) * limit

    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { userId: session.id }

    if (search) {
      where.OR = [
        { contactName: { contains: search, mode: 'insensitive' } },
        { contactEmail: { contains: search, mode: 'insensitive' } },
        { companyName: { contains: search, mode: 'insensitive' } },
        { companyDomain: { contains: search, mode: 'insensitive' } },
      ]
    }

    if (source) {
      where.source = source
    }

    if (relationshipType) {
      where.relationshipType = relationshipType
    }

    if (relationshipStatus) {
      where.relationshipStatus = relationshipStatus
    }

    const [contacts, total] = await Promise.all([
      prisma.clientContact.findMany({
        where,
        include: {
          _count: {
            select: { matches: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.clientContact.count({ where }),
    ])

    return NextResponse.json({
      contacts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('List client contacts error:', error)
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
    const { contactName, contactEmail, companyName, companyDomain, socialHandles, phone, tags, relationshipType, relationshipStatus, notes } = body

    if (!contactName || typeof contactName !== 'string' || !contactName.trim()) {
      return NextResponse.json({ error: 'contactName is required' }, { status: 400 })
    }

    const contact = await prisma.clientContact.create({
      data: {
        userId: session.id,
        source: 'MANUAL',
        contactName: contactName.trim(),
        contactEmail: contactEmail || null,
        companyName: companyName || null,
        companyDomain: companyDomain || null,
        socialHandles: socialHandles || null,
        phone: phone || null,
        tags: tags || [],
        relationshipType: (Object.values(RelationshipType).includes(relationshipType) ? relationshipType : 'CUSTOMER') as RelationshipType,
        relationshipStatus: (Object.values(RelationshipStatus).includes(relationshipStatus) ? relationshipStatus : 'ACTIVE') as RelationshipStatus,
        notes: notes || null,
      },
    })

    return NextResponse.json({ contact }, { status: 201 })
  } catch (error) {
    console.error('Create client contact error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { RelationshipType, RelationshipStatus } from '@/generated/prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') || ''
    const source = searchParams.get('source')
    const relationshipType = searchParams.get('relationshipType')
    const relationshipStatus = searchParams.get('relationshipStatus')
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25', 10)))
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

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const where = session.role === 'ADMIN' ? {} : { userId: session.id }

    const templates = await prisma.campaignTemplate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ templates })
  } catch (error) {
    console.error('List templates error:', error)
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
    const { name, type, platforms, country, paymentType, targetAccounts, targetHashtags, briefText } = body

    if (!name) {
      return NextResponse.json({ error: 'Template name is required' }, { status: 400 })
    }

    const template = await prisma.campaignTemplate.create({
      data: {
        name,
        type: type || undefined,
        platforms: platforms || undefined,
        country: country || undefined,
        paymentType: paymentType || undefined,
        targetAccounts: targetAccounts || [],
        targetHashtags: targetHashtags || [],
        briefText: briefText || undefined,
        userId: session.id,
      },
    })

    return NextResponse.json({ template }, { status: 201 })
  } catch (error) {
    console.error('Create template error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

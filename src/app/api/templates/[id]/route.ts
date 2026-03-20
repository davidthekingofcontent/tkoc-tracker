import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    const template = await prisma.campaignTemplate.findUnique({ where: { id } })
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    if (template.userId !== session.id && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.campaignTemplate.delete({ where: { id } })

    return NextResponse.json({ message: 'Template deleted' })
  } catch (error) {
    console.error('Delete template error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

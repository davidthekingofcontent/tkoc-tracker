import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp']
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

// POST: Upload files (stored in DB as binary)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const formData = await request.formData()
    const files = formData.getAll('files') as File[]

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    const uploadedFiles: { id: string; fileName: string; fileSize: number }[] = []

    for (const file of files) {
      // Validate size
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `"${file.name}" excede el límite de 20MB` },
          { status: 400 }
        )
      }

      // Validate extension
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return NextResponse.json(
          { error: `Tipo "${ext}" no permitido. Permitidos: ${ALLOWED_EXTENSIONS.join(', ')}` },
          { status: 400 }
        )
      }

      // Read file data
      const bytes = await file.arrayBuffer()
      const buffer = Buffer.from(bytes)

      // Save to database
      const briefFile = await prisma.briefFile.create({
        data: {
          campaignId: id,
          fileName: file.name,
          fileType: file.type || 'application/octet-stream',
          fileSize: file.size,
          fileData: buffer,
        },
      })

      uploadedFiles.push({
        id: briefFile.id,
        fileName: briefFile.fileName,
        fileSize: briefFile.fileSize,
      })
    }

    return NextResponse.json({
      message: `${uploadedFiles.length} archivo(s) subido(s)`,
      files: uploadedFiles,
    })
  } catch (error) {
    console.error('Brief file upload error:', error)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

// GET: List files for a campaign
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

    const files = await prisma.briefFile.findMany({
      where: { campaignId: id },
      select: {
        id: true,
        fileName: true,
        fileType: true,
        fileSize: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ files })
  } catch (error) {
    console.error('Brief files list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE: Remove a specific file
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
    const { fileId } = await request.json()

    if (!fileId) {
      return NextResponse.json({ error: 'fileId required' }, { status: 400 })
    }

    // Verify file belongs to this campaign
    const file = await prisma.briefFile.findFirst({
      where: { id: fileId, campaignId: id },
    })

    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    await prisma.briefFile.delete({ where: { id: fileId } })

    return NextResponse.json({ message: 'Archivo eliminado' })
  } catch (error) {
    console.error('Brief file delete error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

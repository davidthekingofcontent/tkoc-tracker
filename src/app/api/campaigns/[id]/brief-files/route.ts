import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { writeFile, mkdir, unlink } from 'fs/promises'
import path from 'path'

const ALLOWED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
]

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp']
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

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
      select: { id: true, briefFiles: true },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const formData = await request.formData()
    const files = formData.getAll('files') as File[]

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    // Validate files
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File "${file.name}" exceeds 20MB limit` },
          { status: 400 }
        )
      }

      const ext = path.extname(file.name).toLowerCase()
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return NextResponse.json(
          { error: `File type "${ext}" not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` },
          { status: 400 }
        )
      }
    }

    // Ensure upload directory exists
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'briefs', id)
    await mkdir(uploadDir, { recursive: true })

    const uploadedPaths: string[] = []

    for (const file of files) {
      const bytes = await file.arrayBuffer()
      const buffer = Buffer.from(bytes)

      // Sanitize filename: remove special chars, add timestamp to avoid collisions
      const ext = path.extname(file.name).toLowerCase()
      const baseName = file.name
        .replace(ext, '')
        .replace(/[^a-zA-Z0-9_\-\s]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 50)
      const timestamp = Date.now()
      const fileName = `${baseName}_${timestamp}${ext}`

      const filePath = path.join(uploadDir, fileName)
      await writeFile(filePath, buffer)

      // Store relative URL path
      uploadedPaths.push(`/uploads/briefs/${id}/${fileName}`)
    }

    // Append to existing briefFiles
    const existingFiles = campaign.briefFiles || []
    const allFiles = [...existingFiles, ...uploadedPaths]

    await prisma.campaign.update({
      where: { id },
      data: { briefFiles: allFiles },
    })

    return NextResponse.json({
      message: `${uploadedPaths.length} file(s) uploaded`,
      files: uploadedPaths,
      allFiles,
    })
  } catch (error) {
    console.error('Brief file upload error:', error)
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
    const { filePath } = await request.json()

    if (!filePath) {
      return NextResponse.json({ error: 'filePath required' }, { status: 400 })
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { briefFiles: true },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Remove from DB
    const updatedFiles = (campaign.briefFiles || []).filter(f => f !== filePath)
    await prisma.campaign.update({
      where: { id },
      data: { briefFiles: updatedFiles },
    })

    // Try to delete physical file
    try {
      const fullPath = path.join(process.cwd(), 'public', filePath)
      await unlink(fullPath)
    } catch {
      // File may not exist on disk, that's OK
    }

    return NextResponse.json({ message: 'File removed', files: updatedFiles })
  } catch (error) {
    console.error('Brief file delete error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

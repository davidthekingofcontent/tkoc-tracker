import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// GET: Download/serve a specific file
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id, fileId } = await params

    const file = await prisma.briefFile.findFirst({
      where: { id: fileId, campaignId: id },
    })

    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Check if download is requested
    const download = request.nextUrl.searchParams.get('download') === 'true'

    const headers: Record<string, string> = {
      'Content-Type': file.fileType,
      'Content-Length': file.fileSize.toString(),
      'Cache-Control': 'private, max-age=3600',
    }

    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(file.fileName)}"`
    } else {
      headers['Content-Disposition'] = `inline; filename="${encodeURIComponent(file.fileName)}"`
    }

    return new NextResponse(file.fileData, { headers })
  } catch (error) {
    console.error('Brief file download error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

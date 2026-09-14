import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { PLATFORM_KNOWLEDGE } from '@/lib/ai-knowledge'

// GET /api/knowledge-base → { content: string } (Markdown).
// The content is the in-code platform guide (src/lib/ai-knowledge.ts), the
// same text the AI assistant receives. It used to read KNOWLEDGE_BASE.md from
// disk, which is not shipped in the Docker image (standalone output), so the
// page always showed "Knowledge Base not found" in production.
export async function GET(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  return NextResponse.json({ content: PLATFORM_KNOWLEDGE })
}

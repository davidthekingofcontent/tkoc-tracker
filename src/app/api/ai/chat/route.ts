import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Anthropic from '@anthropic-ai/sdk'

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  return new Anthropic({ apiKey })
}

async function gatherPlatformContext() {
  // Gather real data from the database to give Claude full context
  const [
    campaignCount,
    influencerCount,
    mediaCount,
    campaigns,
    topInfluencers,
    recentMedia,
  ] = await Promise.all([
    prisma.campaign.count({ where: { status: 'ACTIVE' } }),
    prisma.influencer.count(),
    prisma.media.count(),
    prisma.campaign.findMany({
      where: { status: { not: 'ARCHIVED' } },
      include: {
        _count: { select: { influencers: true, media: true } },
        influencers: {
          take: 5,
          include: {
            influencer: {
              select: { username: true, platform: true, followers: true, engagementRate: true, avgLikes: true, avgComments: true, avgViews: true },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    }),
    prisma.influencer.findMany({
      where: { followers: { gt: 0 } },
      orderBy: { followers: 'desc' },
      take: 20,
      select: {
        username: true,
        displayName: true,
        platform: true,
        followers: true,
        engagementRate: true,
        avgLikes: true,
        avgComments: true,
        avgViews: true,
        email: true,
        country: true,
        bio: true,
        lastScraped: true,
      },
    }),
    prisma.media.findMany({
      orderBy: { postedAt: 'desc' },
      take: 30,
      select: {
        mediaType: true,
        likes: true,
        comments: true,
        views: true,
        shares: true,
        hashtags: true,
        postedAt: true,
        influencer: {
          select: { username: true, platform: true },
        },
        campaign: {
          select: { name: true },
        },
      },
    }),
  ])

  // Build a comprehensive data summary
  const campaignSummaries = campaigns.map(c => ({
    name: c.name,
    type: c.type,
    status: c.status,
    platforms: c.platforms,
    hashtags: c.targetHashtags,
    accounts: c.targetAccounts,
    influencerCount: c._count.influencers,
    mediaCount: c._count.media,
    topInfluencers: c.influencers.map(ci => ({
      username: ci.influencer.username,
      platform: ci.influencer.platform,
      followers: ci.influencer.followers,
      engagementRate: ci.influencer.engagementRate,
    })),
  }))

  return {
    overview: {
      activeCampaigns: campaignCount,
      totalInfluencers: influencerCount,
      totalMedia: mediaCount,
    },
    campaigns: campaignSummaries,
    topInfluencers,
    recentMedia: recentMedia.map(m => ({
      type: m.mediaType,
      likes: m.likes,
      comments: m.comments,
      views: m.views,
      shares: m.shares,
      hashtags: m.hashtags,
      postedAt: m.postedAt?.toISOString(),
      influencer: m.influencer.username,
      platform: m.influencer.platform,
      campaign: m.campaign?.name || null,
    })),
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const client = getAnthropicClient()
    if (!client) {
      return NextResponse.json(
        { error: 'AI is not configured. Add ANTHROPIC_API_KEY to enable the AI assistant.' },
        { status: 400 }
      )
    }

    const body = await request.json()
    const { messages } = body as { messages: { role: 'user' | 'assistant'; content: string }[] }

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: 'Messages are required' }, { status: 400 })
    }

    // Gather platform data for context
    const platformData = await gatherPlatformContext()

    const systemPrompt = `Eres el asistente de IA de TKOC Tracker, una plataforma de seguimiento de campañas de influencer marketing de la agencia TKOC. Tu nombre es TKOC AI.

Tu rol es:
1. ANALIZAR datos de campañas, influencers y contenido para dar insights accionables
2. APRENDER de cómo trabaja el equipo y sugerir mejoras
3. RECOMENDAR estrategias basadas en los datos reales de la plataforma
4. RESPONDER preguntas sobre rendimiento de campañas, influencers y tendencias
5. GESTIONAR la plataforma cuando se te pida (sugerir acciones concretas)

Datos actuales de la plataforma:
${JSON.stringify(platformData, null, 2)}

Reglas:
- Responde SIEMPRE en el mismo idioma que el usuario (español si escribe en español, inglés si escribe en inglés)
- Sé conciso pero completo. Usa datos reales, no inventes
- Cuando des insights, basa tus respuestas en los datos reales de la plataforma
- Si te piden que hagas algo en la plataforma, explica paso a paso qué harías
- Usa formateo markdown para hacer las respuestas legibles
- Si no hay datos suficientes, dilo claramente y sugiere qué hacer para mejorar
- Cuando analices engagement, recuerda que >3% es bueno, >5% es excelente
- Cuando compares influencers, considera seguidores, engagement, y tipo de contenido
- Puedes sugerir hashtags, mejores horarios, tipos de contenido basándote en los datos
- Si te preguntan por aprendizajes, analiza tendencias en los datos y da conclusiones accionables`

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    })

    const assistantMessage = response.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')

    return NextResponse.json({
      message: assistantMessage,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    })
  } catch (error) {
    console.error('AI chat error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

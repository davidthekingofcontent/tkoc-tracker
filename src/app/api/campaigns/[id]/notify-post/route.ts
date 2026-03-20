import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createNotification } from '@/lib/notifications'
import { Resend } from 'resend'

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  return new Resend(key)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: campaignId } = await params

    const body = await request.json()
    const { influencerId, mediaUrl, platform, postType } = body as {
      influencerId: string
      mediaUrl: string
      platform: string
      postType?: string
    }

    if (!influencerId || !mediaUrl || !platform) {
      return NextResponse.json(
        { error: 'Missing required fields: influencerId, mediaUrl, platform' },
        { status: 400 }
      )
    }

    // Look up campaign
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        assignments: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        user: { select: { id: true, name: true, email: true } },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Look up influencer
    const influencer = await prisma.influencer.findUnique({
      where: { id: influencerId },
    })

    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    const username = influencer.username
    const campaignName = campaign.name
    const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1).toLowerCase()
    const typeLabel = postType || 'content'

    // Build notification message (bilingual)
    const title = 'Nueva publicacion'
    const message =
      `@${username} ha publicado en ${platformLabel} para la campana ${campaignName}. ` +
      `Ver la publicacion: ${mediaUrl}. ` +
      `Consejo: Espera 7 dias antes de revisar las metricas para ver resultados reales.`
    const link = `/campaigns/${campaignId}`

    // Collect all team members to notify:
    // 1. Campaign owner
    // 2. All assigned users
    const userIds = new Set<string>()
    userIds.add(campaign.userId) // campaign owner
    for (const assignment of campaign.assignments) {
      userIds.add(assignment.userId)
    }

    // Create notifications for each team member
    const notificationPromises = Array.from(userIds).map(userId =>
      createNotification({
        userId,
        type: 'media_posted',
        title,
        message,
        link,
      })
    )
    await Promise.all(notificationPromises)

    // Collect emails for team members
    const emailRecipients: { name: string; email: string }[] = []
    // Campaign owner
    emailRecipients.push({ name: campaign.user.name, email: campaign.user.email })
    // Assigned users
    for (const assignment of campaign.assignments) {
      if (assignment.user.email !== campaign.user.email) {
        emailRecipients.push({ name: assignment.user.name, email: assignment.user.email })
      }
    }

    // Send email notifications via Resend if configured
    const resend = getResend()
    let emailsSent = 0

    if (resend && emailRecipients.length > 0) {
      const emailHtml = buildPostNotificationEmail({
        username,
        platform: platformLabel,
        campaignName,
        mediaUrl,
        postType: typeLabel,
      })

      const emailPromises = emailRecipients.map(async (recipient) => {
        try {
          await resend.emails.send({
            from: 'TKOC Tracker <onboarding@resend.dev>',
            to: [recipient.email],
            subject: `Nueva publicacion: @${username} en ${platformLabel} - ${campaignName}`,
            html: emailHtml,
          })
          emailsSent++
        } catch (err) {
          console.error(`Failed to send email to ${recipient.email}:`, err)
        }
      })

      await Promise.all(emailPromises)
    }

    return NextResponse.json({
      success: true,
      notifiedUsers: userIds.size,
      emailsSent,
      message: `Notified ${userIds.size} team members. ${emailsSent} emails sent.`,
    })
  } catch (error) {
    console.error('Failed to send post notification:', error)
    return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 })
  }
}

// Branded email template with TKOC purple theme
function buildPostNotificationEmail(params: {
  username: string
  platform: string
  campaignName: string
  mediaUrl: string
  postType: string
}): string {
  const { username, platform, campaignName, mediaUrl, postType } = params

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#7c3aed,#6366f1);padding:32px 40px;text-align:center;">
      <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;letter-spacing:-0.5px;">TKOC Tracker</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:8px 0 0;">Nueva Publicacion</p>
    </div>

    <!-- Body -->
    <div style="padding:40px;">
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 16px;">
        @${username} ha publicado en ${platform}
      </h2>

      <div style="background:#f3f4f6;border-radius:12px;padding:20px;margin:0 0 24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="color:#6b7280;font-size:13px;padding:4px 0;">Campana:</td>
            <td style="color:#111827;font-size:13px;font-weight:600;padding:4px 0;text-align:right;">${campaignName}</td>
          </tr>
          <tr>
            <td style="color:#6b7280;font-size:13px;padding:4px 0;">Plataforma:</td>
            <td style="color:#111827;font-size:13px;font-weight:600;padding:4px 0;text-align:right;">${platform}</td>
          </tr>
          <tr>
            <td style="color:#6b7280;font-size:13px;padding:4px 0;">Tipo:</td>
            <td style="color:#111827;font-size:13px;font-weight:600;padding:4px 0;text-align:right;">${postType}</td>
          </tr>
          <tr>
            <td style="color:#6b7280;font-size:13px;padding:4px 0;">Creador:</td>
            <td style="color:#111827;font-size:13px;font-weight:600;padding:4px 0;text-align:right;">@${username}</td>
          </tr>
        </table>
      </div>

      <!-- CTA Button -->
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${mediaUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:12px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
          Ver publicacion
        </a>
      </div>

      <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin:0 0 16px;">
        <p style="color:#92400e;font-size:13px;line-height:1.5;margin:0;">
          <strong>Consejo:</strong> Espera 7 dias antes de revisar las metricas para ver resultados reales.
        </p>
      </div>

      <p style="color:#9ca3af;font-size:13px;line-height:1.5;margin:0;">
        <strong>Tip:</strong> Wait 7 days before checking metrics for accurate results.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:20px 40px;border-top:1px solid #f3f4f6;text-align:center;">
      <p style="color:#d1d5db;font-size:12px;margin:0;">TKOC Tracker &mdash; Influencer Campaign Management</p>
    </div>
  </div>
</body>
</html>`
}

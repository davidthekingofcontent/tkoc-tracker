import { Resend } from 'resend'

let _resend: Resend | null = null
function getResend() {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY)
  }
  return _resend
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://intelligence.thekingofcontent.agency'

export async function sendInvitationEmail({
  to,
  inviterName,
  role,
  token,
}: {
  to: string
  inviterName: string
  role: string
  token: string
}) {
  const acceptUrl = `${APP_URL}/invite/${token}`
  const roleLabel = role.charAt(0) + role.slice(1).toLowerCase()

  const html = `
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
      <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;letter-spacing:-0.5px;">TKOC Intelligence</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:8px 0 0;">Influencer Campaign Tracker</p>
    </div>

    <!-- Body -->
    <div style="padding:40px;">
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 16px;">You've been invited!</h2>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 8px;">
        <strong style="color:#111827;">${inviterName}</strong> has invited you to join <strong style="color:#7c3aed;">TKOC Intelligence</strong> as a <strong style="color:#111827;">${roleLabel}</strong>.
      </p>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 32px;">
        Click the button below to create your account and start collaborating.
      </p>

      <!-- CTA Button -->
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${acceptUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:12px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
          Accept Invitation
        </a>
      </div>

      <p style="color:#9ca3af;font-size:13px;line-height:1.5;margin:0 0 8px;">
        This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
      </p>

      <!-- Fallback URL -->
      <div style="margin-top:24px;padding:16px;background:#f3f4f6;border-radius:8px;">
        <p style="color:#9ca3af;font-size:12px;margin:0 0 4px;">Or copy this link:</p>
        <p style="color:#7c3aed;font-size:12px;word-break:break-all;margin:0;">${acceptUrl}</p>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:20px 40px;border-top:1px solid #f3f4f6;text-align:center;">
      <p style="color:#d1d5db;font-size:12px;margin:0;">TKOC Intelligence &mdash; Creator Intelligence Platform</p>
    </div>
  </div>
</body>
</html>`

  // Use custom domain if available, fallback to resend.dev (limited to owner email only)
  const fromDomain = process.env.RESEND_FROM_DOMAIN || 'onboarding@resend.dev'
  const fromEmail = fromDomain.includes('@') ? fromDomain : `noreply@${fromDomain}`
  const fromAddress = `TKOC Intelligence <${fromEmail}>`

  console.log(`[Email] Sending invitation to ${to} from ${fromAddress}`)

  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress,
      to: [to],
      subject: `${inviterName} invited you to TKOC Intelligence`,
      html,
    })

    if (error) {
      console.error('[Email] Resend API error:', JSON.stringify(error))
      // If it's a domain error, give a helpful message
      if (error.message?.includes('not verified') || error.message?.includes('not a valid')) {
        throw new Error(`Email domain not verified in Resend. Add RESEND_FROM_DOMAIN env variable or verify your domain at resend.com/domains`)
      }
      throw new Error(`Failed to send email: ${error.message}`)
    }

    console.log(`[Email] Sent successfully, id: ${data?.id}`)
    return data
  } catch (err) {
    if (err instanceof Error && err.message.includes('Failed to send')) throw err
    console.error('[Email] Unexpected error:', err)
    throw new Error(`Email service error: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }
}

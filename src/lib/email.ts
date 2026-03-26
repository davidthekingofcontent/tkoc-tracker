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
  locale = 'es',
}: {
  to: string
  inviterName: string
  role: string
  token: string
  locale?: string
}) {
  const acceptUrl = `${APP_URL}/invite/${token}`
  const roleLabel = role.charAt(0) + role.slice(1).toLowerCase()
  const isEs = locale === 'es'

  const t = {
    subtitle: isEs ? 'Plataforma de Inteligencia para Creadores' : 'Creator Intelligence Platform',
    title: isEs ? '¡Has sido invitado!' : "You've been invited!",
    body1: isEs
      ? `<strong style="color:#111827;">${inviterName}</strong> te ha invitado a unirte a <strong style="color:#7c3aed;">TKOC Intelligence</strong> como <strong style="color:#111827;">${roleLabel}</strong>.`
      : `<strong style="color:#111827;">${inviterName}</strong> has invited you to join <strong style="color:#7c3aed;">TKOC Intelligence</strong> as a <strong style="color:#111827;">${roleLabel}</strong>.`,
    body2: isEs
      ? 'Haz clic en el botón de abajo para crear tu cuenta y empezar a colaborar.'
      : 'Click the button below to create your account and start collaborating.',
    cta: isEs ? 'Aceptar Invitación' : 'Accept Invitation',
    expires: isEs
      ? 'Esta invitación caduca en 7 días. Si no esperabas este email, puedes ignorarlo.'
      : 'This invitation expires in 7 days. If you didn\'t expect this email, you can safely ignore it.',
    copyLink: isEs ? 'O copia este enlace:' : 'Or copy this link:',
    subject: isEs
      ? `${inviterName} te ha invitado a TKOC Intelligence`
      : `${inviterName} invited you to TKOC Intelligence`,
  }

  const html = `
<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#7c3aed,#6366f1);padding:32px 40px;text-align:center;">
      <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;letter-spacing:-0.5px;">TKOC Intelligence</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:8px 0 0;">${t.subtitle}</p>
    </div>
    <div style="padding:40px;">
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 16px;">${t.title}</h2>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 8px;">${t.body1}</p>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 32px;">${t.body2}</p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${acceptUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:12px;font-size:15px;font-weight:600;letter-spacing:0.3px;">${t.cta}</a>
      </div>
      <p style="color:#9ca3af;font-size:13px;line-height:1.5;margin:0 0 8px;">${t.expires}</p>
      <div style="margin-top:24px;padding:16px;background:#f3f4f6;border-radius:8px;">
        <p style="color:#9ca3af;font-size:12px;margin:0 0 4px;">${t.copyLink}</p>
        <p style="color:#7c3aed;font-size:12px;word-break:break-all;margin:0;">${acceptUrl}</p>
      </div>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #f3f4f6;text-align:center;">
      <p style="color:#d1d5db;font-size:12px;margin:0;">TKOC Intelligence &mdash; ${t.subtitle}</p>
    </div>
  </div>
</body>
</html>`

  // Use verified domain noreplay.thekingofcontent.agency
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@noreplay.thekingofcontent.agency'
  const fromAddress = `TKOC Intelligence <${fromEmail}>`

  console.log(`[Email] Sending invitation to ${to} from ${fromAddress}`)

  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress,
      to: [to],
      subject: t.subject,
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

export async function sendInfluencerInviteEmail({
  to,
  inviterName,
  campaignName,
  token,
  locale = 'es',
}: {
  to: string
  inviterName: string
  campaignName: string
  token: string
  locale?: string
}) {
  const connectUrl = `${APP_URL}/creators/connect/${token}`
  const isEs = locale === 'es'

  const t = {
    subtitle: isEs ? 'Plataforma de Inteligencia para Creadores' : 'Creator Intelligence Platform',
    title: isEs ? '¡Conecta tu cuenta!' : 'Connect your account!',
    body1: isEs
      ? `<strong style="color:#111827;">${inviterName}</strong> de <strong style="color:#7c3aed;">${campaignName}</strong> te invita a conectar tu cuenta en <strong style="color:#7c3aed;">TKOC Intelligence</strong> para mejorar el seguimiento de tu contenido.`
      : `<strong style="color:#111827;">${inviterName}</strong> from <strong style="color:#7c3aed;">${campaignName}</strong> invites you to connect your account on <strong style="color:#7c3aed;">TKOC Intelligence</strong> for better content tracking.`,
    body2: isEs
      ? 'Conectar tu cuenta nos permite acceder a métricas avanzadas como alcance, impresiones y datos de audiencia.'
      : 'Connecting your account gives us access to advanced metrics like reach, impressions and audience data.',
    cta: isEs ? 'Conectar mi cuenta' : 'Connect my account',
    expires: isEs
      ? 'Esta invitación caduca en 7 días. Si no esperabas este email, puedes ignorarlo.'
      : 'This invitation expires in 7 days. If you didn\'t expect this email, you can safely ignore it.',
    copyLink: isEs ? 'O copia este enlace:' : 'Or copy this link:',
    subject: isEs
      ? `${inviterName} te invita a conectar tu cuenta en TKOC Intelligence`
      : `${inviterName} invites you to connect your account on TKOC Intelligence`,
  }

  const html = `
<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#7c3aed,#6366f1);padding:32px 40px;text-align:center;">
      <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;letter-spacing:-0.5px;">TKOC Intelligence</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:8px 0 0;">${t.subtitle}</p>
    </div>
    <div style="padding:40px;">
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 16px;">${t.title}</h2>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 8px;">${t.body1}</p>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 32px;">${t.body2}</p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${connectUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:12px;font-size:15px;font-weight:600;letter-spacing:0.3px;">${t.cta}</a>
      </div>
      <p style="color:#9ca3af;font-size:13px;line-height:1.5;margin:0 0 8px;">${t.expires}</p>
      <div style="margin-top:24px;padding:16px;background:#f3f4f6;border-radius:8px;">
        <p style="color:#9ca3af;font-size:12px;margin:0 0 4px;">${t.copyLink}</p>
        <p style="color:#7c3aed;font-size:12px;word-break:break-all;margin:0;">${connectUrl}</p>
      </div>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #f3f4f6;text-align:center;">
      <p style="color:#d1d5db;font-size:12px;margin:0;">TKOC Intelligence &mdash; ${t.subtitle}</p>
    </div>
  </div>
</body>
</html>`

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@noreplay.thekingofcontent.agency'
  const fromAddress = `TKOC Intelligence <${fromEmail}>`

  console.log(`[Email] Sending influencer invite to ${to} from ${fromAddress}`)

  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress,
      to: [to],
      subject: t.subject,
      html,
    })

    if (error) {
      console.error('[Email] Resend API error:', JSON.stringify(error))
      if (error.message?.includes('not verified') || error.message?.includes('not a valid')) {
        throw new Error(`Email domain not verified in Resend. Add RESEND_FROM_DOMAIN env variable or verify your domain at resend.com/domains`)
      }
      throw new Error(`Failed to send email: ${error.message}`)
    }

    console.log(`[Email] Influencer invite sent successfully, id: ${data?.id}`)
    return data
  } catch (err) {
    if (err instanceof Error && err.message.includes('Failed to send')) throw err
    console.error('[Email] Unexpected error:', err)
    throw new Error(`Email service error: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }
}

export async function sendBrandAssignmentEmail({
  to,
  employeeName,
  brandName,
  assignedBy,
  locale = 'es',
}: {
  to: string
  employeeName: string
  brandName: string
  assignedBy: string
  locale?: string
}) {
  const isEs = locale === 'es'
  const dashboardUrl = `${APP_URL}/brands`

  const t = {
    subtitle: isEs ? 'Plataforma de Inteligencia para Creadores' : 'Creator Intelligence Platform',
    title: isEs ? '¡Nueva marca asignada!' : 'New brand assigned!',
    body1: isEs
      ? `<strong style="color:#111827;">${assignedBy}</strong> te ha asignado la marca <strong style="color:#7c3aed;">${brandName}</strong> en TKOC Intelligence.`
      : `<strong style="color:#111827;">${assignedBy}</strong> has assigned you to manage <strong style="color:#7c3aed;">${brandName}</strong> on TKOC Intelligence.`,
    body2: isEs
      ? 'Ahora puedes gestionar las campañas de esta marca. Haz clic abajo para empezar.'
      : 'You can now manage campaigns for this brand. Click below to get started.',
    cta: isEs ? 'Ver Marca' : 'View Brand',
    subject: isEs
      ? `Te han asignado la marca ${brandName} en TKOC Intelligence`
      : `You've been assigned to ${brandName} on TKOC Intelligence`,
  }

  const html = `
<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#7c3aed,#6366f1);padding:32px 40px;text-align:center;">
      <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0;">TKOC Intelligence</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:8px 0 0;">${t.subtitle}</p>
    </div>
    <div style="padding:40px;">
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 16px;">${t.title}</h2>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 8px;">${t.body1}</p>
      <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 32px;">${t.body2}</p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${dashboardUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:12px;font-size:15px;font-weight:600;">${t.cta}</a>
      </div>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #f3f4f6;text-align:center;">
      <p style="color:#d1d5db;font-size:12px;margin:0;">TKOC Intelligence &mdash; ${t.subtitle}</p>
    </div>
  </div>
</body>
</html>`

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@noreplay.thekingofcontent.agency'
  const fromAddress = `TKOC Intelligence <${fromEmail}>`

  try {
    const { data, error } = await getResend().emails.send({
      from: fromAddress,
      to: [to],
      subject: t.subject,
      html,
    })
    if (error) {
      console.error('[Email] Brand assignment error:', JSON.stringify(error))
      throw new Error(`Failed to send email: ${error.message}`)
    }
    console.log(`[Email] Brand assignment sent to ${to}, id: ${data?.id}`)
    return data
  } catch (err) {
    if (err instanceof Error && err.message.includes('Failed to send')) throw err
    console.error('[Email] Unexpected error:', err)
    throw new Error(`Email service error: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }
}

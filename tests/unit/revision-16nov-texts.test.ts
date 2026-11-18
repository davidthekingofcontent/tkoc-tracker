/**
 * Coherence of the texts with the delivery «Revisión semanal 16 nov 2026»:
 * the Stories tab notice and the weekly «Stories sin rastrear», the creator
 * history modal, the validation of brand accounts, the Prospect notice, the
 * manual TikTok profile, the real cadence of the capture crons, and the two
 * old sentences that were false (the deal date does travel with «Mover a otra
 * campaña»; the move modal's note). The manual, the digest the assistant
 * reads, the assistant's knowledge and its role must say what the code does,
 * with the words of the screen and of the endpoints, and nothing obsolete.
 *
 * Pure: the texts are imported, the sources are read as text.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_KNOWLEDGE } from '@/lib/ai-knowledge'
import { MANUAL_SECTIONS, MANUAL_TEXT } from '@/lib/manual-content'
import { ACCOUNTS_NOT_BRAND_ERROR, ACCOUNTS_POINTER, GENERIC_ACCOUNTS_ERROR } from '@/lib/campaign-targets'
import { translations } from '@/i18n/translations'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in values ? String(values[k]) : whole))

const es = translations.es
const en = translations.en
const cd = es.campaignDetail
const assistantRole = source('src/app/api/ai/chat/route.ts')
const manualSource = source('src/lib/manual-content.ts')
const manualPage = MANUAL_SECTIONS.map(s => [s.summary, ...s.steps, ...(s.tips ?? []), ...(s.troubleshooting ?? []).flatMap(t => [t.problem, ...t.doWhat])].join('\n')).join('\n')
const storiesRoute = source('src/app/api/campaigns/[id]/stories/route.ts')
const manualRoute = source('src/app/api/campaigns/[id]/media/manual/route.ts')
const storiesCron = source('src/app/api/cron/stories/route.ts')
const prospectNotice = source('src/lib/prospect-notice.ts')
const historyRoute = source('src/app/api/influencers/[id]/history/route.ts')

/** The one text the assistant actually reads is the digest: it has a hard cap, with 20 characters left for another branch. */
describe('the manual digest', () => {
  it('stays within its cap (≤ 11.980 characters, 20 under the 12.000 of the prompt)', () => {
    expect(MANUAL_TEXT.length).toBeLessThanOrEqual(11_980)
  })

  it('names the new notices, buttons and labels', () => {
    for (const phrase of [
      'una vez al día',
      '"Stories sin rastrear"',
      '"Creadoras en Prospecto: la captura no las lee"',
      '"Añadir perfil de TikTok"',
      '"Vincular"',
      '"Publicada hace N días"',
      '"Historial"',
      '"Esta campaña"',
      '"Cuentas a revisar"',
      '"Story guardada: la verás en la pestaña Stories"',
      'aviso ámbar de la pestaña Stories',
    ]) {
      expect(MANUAL_TEXT, phrase).toContain(phrase)
    }
  })

  it('never says the publications are tracked every 6 hours', () => {
    expect(MANUAL_TEXT).not.toContain('cada 6 h')
    expect(MANUAL_TEXT).not.toContain('6 horas')
  })
})

describe('the cadence of the capture crons is what the code does', () => {
  const instrumentation = source('src/instrumentation.ts')

  it('track ticks every 6 h but works once a day (gate 24 h); check-posts gate 24 h; check-deletions with slack', () => {
    expect(instrumentation).toMatch(/name: 'track',\s+path: '\/api\/cron\/track',\s+intervalMs: SIX_HOURS_MS/)
    expect(source('src/app/api/cron/track/route.ts')).toContain("cronGate('track', 24, force)")
    expect(source('src/app/api/cron/check-posts/route.ts')).toContain("cronGate('check-posts', 24, force)")
    expect(source('src/app/api/cron/check-deletions/route.ts')).toMatch(/cronGate\('check-deletions', 24, [^\n]*GATE_SLACK_MS\)/)
  })

  it('the manual page says once a day for posts and never "cada 6 h" as the cadence of the publications', () => {
    expect(manualPage).toContain('posts una vez al día (Apify)')
    expect(manualPage).toContain('publicaciones una vez al día')
    expect(manualPage).toContain('espera al rastreo automático del día siguiente')
    for (const old of ['posts cada 6 h', 'publicaciones cada 6 h', 'ciclo de 6 h']) expect(manualPage, old).not.toContain(old)
  })

  it('the knowledge says once a day for track and check-posts, and keeps the true cadences (stories 12 h, Meta 2 h, watchdog 6 h)', () => {
    expect(PLATFORM_KNOWLEDGE).toContain('- track: UNA VEZ AL DÍA (el planificador lo intenta cada 6 h')
    expect(PLATFORM_KNOWLEDGE).toContain('- check-posts: UNA VEZ AL DÍA (tick cada 12 h, puerta de 24 h)')
    expect(PLATFORM_KNOWLEDGE).toContain('- stories: cada 12 horas')
    expect(PLATFORM_KNOWLEDGE).toContain('- meta-sync: cada 2 horas')
    expect(PLATFORM_KNOWLEDGE).toContain('- watchdog: cada 6 horas')
    for (const old of ['track: cada 6 horas', 'check-posts: cada 12 horas', 'publicaciones cada 6 h', 'publicaciones (cada 6 h)', 'el cron de 6 h', 'siguiente cron (6 h)']) {
      expect(PLATFORM_KNOWLEDGE, old).not.toContain(old)
    }
    expect(PLATFORM_KNOWLEDGE).toContain('su puerta de 24 h abre con 10 minutos de margen')
  })

  it('the assistant role forbids "cada 6 h"', () => {
    expect(assistantRole).toContain('es UNA VEZ AL DÍA: NUNCA digas "cada 6 h"')
  })
})

describe('«Stories sin rastrear» and the amber block of the Stories tab', () => {
  it('the cron sends the notice to the team and the ADMINs, every 7 days, with a second reason; the texts say so', () => {
    expect(storiesCron).toContain("title: 'Stories sin rastrear'")
    expect(storiesCron).toMatch(/role: 'ADMIN', isActive: true/)
    expect(source('src/lib/stories-notices.ts')).toContain('STORIES_NOTICE_REPEAT_MS = 7 * DAY_MS')
    expect(source('src/lib/stories-notices.ts')).toContain('STORIES_NO_CONFIRMED_AFTER_MS = 3 * DAY_MS')
    expect(manualPage).toContain('el aviso "Stories sin rastrear" llega al equipo y a los ADMIN y se repite cada 7 días mientras dure')
    expect(PLATFORM_KNOWLEDGE).toContain('su equipo y los ADMIN activos reciben el aviso "Stories sin rastrear"')
    expect(PLATFORM_KNOWLEDGE).toContain('repetido cada 7 días mientras dure el motivo')
    expect(PLATFORM_KNOWLEDGE).toContain('ninguna de sus creadoras de Instagram está en Acordado o posterior ("0 de N")')
    // The old "once" is gone everywhere («TikTok sin vincular» is still sent once: that one is not this notice)
    for (const text of [manualPage, PLATFORM_KNOWLEDGE, assistantRole]) {
      expect(text).not.toContain('recibe una vez el aviso "Stories sin rastrear"')
      expect(text).not.toContain('recibe UNA vez el aviso "Stories sin rastrear"')
      expect(text).not.toContain('(Social Listening no; si una queda fuera, avisa al equipo)')
      expect(text).not.toContain('(el equipo recibe el aviso "Stories sin rastrear")')
    }
  })

  it('the knowledge quotes the amber notices of the tab as the screen writes them', () => {
    expect(source('src/lib/campaign-capture.ts')).toContain('STORIES_MAX_CAMPAIGN_DAYS = Number(process.env.STORIES_MAX_CAMPAIGN_DAYS || 100)')
    for (const text of [
      cd.storiesScanNoTargets,
      fill(cd.storiesScanNoEndDate, { max: 100 }),
      fill(cd.storiesScanTooLong, { max: 100 }),
      cd.storiesScanInactive,
      cd.storiesScanListening,
      cd.storiesScanWindow,
      fill(cd.storiesScanNoConfirmed, { n: 'N' }),
      fill(cd.storiesScanOk, { n: 'N' }),
      cd.storiesScanNever,
      cd.storiesPostedToday,
      cd.storiesPostedOneDayAgo,
      fill(cd.storiesPostedDaysAgo, { n: 'N' }),
    ]) {
      expect(PLATFORM_KNOWLEDGE, text).toContain(text)
    }
    expect(PLATFORM_KNOWLEDGE).toContain('bloque scan (reason, confirmedCreators, instagramCreators, scannedCreators, lastRunAt, lastResultForCampaign)')
    expect(storiesRoute).toContain('daysSincePosted: daysSincePosted(s.postedAt, now)')
  })

  it('a story older than 24 h is "Publicada hace N días", never "Expirada", in every text', () => {
    expect(manualPage).toContain('una story de más de 24 h aparece como "Publicada hace N días": caduca en Instagram, no en el informe')
    expect(PLATFORM_KNOWLEDGE).toContain('nunca "Expirada": caduca en Instagram, no en el informe')
    expect(assistantRole).toContain('NUNCA digas que una story de más de 24 h está "expirada" o perdida')
    // The old badge of the discovered-stories grid (page.tsx) and its key are gone in both languages
    expect(cd).not.toHaveProperty('storyExpired')
    expect(en.campaignDetail).not.toHaveProperty('storyExpired')
    expect(source('src/app/(dashboard)/campaigns/[id]/page.tsx')).not.toContain('storyExpired')
    expect(cd.storiesExpireNote).toBe('Las stories caducan a las 24 h en Instagram, no en el informe')
  })
})

describe('«Registrar Story» and «Añadir publicación por URL»', () => {
  it('the link may be from any Instagram profile of the creator; the refusals are quoted as the endpoint writes them', () => {
    expect(storiesRoute).toContain('El enlace es de @${owner}, no de @${ci.influencer.username}.')
    expect(storiesRoute).toContain('El enlace es de @${linkOwner}, que es un perfil de @${owner}, no de @${ci.influencer.username}.')
    expect(storiesRoute).toContain('es una Cuenta de Marca Objetivo de esta campaña. Su contenido no se guarda en la fila de @${goesTo}.')
    expect(storiesRoute).toContain('publishedByInfluencerId = credit.self ? null : credit.publisher.influencerId')
    expect(PLATFORM_KNOWLEDGE).toContain('"El enlace es de @x, no de @y." solo aparece cuando ningún perfil de la persona coincide')
    expect(PLATFORM_KNOWLEDGE).toContain('"@x es una Cuenta de Marca Objetivo de esta campaña. Su contenido no se guarda en la fila de @y."')
    expect(PLATFORM_KNOWLEDGE).toContain('anota el perfil que la publicó (publishedByInfluencerId)')
    expect(manualPage).toContain('El enlace puede ser de cualquier perfil de Instagram de la creadora: la story se guarda en su fila anotando el perfil que la publicó.')
    expect(manualPage).toContain('enlace de otra creadora o de la cuenta de la marca')
    // The old wording (refused for any other profile) is gone
    for (const text of [manualPage, PLATFORM_KNOWLEDGE]) expect(text).not.toContain('fecha fuera del periodo o enlace de otra creadora')
  })

  it('a highlight is refused unless the publication date is typed; both routes and both texts agree', () => {
    const typed = 'Los destacados (highlights) no son stories con fecha: registra la story original o indica la "Fecha de publicación" para guardarlo con esa fecha.'
    const urlPath = 'Los destacados (highlights) no son stories con fecha: registra la story original o usa "Registrar Story" con la fecha.'
    expect(storiesRoute).toContain(typed)
    expect(manualRoute).toContain(urlPath)
    expect(PLATFORM_KNOWLEDGE).toContain(typed)
    expect(PLATFORM_KNOWLEDGE).toContain(urlPath)
    expect(manualPage).toContain('Un destacado (highlights) solo se guarda si tecleas la "Fecha de publicación".')
    expect(manualPage).toContain(urlPath)
  })

  it('a story added by URL says it is in the Stories tab and the page opens that tab', () => {
    expect(cd.manualStoryAdded.startsWith('Story guardada: la verás en la pestaña Stories')).toBe(true)
    expect(en.campaignDetail.manualStoryAdded.startsWith('Story saved: you will see it in the Stories tab')).toBe(true)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${cd.manualStoryAdded}"`)
    expect(manualPage).toContain('el mensaje dice "Story guardada: la verás en la pestaña Stories" y la página abre esa pestaña')
    expect(source('src/app/(dashboard)/campaigns/[id]/page.tsx')).toContain("setExecSubTab('sub-stories')")
  })

  it('every manual refusal leaves a [manual-refusal] trace, and the knowledge says so without the figures', () => {
    expect(storiesRoute).toContain("console.warn('[manual-refusal]'")
    expect(manualRoute).toContain("console.warn('[manual-refusal]'")
    expect(PLATFORM_KNOWLEDGE).toContain('Cada rechazo (400/409) de "Registrar Story" queda en el log del servidor (Railway) como [manual-refusal] con campaña, creadora, código, motivo y enlace, nunca las cifras')
    expect(PLATFORM_KNOWLEDGE).toContain('Cada rechazo (400/409) de "Añadir publicación por URL" queda en el log del servidor (Railway) como [manual-refusal]')
  })
})

describe('the «Historial» of a creator (Elegir)', () => {
  it('the route: the person\'s campaigns, newest start date first, reliability over the agreed campaigns only, weights 30/30/20/20', () => {
    expect(historyRoute).toContain('where: { influencerId: { in: profiles.map(p => p.id) } }')
    expect(historyRoute).toContain('.sort(byStartDateDesc)')
    expect(historyRoute).toContain('CLOSED_STATUSES.has(ci.status)')
    expect(historyRoute).toMatch(/engagementScore \* 0\.3 \+\s*reliabilityScore \* 0\.3 \+\s*ratioEmvScore \* 0\.2 \+\s*consistencyScore \* 0\.2/)
    expect(source('src/lib/campaign-overview.ts')).toContain("CLOSED_STATUSES = new Set(['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'])")
  })

  it('the manual has a step for the button with what it shows and where fee, EMV and the score come from', () => {
    const step = MANUAL_SECTIONS.find(s => s.id === 'creadores-trato')!.steps.find(l => l.startsWith('"Historial"'))!
    expect(step).toContain('sumando sus perfiles vinculados de Instagram, TikTok o YouTube')
    expect(step).toContain('de la más reciente a la más antigua por fecha de inicio y con el mes de cada una')
    expect(step).toContain('el fee acordado (si no hay, el coste), el estado, el EMV de esa campaña y el Ratio EMV (EMV dividido por el coste)')
    expect(step).toContain(`"${es.influencerHistory.thisCampaign}"`)
    expect(step).toContain('estar en Prospecto, Contacto o Negociando no cuenta ni penaliza')
    expect(step).toContain('Es solo de agencia.')
  })

  it('the knowledge details the modal with the labels of the screen and the formula', () => {
    for (const label of [es.influencerHistory.title, es.influencerHistory.overallScore, es.influencerHistory.thisCampaign, es.influencerHistory.reliabilityNoBasis]) {
      expect(PLATFORM_KNOWLEDGE, label).toContain(`"${label}"`)
    }
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(es.influencerHistory.reliabilityBasis, { delivered: 'N', closed: 'M' })}"`)
    expect(PLATFORM_KNOWLEDGE).toContain('engagement del perfil 30 %, "Fiabilidad" 30 %, "Ratio EMV" 20 % y "Consistencia" 20 %')
    expect(PLATFORM_KNOWLEDGE).toContain('un Prospecto, Contacto o Negociando nunca cuenta ni penaliza')
    expect(PLATFORM_KNOWLEDGE).not.toContain('Historial de colaboraciones previas de cada creador, Duplicados')
  })

  it('Envío (SHIPPING) is a pipeline label in both languages and counts as agreed', () => {
    expect(es.pipeline.shipping).toBe('Envío')
    expect(en.pipeline.shipping).toBe('Shipping')
    expect(PLATFORM_KNOWLEDGE).toContain('El estado Envío (SHIPPING) cuenta como estado acordado (cerrado')
    expect(source('src/app/(dashboard)/methodology/page.tsx')).toContain('Estar en Prospecto, Contacto o Negociando no cuenta ni penaliza')
  })
})

describe('the validation of the Cuentas de Marca Objetivo', () => {
  it('the pointer sentence of the 400 is the one agreed, quoted in the manual and the knowledge', () => {
    expect(ACCOUNTS_POINTER).toBe('Pon las palabras del producto en Palabras clave del producto; aquí van solo las cuentas de la marca o del distribuidor.')
    expect(manualPage).toContain(`"${ACCOUNTS_POINTER}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${ACCOUNTS_POINTER}"`)
    expect(MANUAL_TEXT).toContain('Palabras clave')
    expect(PLATFORM_KNOWLEDGE).toContain(`"${GENERIC_ACCOUNTS_ERROR.slice(0, GENERIC_ACCOUNTS_ERROR.indexOf(':') + 1)} …"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${ACCOUNTS_NOT_BRAND_ERROR}"`)
    expect(PLATFORM_KNOWLEDGE).toContain('código genericAccounts')
    expect(PLATFORM_KNOWLEDGE).toContain('código accountsNotBrand')
  })

  it('the escape routes (the brand is chosen at creation; the distributor in the campaign name) and the connected Instagram are stated', () => {
    expect(manualPage).toContain('si el usuario legítimo de la marca coincide con una palabra común, la campaña necesita tener asignada esa marca (se elige al crearla en "Nueva Campaña"; el Asistente y "Editar Campaña" no asignan marca); si es la cuenta del distribuidor con otro nombre, incluye ese nombre en el nombre de la campaña (p. ej. "Dorco x Deliplus"; una letra de diferencia, "Delyplus", también vale)')
    // Rule (b) needs an attached brand: the campaign's name alone never refuses an account (18 Nov 2026)
    expect(manualPage).toContain('Sin marca asignada, el nombre de la campaña no rechaza nada.')
    expect(PLATFORM_KNOWLEDGE).toContain('SOLO cuando la campaña tiene marca asignada')
    expect(PLATFORM_KNOWLEDGE).toContain('Sin marca asignada, el nombre de la campaña nunca rechaza una cuenta')
    // No text promises a step that does not exist (the wizard and the edit modal have no brand field)
    for (const text of [manualPage, PLATFORM_KNOWLEDGE]) {
      expect(text).not.toContain('asigna a la campaña la marca con ese nombre y vuelve a guardar')
      expect(text).not.toContain('coincide con una palabra común, asigna la marca a la campaña')
    }
    expect(manualPage).toContain('La cuenta de Instagram conectada por Meta siempre se acepta.')
    expect(PLATFORM_KNOWLEDGE).toContain('Solo actúa al escribir: una campaña que ya tenga cuentas así se sigue leyendo y guarda sus otros campos.')
  })

  it('a word without @ or # is never discarded in silence: the screens ask, with the labels of the screen', () => {
    expect(manualPage).toContain(`"${es.campaigns.bareTargetsAsAccounts}"`)
    expect(manualPage).toContain(`"${es.campaigns.bareTargetsAsKeywords}"`)
    expect(manualPage).toContain('nada se descarta en silencio')
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(es.campaigns.bareTargetsNotice, { tokens: '"turbo"' })}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${es.campaigns.bareTargetsAsAccounts}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${es.campaigns.bareTargetsAsKeywords}"`)
    expect(manualPage).not.toContain('se ignora')
  })
})

describe('the Prospect notice and the manual TikTok profile', () => {
  it('the notice has one title and one sentence in the code, the manual, the knowledge and the role', () => {
    expect(prospectNotice).toContain("title: 'Creadoras en Prospecto: la captura no las lee'")
    expect(prospectNotice).toContain('PROSPECT_NOTICE_MIN_DAYS = 3')
    expect(prospectNotice).toContain('PROSPECT_NOTICE_SHARE = 0.5')
    expect(prospectNotice).toContain('PROSPECT_NOTICE_REPEAT_DAYS = 7')
    const sentence = fill(cd.prospectNotice, { n: 'N', m: 'M' })
    expect(manualPage).toContain(`"${sentence.replace(/\.$/, '')}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${sentence}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(cd.prospectNoticeNoneReadable, { n: 'N', m: 'M' }).replace(/^La captura automática \(publicaciones, stories, TikTok\) solo lee creadoras en Acordado o posterior: /, '…')}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${cd.prospectNoticeHint}"`)
    expect(PLATFORM_KNOWLEDGE).toContain('captureNotice {members, prospects, scanning, startedDays}')
    for (const text of [manualPage, PLATFORM_KNOWLEDGE, assistantRole]) expect(text).toContain('"Creadoras en Prospecto: la captura no las lee"')
    // Both checklists start by it
    const stories = MANUAL_SECTIONS.flatMap(s => s.troubleshooting ?? []).find(t => t.problem === 'No salen stories')!
    const tiktok = MANUAL_SECTIONS.flatMap(s => s.troubleshooting ?? []).find(t => t.problem === 'No cuenta los vídeos de TikTok')!
    expect(stories.doWhat[0]).toContain('aviso ámbar de la pestaña Stories')
    expect(stories.doWhat[0]).toContain('aviso de creadoras en Prospecto')
    expect(tiktok.doWhat[0]).toContain('aviso de creadoras en Prospecto')
  })

  it('«Añadir perfil de TikTok» → «Vincular»: the button, the route, the rules and the connector gap', () => {
    const route = source('src/app/api/influencers/[id]/link-profile/route.ts')
    expect(route).toContain("evidence: 'pm_manual'")
    expect(route).toContain("code: 'brand_account'")
    expect(route).toContain("code: 'other_person'")
    expect(route).toContain('isStaffRole(session.role)')
    expect(cd.addTikTokProfile).toBe('Añadir perfil de TikTok')
    expect(cd.tiktokLinkSave).toBe('Vincular')
    expect(manualPage).toContain('pulsa "Añadir perfil de TikTok", escribe el usuario (con o sin @) o pega la URL de su perfil y pulsa "Vincular"')
    expect(manualPage).toContain('No se puede registrar una cuenta de la marca ni un perfil que ya es de otra persona')
    expect(manualPage).toContain('si no, regístralo con "Añadir perfil de TikTok" en su tarjeta de Elegir')
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(cd.tiktokLinkedToast, { handle: 'usuario', creator: 'X' })}"`)
    expect(PLATFORM_KNOWLEDGE).toContain('POST /api/influencers/[id]/link-profile')
    expect(PLATFORM_KNOWLEDGE).toContain('El conector MCP no tiene herramienta para esto todavía.')
    expect(source('src/lib/mcp/tools/write/creators.ts')).not.toContain('link_profile')
    expect(assistantRole).toContain('"Añadir perfil de TikTok" en su tarjeta de Elegir lo registra sin vídeo')
    // The header of the knowledge no longer keeps the superseded paths as current
    expect(source('src/lib/ai-knowledge.ts')).not.toContain('(otro usuario: URL completa en Elegir);')
    expect(source('src/lib/ai-knowledge.ts')).not.toContain('(cada cuenta de TikTok\n * sigue siendo su propia fila)')
  })
})

describe('tracking rules of 16 Nov 2026 in the knowledge and the manual', () => {
  it('ended campaigns, country filter, unsupported mentions and the in-flight lock', () => {
    expect(source('src/lib/campaign-ended.ts')).toContain('CAMPAIGN_ENDED_GRACE_DAYS = 3')
    expect(manualPage).toContain('Las campañas terminadas hace más de 3 días dejan de rastrearse')
    expect(manualPage).toContain('una creadora añadida en Elegir (o un perfil vinculado suyo) nunca se salta por su país')
    expect(manualPage).toContain('Las menciones de la marca solo se leen en Instagram')
    expect(manualPage).toContain('nunca corre dos veces a la vez')
    expect(PLATFORM_KNOWLEDGE).toContain("campaignsSkipped con motivo 'ended'")
    expect(PLATFORM_KNOWLEDGE).toContain('countrySkippedMembers siempre 0')
    expect(PLATFORM_KNOWLEDGE).toContain('unsupportedMentions')
    expect(PLATFORM_KNOWLEDGE).toContain("{skipped: 'in_flight'}")
    expect(PLATFORM_KNOWLEDGE).toContain('espera como mucho 2 min a check-posts y a track y anota "started"')
    expect(source('src/lib/cron-outcome.ts')).toContain('LONG_RUNNING_CRON_WAIT_MS = 2 * 60 * 1000')
  })

  it('gender is inferred at intake from the public name only; the database order covers every creator', () => {
    expect(manualPage).toContain('lo infiere solo del nombre público (nunca de la bio ni de la foto), en cuanto la ficha entra en la base o se vuelve a leer')
    expect(PLATFORM_KNOWLEDGE).toContain('el género se infiere también al dar de alta o releer una ficha')
    expect(PLATFORM_KNOWLEDGE).toContain('nunca pisa un valor existente ni uno "manual"')
    expect(manualPage).toContain('"Ordenar por seguidores o engagement" ordena toda la base')
    expect(PLATFORM_KNOWLEDGE).toContain('"Ordenar por seguidores / engagement" lo ordena la base de datos sobre TODAS las creadoras que cumplen los filtros')
  })
})

describe('the two sentences that were false', () => {
  it('the deal date DOES travel with «Mover a otra campaña»: the route copies it and no text lists it as "not travelling"', () => {
    expect(source('src/app/api/campaigns/[id]/influencers/move/route.ts')).toContain('dealClosedAt: r.agreedFee != null && r.agreedFee > 0 ? (r.dealClosedAt ?? new Date()) : null')
    expect(PLATFORM_KNOWLEDGE).not.toContain('la línea base, la fecha de cierre del acuerdo, "Contenido Entregado"')
    expect(PLATFORM_KNOWLEDGE).toContain('la fecha de cierre del acuerdo (se copia; si había fee sin fecha, se sella al trasladar; sin fee acordado no hay fecha)')
    expect(manualPage).toContain('Viajan fee acordado (con su fecha de cierre) y solicitado')
  })

  it('the manual and the knowledge quote the CURRENT note of the move modal', () => {
    expect(es.campaignDetail.moveNote).toContain('(con su fecha de cierre)')
    expect(manualSource).toContain(`"${es.campaignDetail.moveNote}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${es.campaignDetail.moveNote}"`)
    for (const text of [manualSource, PLATFORM_KNOWLEDGE]) {
      expect(text).not.toContain('"Se conservan fee acordado, entregables y notas; el estado pasa a Prospecto en la campaña de destino. El contenido capturado se queda en esta campaña."')
    }
  })
})

describe('notifications', () => {
  it('the two team-and-ADMIN weekly notices are listed where the notifications are explained', () => {
    const access = MANUAL_SECTIONS.find(s => s.id === 'acceso')!.steps.find(l => l.startsWith('Notificaciones'))!
    expect(access).toContain('"Stories sin rastrear"')
    expect(access).toContain('"Creadoras en Prospecto: la captura no las lee"')
    expect(access).toContain('llegan al equipo de la campaña y también a los ADMIN, y se repiten cada 7 días mientras dure el motivo')
    expect(PLATFORM_KNOWLEDGE).toContain('Dos avisos van al equipo de la campaña Y a los ADMIN activos (cada persona una vez) y se repiten cada 7 días mientras dure el motivo (16 nov. 2026): "Stories sin rastrear" (Paso 5, stories) y "Creadoras en Prospecto: la captura no las lee" (Paso 5, aviso de Prospecto).')
  })

  it('no long dashes in the sentences people receive', () => {
    for (const text of [cd.prospectNotice, cd.prospectNoticeHint, cd.tiktokLinkedToast, cd.manualStoryAdded, cd.storiesScanNoTargets, cd.storiesScanNoConfirmed]) {
      expect(text).not.toMatch(/[—–]/)
    }
  })
})

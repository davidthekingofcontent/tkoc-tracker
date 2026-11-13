/**
 * Coherence of the texts with the behaviour of delivery 1 («una creadora =
 * una persona con varios perfiles»). The assistant's knowledge, its role, the
 * manual digest and the hints on screen must say what the code does, with the
 * words the screen and the endpoint use, and nothing of the later deliveries.
 *
 * Pure: the texts are imported, the route sources are read as text.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_KNOWLEDGE } from '@/lib/ai-knowledge'
import { MANUAL_TEXT } from '@/lib/manual-content'
import { translations } from '@/i18n/translations'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const manualRoute = source('src/app/api/campaigns/[id]/media/manual/route.ts')
const assistantRole = source('src/app/api/ai/chat/route.ts')
const es = translations.es.campaignDetail
const en = translations.en.campaignDetail

describe('the assistant describes «¿De quién es esta publicación?» with the words of the screen', () => {
  it('quotes the title, the selector, the button, the checkbox and the warning exactly', () => {
    for (const text of [es.linkProfileTitle, es.linkProfileSelectLabel, es.linkProfileConfirm, es.linkProfileConfirmCheckbox, es.linkProfileUnverified]) {
      expect(PLATFORM_KNOWLEDGE, text).toContain(text)
    }
  })

  it('quotes the question and the confirmation as the screen fills them', () => {
    const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
    expect(PLATFORM_KNOWLEDGE).toContain(fill(es.linkProfileBody, { author: 'autor', network: 'TikTok' }))
    expect(PLATFORM_KNOWLEDGE).toContain(fill(es.linkProfileAdded, { author: 'autor', creator: 'creadora' }))
  })

  it('quotes the refusals of the endpoint exactly as the endpoint writes them', () => {
    for (const sentence of [
      'No he podido abrir ese enlace corto. Abre la publicación en el navegador y pega el enlace completo.',
      'No he podido leer de quién es esta publicación. Inténtalo en unos minutos o pega el enlace con el usuario.',
    ]) {
      expect(manualRoute, sentence).toContain(sentence)
      expect(PLATFORM_KNOWLEDGE, sentence).toContain(sentence)
    }
    // «…que es un perfil de @X, no de @Y.»: the template of the endpoint, quoted with @X and @Y
    expect(manualRoute).toContain('que es un perfil de @${member.username}, no de @${claimed.username}.')
    expect(PLATFORM_KNOWLEDGE).toContain('que es un perfil de @X, no de @Y.')
  })
})

describe('the refusals and notices added after the review are quoted as the code writes them', () => {
  it('a brand account of the campaign is never a profile of a creator: endpoint and knowledge say the same', () => {
    expect(manualRoute).toContain('es una Cuenta de Marca Objetivo de esta campaña. No se puede registrar como perfil de una creadora.')
    expect(PLATFORM_KNOWLEDGE).toContain('"@cuenta es una Cuenta de Marca Objetivo de esta campaña. No se puede registrar como perfil de una creadora."')
    expect(PLATFORM_KNOWLEDGE).toContain('ni lee como TikTok de una creadora una Cuenta de Marca Objetivo de la campaña')
  })

  it('the brand\'s own connected Instagram is never a profile of a creator either: endpoint and knowledge say the same', () => {
    expect(manualRoute).toContain('es la cuenta de la marca de esta campaña. No se puede registrar como perfil de una creadora.')
    expect(PLATFORM_KNOWLEDGE).toContain('"@cuenta es la cuenta de la marca de esta campaña. No se puede registrar como perfil de una creadora."')
  })

  it('the form takes one link at a time, and the knowledge quotes its messages as the screen fills them', () => {
    const page = source('src/app/(dashboard)/campaigns/[id]/page.tsx')
    expect(page).toContain("'Añadiendo…'")
    expect(PLATFORM_KNOWLEDGE).toContain('el botón muestra "Añadiendo…"')
    expect(es.manualLinkOf).toBe('{network} de @{handle}')
    expect(es.manualLinkKindDate).toBe('{kind} del {date}')
    expect(PLATFORM_KNOWLEDGE).toContain(`"${es.manualResultAdded.replace('{link}', 'TikTok de @usuario (vídeo del 21 oct)')}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${es.manualResultUpdated.replace('{link}', '…')}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${es.manualResultNotAdded.replace('{link}', '…')}"`)
  })

  it('one row per creator with her networks: report, export and knowledge say the same', () => {
    expect(PLATFORM_KNOWLEDGE).toContain(translations.es.campaignReport.creatorsFootnoteNetworks)
    const exportRoute = source('src/app/api/campaigns/[id]/export/route.ts')
    expect(exportRoute).toContain("'Plataforma', 'Redes',")
    expect(PLATFORM_KNOWLEDGE).toContain('RENDIMIENTO POR CREADOR (una fila por creadora; "Redes":')
    expect(PLATFORM_KNOWLEDGE).toContain('"Instagram: 2 | TikTok: 1"')
  })

  it('the notice of the daily pass has the title the knowledge names', () => {
    expect(source('src/lib/tiktok-autolink.ts')).toContain("title: 'TikTok sin vincular'")
    expect(PLATFORM_KNOWLEDGE).toContain('"TikTok sin vincular"')
  })

  it('the knowledge quotes the sentence of the dialog when the author read again is another one', () => {
    const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
    expect(PLATFORM_KNOWLEDGE).toContain(fill(es.linkProfileAuthorChanged, { author: 'autor', network: 'TikTok' }))
  })
})

describe('what the assistant is told about each recent piece', () => {
  it('carries the network of the PUBLICATION, not the network of the creator it is filed under', () => {
    const start = assistantRole.indexOf('recentMedia: recentMedia.map(')
    expect(start).toBeGreaterThan(-1)
    const block = assistantRole.slice(start, assistantRole.indexOf('}))', start))
    // A creator's TikTok video is stored under her Instagram row with Media.platform = TIKTOK
    expect(block).toMatch(/\bplatform: m\.platform\b/)
    expect(block).not.toContain('m.influencer.platform')
    // …and the query that feeds it reads Media.platform
    const query = assistantRole.slice(assistantRole.indexOf("orderBy: { postedAt: 'desc' }"), start)
    expect(query).toMatch(/select: \{[\s\S]*?\bplatform: true,[\s\S]*?influencer: \{ select:/)
  })
})

describe('the rule of delivery 1 is stated everywhere', () => {
  it('the manual digest given to the assistant has the rule and the path, within its cap', () => {
    expect(MANUAL_TEXT).toContain('Una creadora = una persona con varios perfiles')
    expect(MANUAL_TEXT).toContain(es.linkProfileTitle)
    expect(MANUAL_TEXT).toContain(es.linkProfileConfirm)
    expect(MANUAL_TEXT).toContain('no se fusionan solas')
    expect(MANUAL_TEXT.length).toBeLessThanOrEqual(12_000)
  })

  it('the knowledge says: one person, several profiles, no new member, short links, nothing merged automatically', () => {
    expect(PLATFORM_KNOWLEDGE).toContain('Una creadora es UNA PERSONA con varios perfiles')
    expect(PLATFORM_KNOWLEDGE).toContain('nunca se crea un miembro nuevo')
    expect(PLATFORM_KNOWLEDGE).toContain('vm.tiktok.com')
    expect(PLATFORM_KNOWLEDGE).toContain('no se fusionan solas')
    // The daily TikTok pass: a profile, not a member
    expect(PLATFORM_KNOWLEDGE).toContain('no como una creadora más')
  })

  it('the role of the assistant forbids the answers of the old rule', () => {
    expect(assistantRole).toContain('NUNCA digas que la cuenta de TikTok de una creadora hay que añadirla en Elegir')
    expect(assistantRole).toContain('NUNCA digas que los enlaces cortos no valen')
    expect(assistantRole).toContain('se fusionan solas')
  })
})

describe('the twins folded on 12 Nov 2026 (src/lib/person-fold.ts) count once, and every text says so', () => {
  const manualSource = source('src/lib/manual-content.ts')

  it('the knowledge: they were joined to the creator’s row, her pieces summed and counted once, and the campaigns that dropped', () => {
    expect(PLATFORM_KNOWLEDGE).toContain('hasta el 12 nov. 2026) se han unido a la fila de su creadora: su cuenta de TikTok queda registrada como perfil suyo')
    expect(PLATFORM_KNOWLEDGE).toContain('sus publicaciones se suman en la fila de la creadora (cada una con su red real) y la creadora cuenta UNA vez')
    expect(PLATFORM_KNOWLEDGE).toContain('"10.- Vileda - Micros Octubre" pasó de 40 a 36 creadoras, 27 con contenido; "Dorco - Delyplus", de 30 a 28')
    // What is NOT folded (the blockers of the fold) still counts apart
    expect(PLATFORM_KNOWLEDGE).toContain('NO se ha unido y sigue contando aparte hasta que alguien la revise')
    // The old sentences, false for every folded twin
    expect(PLATFORM_KNOWLEDGE).not.toContain('o por la vinculación automática de sus primeros días, que entonces la añadía como una creadora más en estado Publicado) sigue como estaba')
    expect(PLATFORM_KNOWLEDGE).not.toContain('Las creadoras que ya estaban dos veces en una campaña (dos filas) no se fusionan solas: cada fila sigue contando aparte.')
    expect(PLATFORM_KNOWLEDGE).not.toContain('Las cuentas de TikTok que ya estaban en la campaña como creadora aparte (su propia fila) siguen igual')
    expect(PLATFORM_KNOWLEDGE).not.toContain('las creadoras que ya estaban dadas de alta dos veces (la misma persona con dos filas, por ejemplo su Instagram y su TikTok) NO se fusionan solas')
  })

  it('the assistant role: never says a folded row still counts apart', () => {
    expect(assistantRole).toContain('ya se han unido a la fila de su creadora')
    expect(assistantRole).toContain('NUNCA digas que esas filas unidas siguen contando aparte')
    expect(assistantRole).not.toContain('NUNCA digas que las creadoras que ya están dos veces en una campaña se fusionan solas: cada fila sigue contando aparte')
  })

  it('the manual page: the same, in the creators section and in «No cuenta los vídeos de TikTok»', () => {
    expect(manualSource).toContain('Las filas de más que creaba la vinculación de TikTok hasta el 12 nov. 2026 se han unido a la fila de su creadora')
    expect(manualSource).toContain('(hasta el 12 nov. 2026) se han unido a la fila de su creadora')
    expect(manualSource).not.toContain('Las cuentas de TikTok que ya estaban en la campaña como una creadora más (su propia fila) siguen igual')
    expect(manualSource).not.toContain('Las creadoras que ya estaban dos veces en una campaña (por ejemplo, su Instagram y su TikTok como dos filas) no se fusionan solas')
  })
})

describe('nothing tells a PM to add a TikTok account as another creator any more', () => {
  it('the old refusal of the endpoint is gone from the code and from every text', () => {
    const old = 'Si es la cuenta de TikTok de'
    for (const text of [manualRoute, assistantRole, PLATFORM_KNOWLEDGE, MANUAL_TEXT, source('src/lib/manual-content.ts'), source('src/lib/tiktok-autolink.ts')]) {
      expect(text).not.toContain(old)
    }
    expect(manualRoute).not.toContain('Los enlaces acortados no valen')
  })

  it('the hint under the creators list sends her to «Añadir publicación por URL», in both languages', () => {
    expect(es.tiktokHint).not.toContain('URL completa de TikTok')
    expect(en.tiktokHint).not.toContain('full TikTok URL')
    expect(es.tiktokHint).toContain('"Añadir publicación por URL"')
    expect(en.tiktokHint).toContain('"Add post by URL"')
    expect(es.tiktokHint).toContain('No añadas su TikTok como otro creador')
    for (const hint of [es.tiktokHint, en.tiktokHint]) expect(hint).not.toMatch(/[—–]/)
  })
})

describe('later deliveries are not announced', () => {
  // «fuera de plazo» (manual paths) and the merge tool («fusionar») shipped on
  // 13 Nov 2026 and are stated now: see tests/unit/merge-late-texts.test.ts.
  // The tray and the automatic capture of late posts are still to come.
  it('no tray, no per-network breakdown in the texts', () => {
    for (const text of [PLATFORM_KNOWLEDGE, MANUAL_TEXT, assistantRole]) {
      for (const phrase of ['pendientes de asignar', 'desglose por plataforma', 'desglose por red']) {
        expect(text, phrase).not.toContain(phrase)
      }
    }
  })
})

/**
 * Coherence of the texts with the delivery of 13 Nov 2026: «Fichas duplicadas»
 * (the merge tool, ADMIN only) and publications «fuera de plazo» (manual
 * paths). The manual, the assistant's knowledge, its role and Metodología must
 * say what the code does, quoting the screen and the endpoints word for word,
 * and the assistant must never say a post after the end is always refused.
 *
 * Pure: the texts are imported, the sources are read as text.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_KNOWLEDGE } from '@/lib/ai-knowledge'
import { MANUAL_SECTIONS, MANUAL_TEXT } from '@/lib/manual-content'
import { LATE_ACCEPT_MAX_DAYS } from '@/lib/assignment-rules'
import { translations } from '@/i18n/translations'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in values ? String(values[k]) : whole))

const pm = translations.es.personMerge
const report = translations.es.campaignReport
const detail = translations.es.campaignDetail
const assistantRole = source('src/app/api/ai/chat/route.ts')
const rules = source('src/lib/assignment-rules.ts')
const manualPage = MANUAL_SECTIONS.map(s => [s.summary, ...s.steps, ...(s.tips ?? []), ...(s.troubleshooting ?? []).flatMap(t => [t.problem, ...t.doWhat])].join('\n')).join('\n')

describe('the manual', () => {
  it('the digest given to the assistant has both rules, within its cap', () => {
    expect(MANUAL_TEXT.length).toBeLessThanOrEqual(12_000)
    expect(MANUAL_TEXT).toContain('"Fichas duplicadas"')
    expect(MANUAL_TEXT).toContain(`"${pm.review}"`)
    expect(MANUAL_TEXT).toContain(`"${pm.confirmYes}"`)
    expect(MANUAL_TEXT).toContain('"Fuera de plazo" (hasta 30 días, si le falta entregar; una sola campaña; el cliente no lo ve)')
    expect(MANUAL_TEXT).toContain('no se fusionan solas')
  })

  it('the page explains how to merge, with the labels of the screen', () => {
    for (const label of [pm.review, pm.modeLink, pm.modeAbsorb, pm.merge, pm.confirmYes, pm.dismiss, pm.undo]) {
      expect(manualPage, label).toContain(`"${label}"`)
    }
    expect(manualPage).toContain(`"${fill(pm.noticeMany, { n: 'N' })} ${pm.noticeLinkMany}"`)
  })

  it('the page explains the late rule: 30 days, only if she owes, one campaign, never to the client', () => {
    expect(manualPage).toContain('hasta 30 días después del fin')
    expect(manualPage).toContain('a la creadora le falta entregar')
    expect(manualPage).toContain('Cuenta en una sola campaña')
    expect(manualPage).toContain('El cliente nunca lo ve: ni en el portal, ni en el PDF, ni en las exportaciones.')
    expect(manualPage).toContain(`"${fill(detail.manualDetailLate, { days: 'N días' })}"`)
    expect(manualPage).toContain(`"${fill(report.lateBadge, { days: 'N días' })}"`)
    // The old sentence (every post after the end refused) is gone
    expect(manualPage).not.toContain('La fecha tiene que estar dentro de la campaña; si no, se rechaza con un mensaje.')
  })
})

describe('the assistant\'s knowledge', () => {
  it('the merge tool: where it is, who may use it, its steps with the exact labels, undo and dismiss', () => {
    expect(PLATFORM_KNOWLEDGE).toContain('## 23. Fichas duplicadas y publicaciones fuera de plazo')
    expect(PLATFORM_KNOWLEDGE).toContain('Fichas duplicadas (/creators/duplicadas): SOLO ADMIN')
    for (const label of [pm.review, pm.keepQuestion, pm.modeQuestion, pm.modeLink, pm.modeAbsorb, pm.merge, pm.confirmTitle, pm.confirmYes, pm.undoForce, pm.dismiss, pm.strength.double_count]) {
      expect(PLATFORM_KNOWLEDGE, label).toContain(`"${label}"`)
    }
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(pm.noticeMany, { n: 'N' })} ${pm.noticeLinkMany}"`)
    expect(PLATFORM_KNOWLEDGE).toContain('Nada se fusiona solo')
    expect(PLATFORM_KNOWLEDGE).toContain('Un EMPLOYEE no puede fusionar')
  })

  it('the late rule with its exact conditions and messages, as the endpoint writes them', () => {
    expect(LATE_ACCEPT_MAX_DAYS).toBe(30)
    expect(PLATFORM_KNOWLEDGE).toContain('(1) se publicó como mucho 30 días después del fin')
    expect(PLATFORM_KNOWLEDGE).toContain('está en Acordado, Contratado, Envío o Publicado')
    expect(PLATFORM_KNOWLEDGE).toContain('una publicación fuera de plazo cuenta en UNA sola campaña')
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(detail.manualDetailLate, { days: 'N días' })}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(report.lateBadge, { days: 'N días' })}"`)
    // The refusals, quoted with an example handle / figure; the endpoint's templates say the same
    const completed = 'está en Completado: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.'
    expect(PLATFORM_KNOWLEDGE).toContain(`"@usuario ${completed}"`)
    expect(rules).toContain('está en ${label}: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.')
    expect(PLATFORM_KNOWLEDGE).toContain('"Se publicó 41 días después del fin de la campaña; el máximo para contarla fuera de plazo son 30."')
    expect(rules).toContain('días después del fin de la campaña; el máximo para contarla fuera de plazo son ${LATE_ACCEPT_MAX_DAYS}.')
    expect(PLATFORM_KNOWLEDGE).toContain('"Esta publicación ya cuenta en «X». Una publicación fuera de plazo solo cuenta en una campaña."')
    expect(rules).toContain('Una publicación fuera de plazo solo cuenta en una campaña.')
  })

  it('an accepted late piece does not turn «Fechas» amber, and the dates are never moved for it (manual and knowledge agree)', () => {
    expect(PLATFORM_KNOWLEDGE).not.toContain('también la deja en ámbar, y es correcto')
    expect(PLATFORM_KNOWLEDGE).toContain('una pieza "Fuera de plazo" añadida a mano cuenta como dentro de las fechas y no la pone en ámbar: nunca se cambian las fechas de la campaña por ella')
    const fechas = MANUAL_SECTIONS.flatMap(s => s.troubleshooting ?? []).find(t => t.problem === 'La checklist "Prometido vs entregado" sale ámbar')!.doWhat.find(l => l.startsWith('Fechas:'))!
    expect(fechas).toContain('Una publicación "Fuera de plazo" añadida a mano cuenta como dentro y no la pone en ámbar: no cambies las fechas por ella.')
  })

  it('the team line and «never to the client»', () => {
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(report.deliverySummary, { delivered: 'X', late: 'Y', notPublished: 'Z' })}"`)
    expect(PLATFORM_KNOWLEDGE).toContain(`"${fill(report.deliverySummaryInProgress, { n: 'W' })}"`)
    expect(PLATFORM_KNOWLEDGE).toContain('EL CLIENTE NUNCA VE "FUERA DE PLAZO"')
  })

  it('never says a post after the end is always refused; before the start still never counts', () => {
    expect(PLATFORM_KNOWLEDGE).not.toContain('Si la publicación está fuera de las fechas de la campaña, se rechaza con un mensaje claro.')
    expect(PLATFORM_KNOWLEDGE).not.toContain('fecha fuera del periodo o enlace de otra creadora')
    // «No cuenta los vídeos de TikTok» → CAMINO RÁPIDO: the manual's wording, not the old refusal
    expect(PLATFORM_KNOWLEDGE).not.toContain('El vídeo tiene que estar fechado dentro de la campaña; si no, se rechaza.')
    expect(PLATFORM_KNOWLEDGE).toContain('El vídeo tiene que estar fechado dentro de la campaña (después del fin, solo fuera de plazo: sección 23).')
    expect(PLATFORM_KNOWLEDGE).toContain('Lo publicado ANTES del inicio nunca cuenta')
    expect(PLATFORM_KNOWLEDGE).toContain('La captura automática no añade publicaciones fuera de plazo')
  })
})

describe('the assistant\'s role', () => {
  it('forbids the old answers and names the tool', () => {
    expect(assistantRole).toContain('NUNCA digas que una publicación posterior al fin de la campaña se rechaza siempre')
    expect(assistantRole).toContain('NUNCA digas que la captura automática añade publicaciones fuera de plazo')
    expect(assistantRole).toContain('un ADMIN las fusiona en \\"Fichas duplicadas\\"'.replace(/\\"/g, '"'))
    expect(assistantRole).toContain('un EMPLOYEE no puede fusionar')
    expect(assistantRole).toContain('la marca "Fuera de plazo"')
  })
})

describe('Metodología and the connector guide', () => {
  it('Metodología says what a late piece is, and who merges duplicates', () => {
    const methodology = source('src/app/(dashboard)/methodology/page.tsx')
    expect(methodology).toContain("cuenta en la campana marcada 'Fuera de plazo': esa marca es solo del equipo y nunca sale al cliente.")
    expect(methodology).toContain("counts in the campaign marked 'Late': that mark is team only and never reaches the client.")
    expect(methodology).toContain("un ADMIN las revisa y las fusiona en 'Fichas duplicadas'")
  })

  it('the connector guide states no date rule that changed', () => {
    const guide = source('docs/conector-claude.md')
    for (const phrase of ['fuera de fechas', 'fuera del periodo', 'se rechaza si']) expect(guide).not.toContain(phrase)
  })
})

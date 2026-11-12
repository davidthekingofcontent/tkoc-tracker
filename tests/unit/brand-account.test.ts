/**
 * isBrandAccount (src/lib/campaign-targets.ts): is a handle one of the
 * campaign's «Cuentas de Marca Objetivo»? It decides that the brand's own
 * account is never registered as a profile of a creator (manual endpoint) nor
 * read as her TikTok (daily pass).
 */
import { describe, expect, it } from 'vitest'
import { isBrandAccount } from '@/lib/campaign-targets'

describe('isBrandAccount', () => {
  it('matches the exact handle, with or without @, in any casing', () => {
    for (const handle of ['vileda.es', '@vileda.es', 'Vileda.ES', ' @VILEDA.es ']) {
      expect(isBrandAccount(['vileda.es'], handle), handle).toBe(true)
      expect(isBrandAccount(['@Vileda.es'], handle), handle).toBe(true)
    }
  })

  it('reads several accounts typed in one field', () => {
    const typed = ['@vileda.es @viledaturbo, vileda_latam']
    for (const handle of ['vileda.es', 'viledaturbo', 'vileda_latam']) expect(isBrandAccount(typed, handle), handle).toBe(true)
  })

  it('never takes a creator for the brand: exact handles only', () => {
    const targets = ['vileda.es']
    // A creator that names the brand, a lookalike, the handle without its dot
    for (const handle of ['vileda', 'vileda.es_fans', 'viledaes', 'vileda_es', 'amo.vileda.es', 'ale_ficticia']) {
      expect(isBrandAccount(targets, handle), handle).toBe(false)
    }
  })

  it('is false with no accounts or no handle', () => {
    expect(isBrandAccount([], 'vileda.es')).toBe(false)
    expect(isBrandAccount(null, 'vileda.es')).toBe(false)
    expect(isBrandAccount(undefined, 'vileda.es')).toBe(false)
    expect(isBrandAccount(['vileda.es'], '')).toBe(false)
    expect(isBrandAccount(['vileda.es'], '@')).toBe(false)
    expect(isBrandAccount(['', '  '], '')).toBe(false)
    expect(isBrandAccount(['vileda.es'], null)).toBe(false)
  })
})

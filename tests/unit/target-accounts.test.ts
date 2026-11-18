/**
 * validateTargetAccounts (src/lib/campaign-targets.ts), weekly review of 16 Nov
 * 2026: «12.- Micros Diciembre» was created with the product words 'turbo' and
 * 'infinityflex' as brand ACCOUNTS. A brand account must be a real handle of the
 * brand: never a generic word and, with a brand to judge against, carrying its
 * name (or the brand's connected Instagram). Also the helpers the screens use
 * to classify what the PM typed before sending it.
 */
import { describe, expect, it } from 'vitest'
import {
  ACCOUNTS_POINTER,
  campaignBrandStems,
  classifyTypedTargets,
  markBareAsAccounts,
  moveBareToKeywords,
  readTargetFields,
  targetAccountsError,
  validateTargetAccounts,
} from '@/lib/campaign-targets'

const vileda = { brandName: 'Vileda España' }

describe('validateTargetAccounts', () => {
  it('the production case: vileda.es stays, turbo is a generic word, infinityflex does not carry the brand', () => {
    expect(validateTargetAccounts(['vileda.es', 'turbo', 'infinityflex'], vileda)).toEqual({
      ok: ['vileda.es'],
      generic: ['turbo'],
      notBrand: ['infinityflex'],
    })
  })

  it('a generic word is refused with or without a brand: singular, plural, glued, qualified, a number', () => {
    for (const word of ['turbo', 'mopa', 'turbos', 'spin', 'promo', 'sorteo', 'turbomopa', 'blackfriday', 'sorteo2026', '2026', '@turbo.es', 'mopa_2026', 'Turbo']) {
      expect(validateTargetAccounts([word], {}).generic, word).toEqual([word.replace(/^@/, '')])
      expect(validateTargetAccounts([word], vileda).generic, word).toEqual([word.replace(/^@/, '')])
    }
  })

  it('a handle that carries the brand is accepted, with the @ and in any casing', () => {
    for (const handle of ['vileda.es', '@vileda.es', '@Vileda_Espana', 'viledaturbo', 'vileda', '@vileda.limpieza']) {
      expect(validateTargetAccounts([handle], vileda), handle).toEqual({ ok: [handle.replace(/^@/, '')], generic: [], notBrand: [] })
    }
    // Brand words of the campaign's name count too ('11.- Vileda - Micros Noviembre' → vileda)
    expect(validateTargetAccounts(['vileda.es'], { campaignName: '11.- Vileda - Micros Noviembre' }).ok).toEqual(['vileda.es'])
    // ...but the name alone never judges: without an attached brand 'infinityflex' is accepted (rule b needs the brand)
    expect(validateTargetAccounts(['infinityflex'], { campaignName: '11.- Vileda - Micros Noviembre' })).toEqual({ ok: ['infinityflex'], generic: [], notBrand: [] })
    expect(validateTargetAccounts(['infinityflex'], { brandName: 'Vileda España', campaignName: '11.- Vileda - Micros Noviembre' }).notBrand).toEqual(['infinityflex'])
  })

  it('without an attached brand, an account that is not a generic word is accepted as before', () => {
    expect(validateTargetAccounts(['infinityflex', 'deliplus', 'hp', 'a1'], {})).toEqual({ ok: ['infinityflex', 'deliplus', 'hp', 'a1'], generic: [], notBrand: [] })
    // Month, tier and admin words of the name are not a brand: still nothing to judge against
    expect(validateTargetAccounts(['infinityflex'], { campaignName: '12.- Micros Diciembre' }).ok).toEqual(['infinityflex'])
    expect(validateTargetAccounts(['infinityflex'], { campaignName: 'Selección de Micros' }).ok).toEqual(['infinityflex'])
  })

  it("a creative campaign name without an attached brand never refuses the brand's real account (review of 18 Nov 2026)", () => {
    for (const campaignName of ['Lanzamiento Infinity Flex', 'Reto 30 días', 'Embajadoras 2027', 'Hogar brillante', 'Dorco - Delyplus', 'Prueba interna']) {
      expect(validateTargetAccounts(['vileda.es'], { campaignName }), campaignName).toEqual({ ok: ['vileda.es'], generic: [], notBrand: [] })
    }
    // A generic word is still refused whatever the name says
    expect(validateTargetAccounts(['turbo'], { campaignName: 'Hogar brillante' }).generic).toEqual(['turbo'])
  })

  it('a generic word that is the brand itself passes once that brand is attached (the documented escape)', () => {
    expect(validateTargetAccounts(['turbo'], { brandName: 'Turbo' })).toEqual({ ok: ['turbo'], generic: [], notBrand: [] })
    expect(validateTargetAccounts(['casa.decor'], { brandName: 'Casa Decor' }).ok).toEqual(['casa.decor'])
    // The campaign's own name never whitelists a generic word: only the attached brand does
    expect(validateTargetAccounts(['turbo'], { campaignName: 'Micros Turbo Diciembre' }).generic).toEqual(['turbo'])
    expect(validateTargetAccounts(['turbo'], { brandName: 'Vileda España', campaignName: 'Vileda Turbo' }).generic).toEqual(['turbo'])
  })

  it('@deliplus in a Dorco campaign: refused as not carrying the brand; accepted when the distributor is in the campaign name', () => {
    const dorco = { brandName: 'Dorco', campaignName: 'Dorco - Diciembre' }
    expect(validateTargetAccounts(['deliplus'], dorco)).toEqual({ ok: [], generic: [], notBrand: ['deliplus'] })
    expect(validateTargetAccounts(['dorco_es', 'deliplus'], { ...dorco, campaignName: 'Dorco x Deliplus - Diciembre' })).toEqual({
      ok: ['dorco_es', 'deliplus'],
      generic: [],
      notBrand: [],
    })
    // The real campaign is called «Dorco - Delyplus» (with a y) and the distributor is @deliplus (with an i):
    // one letter off between a 6+ letter word of the name and the handle still counts (also '@deliplus.es')
    expect(validateTargetAccounts(['deliplus', '@deliplus.es'], { ...dorco, campaignName: 'Dorco - Delyplus' })).toEqual({ ok: ['deliplus', 'deliplus.es'], generic: [], notBrand: [] })
    // Two letters off is another name; short words never match by distance ('dorko' is not 'dorco', 'nike' is not 'nika')
    expect(validateTargetAccounts(['delyplas'], { ...dorco, campaignName: 'Dorco - Deliplus' }).notBrand).toEqual(['delyplas'])
    expect(validateTargetAccounts(['dorko'], dorco).notBrand).toEqual(['dorko'])
    expect(validateTargetAccounts(['nika.es'], { brandName: 'Nike' }).notBrand).toEqual(['nika.es'])
  })

  it("the brand's connected Instagram is accepted whatever its name", () => {
    expect(validateTargetAccounts(['marcademo.oficial', 'otra'], { brandName: 'Vileda España', connectedAccounts: ['marcademo.oficial'] })).toEqual({
      ok: ['marcademo.oficial'],
      generic: [],
      notBrand: ['otra'],
    })
    expect(validateTargetAccounts(['@MarcaDemo.Oficial'], { brandName: 'Vileda España', connectedAccounts: ['marcademo.oficial'] }).ok).toEqual(['MarcaDemo.Oficial'])
  })

  it('a short brand name only counts at the start of the handle; a 4+ letter handle may be a prefix of a stem', () => {
    const hp = validateTargetAccounts(['hp.espana', 'graphpaper_es', 'shop_online'], { brandName: 'HP' })
    expect(hp.ok).toEqual(['hp.espana'])
    // 'graphpaper' contains "hp" in the middle: not HP
    expect(hp.notBrand).toEqual(['graphpaper_es'])
    // 'shop' and 'online' are everyday words: a generic handle, whatever the brand
    expect(hp.generic).toEqual(['shop_online'])
    expect(validateTargetAccounts(['pccomp'], { brandName: 'PC Componentes' }).ok).toEqual(['pccomp'])
  })

  it('with the brand attached, the words of the campaign name only widen what is accepted, never what is refused', () => {
    // 'interna' is not in any dictionary: it becomes a stem (so '@interna.oficial' would pass), but with the
    // brand attached the account must still carry a stem of SOMETHING; 'vileda.es' carries the brand
    expect(validateTargetAccounts(['vileda.es', 'otra'], { campaignName: 'Prueba interna', brandName: 'Vileda España' })).toEqual({ ok: ['vileda.es'], generic: [], notBrand: ['otra'] })
    expect(validateTargetAccounts(['interna.oficial'], { campaignName: 'Prueba interna', brandName: 'Vileda España' }).ok).toEqual(['interna.oficial'])
  })

  it('several handles typed in one element are judged one by one; empties are dropped', () => {
    expect(validateTargetAccounts(['@vileda.es @turbo, infinityflex', '', '  '], vileda)).toEqual({ ok: ['vileda.es'], generic: ['turbo'], notBrand: ['infinityflex'] })
    expect(validateTargetAccounts([], vileda)).toEqual({ ok: [], generic: [], notBrand: [] })
    expect(validateTargetAccounts(null, vileda)).toEqual({ ok: [], generic: [], notBrand: [] })
    expect(validateTargetAccounts(undefined)).toEqual({ ok: [], generic: [], notBrand: [] })
  })

  it('campaignBrandStems never derives a stem from the accounts themselves', () => {
    expect(campaignBrandStems('Vileda España', '12.- Micros Diciembre')).toEqual(['viledaespana', 'vileda'])
    expect(campaignBrandStems(null, 'Dorco x Deliplus - Diciembre')).toEqual(['dorco', 'deliplus'])
    expect(campaignBrandStems(null, 'Micros Turbo Diciembre')).toEqual([])
    expect(campaignBrandStems(undefined, undefined)).toEqual([])
  })
})

describe('targetAccountsError', () => {
  it('names the refused handles, carries the agreed pointer and the escape route of each rule', () => {
    const text = targetAccountsError(['turbo'], ['infinityflex'])
    expect(text).toContain('Cuentas a revisar: @turbo.')
    expect(text).toContain('Cuentas a revisar: @infinityflex.')
    expect(text).toContain(ACCOUNTS_POINTER)
    expect(text).toContain('Pon las palabras del producto en Palabras clave del producto; aquí van solo las cuentas de la marca o del distribuidor.')
    // The escape of rule (a) names the one place where a campaign gets its brand (no step that does not exist)
    expect(text).toContain('la campaña necesita tener asignada la marca con ese nombre: se elige al crear la campaña desde Campañas, "Nueva Campaña" (el Asistente y "Editar Campaña" no asignan marca)')
    expect(text).toContain('pon ese nombre en el nombre de la campaña')
    // Only the relevant escape when one rule fired
    const onlyGeneric = targetAccountsError(['turbo'], [])
    expect(onlyGeneric).toContain('necesita tener asignada la marca')
    expect(onlyGeneric).not.toContain('nombre de la campaña (p. ej.')
    const onlyBrand = targetAccountsError([], ['deliplus'])
    expect(onlyBrand).toContain('Dorco x Deliplus')
    expect(onlyBrand).not.toContain('"turbo" o "mopa"')
    // No long dashes, no arrows (messages to people)
    expect(text).not.toMatch(/[—→]/)
  })
})

describe('what the PM typed in the target fields', () => {
  it('classifyTypedTargets: @ is an account, # a hashtag, neither is bare; split on commas, spaces and line breaks', () => {
    expect(classifyTypedTargets('@vileda.es, #viledaturbo turbo\n@Vileda_Espana;infinityflex, @vileda.es')).toEqual({
      accounts: ['vileda.es', 'Vileda_Espana'],
      hashtags: ['viledaturbo'],
      bare: ['turbo', 'infinityflex'],
    })
    expect(classifyTypedTargets('')).toEqual({ accounts: [], hashtags: [], bare: [] })
    expect(classifyTypedTargets(null)).toEqual({ accounts: [], hashtags: [], bare: [] })
    expect(classifyTypedTargets(['@a', '#b', 'c'])).toEqual({ accounts: ['a'], hashtags: ['b'], bare: ['c'] })
    expect(classifyTypedTargets('@ #')).toEqual({ accounts: [], hashtags: [], bare: [] })
  })

  it('readTargetFields: a bare word is a hashtag in the hashtags field and bare in the accounts field; a sigil wins over its field', () => {
    expect(readTargetFields('@vileda.es, turbo, #viledaspin', 'vileda, #viledaturbo, @vileda_latam')).toEqual({
      accounts: ['vileda.es', 'vileda_latam'],
      hashtags: ['viledaturbo', 'vileda', 'viledaspin'],
      bare: ['turbo'],
    })
    expect(readTargetFields('', '')).toEqual({ accounts: [], hashtags: [], bare: [] })
  })

  it('markBareAsAccounts puts an @ in front of every bare token and keeps the rest', () => {
    expect(markBareAsAccounts('@vileda.es, turbo infinityflex, #viledaturbo')).toBe('@vileda.es, @turbo, @infinityflex, #viledaturbo')
    expect(markBareAsAccounts('')).toBe('')
  })

  it('moveBareToKeywords takes the bare tokens out of the accounts and appends them to the keywords without repeats', () => {
    expect(moveBareToKeywords('@vileda.es, turbo, infinityflex', 'Vileda Turbo, turbo')).toEqual({
      accounts: '@vileda.es',
      keywords: 'Vileda Turbo, turbo, infinityflex',
    })
    expect(moveBareToKeywords('turbo', '')).toEqual({ accounts: '', keywords: 'turbo' })
    expect(moveBareToKeywords('@vileda.es', 'flection system')).toEqual({ accounts: '@vileda.es', keywords: 'flection system' })
  })
})

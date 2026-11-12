import { describe, expect, it } from 'vitest'
import { MANUAL_TEXT } from '@/lib/manual-content'
import { translations } from '@/i18n/translations'

/** Structural guards that every change must keep true. */
describe('house rules', () => {
  it('the manual digest given to the assistant stays within 12,000 characters', () => {
    expect(MANUAL_TEXT.length).toBeLessThanOrEqual(12_000)
  })

  it('both languages have exactly the same keys', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      o && typeof o === 'object' && !Array.isArray(o)
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
        : [prefix]
    const t = translations as unknown as Record<string, unknown>
    const en = keys(t.en).sort()
    const es = keys(t.es).sort()
    expect(es.filter(k => !en.includes(k))).toEqual([])
    expect(en.filter(k => !es.includes(k))).toEqual([])
  })
})

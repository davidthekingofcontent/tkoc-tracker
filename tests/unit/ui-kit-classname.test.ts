import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Avatar } from '@/components/ui/avatar'

/**
 * A kit component given a className must keep its own classes and add the
 * caller's. (The Button once lost every kit style this way.)
 */
const render = (Comp: unknown, props: Record<string, unknown>, children?: React.ReactNode) =>
  renderToStaticMarkup(React.createElement(Comp as React.FC<Record<string, unknown>>, props, children))
const firstClasses = (markup: string) => (markup.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean)

describe('kit components keep their styles when given a className', () => {
  const cases: Array<[string, unknown, Record<string, unknown>, React.ReactNode?]> = [
    ['Card', Card, {}, 'x'],
    ['CardHeader', CardHeader, {}, 'x'],
    ['CardTitle', CardTitle, {}, 'x'],
    ['CardContent', CardContent, {}, 'x'],
    ['Badge', Badge, {}, 'x'],
    ['Avatar', Avatar, { name: 'Ana Ruiz' }],
  ]
  for (const [name, Comp, props, children] of cases) {
    it(name, () => {
      const plain = firstClasses(render(Comp, props, children))
      const custom = firstClasses(render(Comp, { ...props, className: 'tkoc-probe-class' }, children))
      expect(plain.length, `${name} has kit classes`).toBeGreaterThan(0)
      expect(custom).toContain('tkoc-probe-class')
      // every kit class is still there
      for (const c of plain) expect(custom, `${name} lost "${c}"`).toContain(c)
    })
  }

  it('Input and Select keep their field styles', () => {
    for (const [Comp, props, children] of [[Input, {}, undefined], [Select, { options: [{ value: 'a', label: 'A' }] }, undefined]] as const) {
      const plainMarkup = render(Comp, { ...props })
      const customMarkup = render(Comp, { ...props, className: 'tkoc-probe-class' })
      const all = (m: string) => [...m.matchAll(/class="([^"]*)"/g)].flatMap(x => x[1].split(/\s+/)).filter(Boolean)
      expect(all(customMarkup)).toContain('tkoc-probe-class')
      for (const c of all(plainMarkup)) expect(all(customMarkup)).toContain(c)
    }
  })
})

import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@/components/ui/button'

const html = (props: Record<string, unknown>, children = 'Guardar') =>
  renderToStaticMarkup(React.createElement(Button as unknown as React.FC<Record<string, unknown>>, props, children))
const classesOf = (markup: string) => (markup.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/)

describe('kit Button', () => {
  it('keeps the kit styles when it is given a className', () => {
    const c = classesOf(html({ className: 'mt-4' }))
    expect(c).toContain('mt-4')
    expect(c).toContain('inline-flex')
    expect(c).toContain('bg-purple-600')
    expect(c).toContain('h-10')
  })

  it('lets the caller override one kit class without losing the others', () => {
    const c = classesOf(html({ className: 'w-full text-lg py-4 gap-1.5', size: 'md' }))
    expect(c).toContain('w-full')
    expect(c).toContain('text-lg')
    expect(c).not.toContain('text-sm')   // the kit's size text is replaced, not duplicated
    expect(c).toContain('gap-1.5')
    expect(c).not.toContain('gap-2')
    expect(c).toContain('rounded-lg')
    expect(c).toContain('font-medium')
  })

  it('renders the same with no className as before', () => {
    const c = classesOf(html({ variant: 'danger', size: 'sm' }))
    expect(c).toContain('bg-red-600')
    expect(c).toContain('h-8')
    expect(c).not.toContain('undefined')
  })

  it('is disabled while loading even when the caller passes disabled={false}', () => {
    expect(html({ loading: true, disabled: false })).toMatch(/<button[^>]*\sdisabled=""/)
    expect(html({ loading: false, disabled: false })).not.toMatch(/\sdisabled=""/)
    expect(html({ disabled: true })).toMatch(/\sdisabled=""/)
  })

  it('does not leak kit props to the DOM and passes the rest through', () => {
    const m = html({ variant: 'ghost', size: 'lg', loading: false, type: 'submit', title: 'Enviar', 'data-x': '1' })
    expect(m).not.toMatch(/\svariant=|\ssize=|\sloading=|\sas=/)
    expect(m).toMatch(/type="submit"/)
    expect(m).toMatch(/title="Enviar"/)
    expect(m).toMatch(/data-x="1"/)
  })

  it('works as a link with the same styles', () => {
    const m = html({ as: 'a', href: '/campaigns', className: 'ml-auto' }, 'Ver campañas')
    expect(m).toMatch(/^<a /)
    expect(m).toMatch(/href="\/campaigns"/)
    expect(m).not.toMatch(/\sas=/)
    const c = classesOf(m)
    expect(c).toContain('ml-auto')
    expect(c).toContain('inline-flex')
  })
})

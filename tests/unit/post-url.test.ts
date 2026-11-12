import { describe, expect, it } from 'vitest'
import { parsePostUrl } from '@/lib/post-url'
import { isShortPostUrl, resolveShortUrl } from '@/lib/resolve-short-url'

describe('parsePostUrl', () => {
  it('reads Instagram posts and reels, with or without the username in the path', () => {
    expect(parsePostUrl('https://www.instagram.com/p/DeKHOgcNODD/')).toMatchObject({ platform: 'INSTAGRAM', externalId: 'DeKHOgcNODD', mediaType: 'POST', ownerHint: null })
    expect(parsePostUrl('https://www.instagram.com/reels/DeKHOgcNODD/')).toMatchObject({ platform: 'INSTAGRAM', externalId: 'DeKHOgcNODD', mediaType: 'REEL', canonicalUrl: 'https://www.instagram.com/reel/DeKHOgcNODD/' })
    expect(parsePostUrl('instagram.com/humordeamor_/reel/DeKHOgcNODD/?igsh=abc')).toMatchObject({ externalId: 'DeKHOgcNODD', ownerHint: 'humordeamor_' })
  })

  it('reads TikTok videos and photos and keeps the handle', () => {
    expect(parsePostUrl('https://www.tiktok.com/@gladys.sanchez_/video/7699205467465108768')).toMatchObject({
      platform: 'TIKTOK', externalId: '7699205467465108768', mediaType: 'VIDEO', ownerHint: 'gladys.sanchez_',
      canonicalUrl: 'https://www.tiktok.com/@gladys.sanchez_/video/7699205467465108768',
    })
    expect(parsePostUrl('https://www.tiktok.com/@alezweig/photo/7695852671042964758?lang=es')).toMatchObject({ mediaType: 'POST', externalId: '7695852671042964758' })
  })

  it('reads YouTube watch, shorts and youtu.be links', () => {
    expect(parsePostUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')).toMatchObject({ platform: 'YOUTUBE', externalId: 'dQw4w9WgXcQ', mediaType: 'VIDEO' })
    expect(parsePostUrl('https://youtube.com/shorts/dQw4w9WgXcQ')).toMatchObject({ mediaType: 'SHORT' })
    expect(parsePostUrl('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ externalId: 'dQw4w9WgXcQ' })
  })

  it('refuses what is not a publication', () => {
    for (const bad of ['', 'hola', 'https://www.instagram.com/humordeamor_/', 'https://vm.tiktok.com/ZNabc123/', 'https://www.tiktok.com/@alezweig', 'https://example.com/p/abc']) {
      expect(parsePostUrl(bad)).toBeNull()
    }
  })
})

describe('short links', () => {
  it('recognises the share links that carry no post id', () => {
    expect(isShortPostUrl('https://vm.tiktok.com/ZNabc123/')).toBe(true)
    expect(isShortPostUrl('vt.tiktok.com/ZSabc/')).toBe(true)
    expect(isShortPostUrl('https://www.tiktok.com/t/ZTabc123/')).toBe(true)
    expect(isShortPostUrl('https://www.instagram.com/share/reel/BAbc_123')).toBe(true)
    expect(isShortPostUrl('https://www.tiktok.com/@alezweig/video/7695852671042964758')).toBe(false)
    expect(isShortPostUrl('https://www.instagram.com/reel/DeKHOgcNODD/')).toBe(false)
  })

  const redirect = (location: string) => new Response(null, { status: 301, headers: { location } })

  it('follows the redirect to the real video link', async () => {
    const calls: string[] = []
    const fake = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return redirect('https://www.tiktok.com/@alezweig/video/7695852671042964758?_r=1&_t=abc')
    }) as typeof fetch
    const r = await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', fake)
    expect(r).toEqual({ ok: true, url: 'https://www.tiktok.com/@alezweig/video/7695852671042964758?_r=1&_t=abc' })
    expect(calls).toEqual(['https://vm.tiktok.com/ZNabc123/'])
    // the resolved link parses to the same publication as the long one: duplicates are caught
    expect(parsePostUrl((r as { url: string }).url)?.externalId).toBe('7695852671042964758')
  })

  it('goes through an intermediate hop on the same platform', async () => {
    let n = 0
    const fake = (async () => (++n === 1
      ? redirect('https://www.tiktok.com/t/ZTabc123/')
      : redirect('https://www.tiktok.com/@alezweig/video/7695852671042964758'))) as typeof fetch
    expect(await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', fake)).toMatchObject({ ok: true })
    expect(n).toBe(2)
  })

  it('never follows a redirect off the platform', async () => {
    const fake = (async () => redirect('https://evil.example.com/steal')) as typeof fetch
    expect(await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', fake)).toEqual({ ok: false, reason: 'blocked_host' })
    const http = (async () => redirect('http://www.tiktok.com/@a/video/1')) as typeof fetch
    expect(await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', http)).toEqual({ ok: false, reason: 'blocked_host' })
  })

  it('gives up cleanly on loops, dead links and network errors', async () => {
    const loop = (async () => redirect('https://www.tiktok.com/t/ZTabc123/')) as typeof fetch
    expect(await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', loop)).toEqual({ ok: false, reason: 'too_many_hops' })
    const page = (async () => new Response('<html></html>', { status: 200 })) as typeof fetch
    expect(await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', page)).toEqual({ ok: false, reason: 'no_post' })
    const dead = (async () => new Response('', { status: 404 })) as typeof fetch
    expect(await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', dead)).toEqual({ ok: false, reason: 'unreachable' })
    const boom = (async () => { throw new Error('network') }) as typeof fetch
    expect(await resolveShortUrl('https://vm.tiktok.com/ZNabc123/', boom)).toEqual({ ok: false, reason: 'unreachable' })
    expect(await resolveShortUrl('https://www.tiktok.com/@a/video/1', boom)).toEqual({ ok: false, reason: 'not_short' })
  })
})

/**
 * «¿De quién es esta publicación?» (src/components/link-profile-confirm.tsx):
 * the resent request carries the author AND the network the PM was shown, so
 * the server can refuse to link an author she never saw (review of delivery 1,
 * 12 Nov 2026). The server side is in tests/db/link-profile-author-binding.test.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkProfileResendBody } from '@/components/link-profile-confirm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('linkProfileResendBody carries the network of the author shown', () => {
  const url = 'https://www.tiktok.com/@alba.tiktok/video/7700000000000000001'

  it('sends the network with the handle, as the server compares it', () => {
    expect(linkProfileResendBody({ url, influencerId: 'ig-sara' }, 'ig-alba', false, '@alba.tiktok', 'TIKTOK')).toEqual({
      url, influencerId: 'ig-alba', linkProfileTo: 'ig-alba', linkProfileAuthor: 'alba.tiktok', linkProfileAuthorPlatform: 'TIKTOK',
    })
    expect(linkProfileResendBody({ url }, 'ig-alba', true, 'alba.tiktok', ' tiktok ')).toEqual({
      url, influencerId: 'ig-alba', linkProfileTo: 'ig-alba', linkProfileAuthor: 'alba.tiktok', linkProfileAuthorPlatform: 'TIKTOK', confirmUnverified: true,
    })
  })

  it('never resends the network of an earlier answer', () => {
    const kept = { url, linkProfileAuthor: 'viejo', linkProfileAuthorPlatform: 'INSTAGRAM' }
    // A new answer about another network replaces it
    expect(linkProfileResendBody(kept, 'ig-alba', false, 'nuevo', 'TIKTOK')).toMatchObject({ linkProfileAuthor: 'nuevo', linkProfileAuthorPlatform: 'TIKTOK' })
    // No network given: none is sent rather than the stale one
    expect(linkProfileResendBody(kept, 'ig-alba', false, 'nuevo')).not.toHaveProperty('linkProfileAuthorPlatform')
    expect(linkProfileResendBody(kept, 'ig-alba', false, 'nuevo', '  ')).not.toHaveProperty('linkProfileAuthorPlatform')
    // The kept request itself is untouched
    expect(kept.linkProfileAuthorPlatform).toBe('INSTAGRAM')
  })

  it('the dialog sends the network of the author on screen', () => {
    // The only caller: handleConfirm resends with the author and network the dialog shows
    const source = fs.readFileSync(path.join(root, 'src', 'components', 'link-profile-confirm.tsx'), 'utf8')
    expect(source).toContain('linkProfileResendBody(request.body, memberId, unverified, asked.author.handle, asked.author.platform)')
  })
})

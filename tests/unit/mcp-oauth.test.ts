import { describe, expect, it, vi } from 'vitest'

// Before any import: a fixed signing secret, and no address in the environment
// so the module falls back to the production one (the value the spec fixes).
vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import { createHmac } from 'node:crypto'
import jwt from 'jsonwebtoken'
import {
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  APP_URL,
  CALL_RATE_LIMIT,
  CLAUDE_CALLBACKS,
  CLAUDE_EGRESS_IPV4,
  CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT,
  CODE_TTL_MS,
  CONSENT_TOKEN_TTL_MS,
  ISSUER,
  MAX_CLIENTS,
  MCP_RESOURCE,
  MCP_SCOPE,
  REDIRECT_URI_MAX_CHARS,
  REFRESH_REUSE_LEEWAY_MS,
  REFRESH_TOKEN_TTL_MS,
  REGISTRATION_RATE_LIMIT,
  REQUEST_RATE_LIMIT,
  STATE_MAX_CHARS,
  UNUSED_CLIENT_MAX_AGE_MS,
  WWW_AUTHENTICATE_BEARER,
  authorizationServerMetadata,
  isAllowedRedirectUri,
  isClaudeEgressAddress,
  isLoopbackRedirectUri,
  protectedResourceMetadata,
  redirectUriMatches,
  resolveAppUrl,
} from '@/lib/mcp/config'
import {
  type ConsentFields,
  isValidCodeChallenge,
  isValidCodeVerifier,
  looksLikeSecret,
  pkceChallengeS256,
  randomSecret,
  safeEqual,
  sha256Hex,
  signConsentToken,
  verifyConsentToken,
  verifyPkceS256,
} from '@/lib/mcp/crypto'
import {
  OAuthError,
  authenticateBearer,
  buildAuthorizeRedirect,
  handleTokenRequest,
  isOAuthError,
  parseClientRegistration,
} from '@/lib/mcp/oauth'

const PROD = 'https://intelligence.thekingofcontent.agency'
const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const CLAUDE_COM = 'https://claude.com/api/mcp/auth_callback'

/** The OAuthError a call throws (sync or async), or a failure of the test. */
async function oauthError(run: () => unknown): Promise<OAuthError> {
  try {
    await run()
  } catch (e) {
    if (isOAuthError(e)) return e
    throw e
  }
  throw new Error('expected an OAuthError, nothing was thrown')
}

describe('mcp config: addresses never come from a request', () => {
  it('falls back to the production address and builds every URL from it', () => {
    expect(APP_URL).toBe(PROD)
    expect(ISSUER).toBe(PROD)
    expect(MCP_RESOURCE).toBe(`${PROD}/api/mcp`)
    expect(MCP_SCOPE).toBe('tkoc.read')
    expect(WWW_AUTHENTICATE_BEARER).toBe(`Bearer resource_metadata="${PROD}/.well-known/oauth-protected-resource"`)
  })

  it('normalises the environment value and refuses what is not a plain http(s) address', () => {
    expect(resolveAppUrl(undefined)).toBe(PROD)
    expect(resolveAppUrl('')).toBe(PROD)
    expect(resolveAppUrl('   ')).toBe(PROD)
    expect(resolveAppUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(resolveAppUrl('http://localhost:3000///')).toBe('http://localhost:3000')
    expect(resolveAppUrl('https://Intelligence.Example.com/')).toBe('https://intelligence.example.com')
    expect(resolveAppUrl('https://example.com/app/')).toBe('https://example.com/app')
    for (const bad of ['not a url', 'javascript:alert(1)', 'ftp://example.com', 'https://user:pw@example.com', 'https://example.com/?x=1', 'https://example.com/#frag']) {
      expect(resolveAppUrl(bad)).toBe(PROD)
    }
  })

  it('takes the address from NEXT_PUBLIC_MCP_BASE_URL only: whatever NEXT_PUBLIC_APP_URL holds cannot move the resource', async () => {
    const saved = { app: process.env.NEXT_PUBLIC_APP_URL, mcp: process.env.NEXT_PUBLIC_MCP_BASE_URL }
    const restore = (name: 'NEXT_PUBLIC_APP_URL' | 'NEXT_PUBLIC_MCP_BASE_URL', value: string | undefined) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    try {
      // Production also answers on its Railway domain, and other features read NEXT_PUBLIC_APP_URL
      process.env.NEXT_PUBLIC_APP_URL = 'https://tkoc-tracker-production.up.railway.app'
      delete process.env.NEXT_PUBLIC_MCP_BASE_URL
      vi.resetModules()
      const railway = await import('@/lib/mcp/config')
      // The address the guide tells the owner to type in Claude
      expect(railway.protectedResourceMetadata().resource).toBe('https://intelligence.thekingofcontent.agency/api/mcp')
      expect(railway.authorizationServerMetadata().issuer).toBe(PROD)

      // Another environment says its own address on purpose
      process.env.NEXT_PUBLIC_MCP_BASE_URL = 'https://staging.example.test/'
      vi.resetModules()
      const staging = await import('@/lib/mcp/config')
      expect(staging.MCP_RESOURCE).toBe('https://staging.example.test/api/mcp')
      expect(staging.ISSUER).toBe('https://staging.example.test')
      expect(staging.WWW_AUTHENTICATE_BEARER).toBe('Bearer resource_metadata="https://staging.example.test/.well-known/oauth-protected-resource"')
    } finally {
      restore('NEXT_PUBLIC_APP_URL', saved.app)
      restore('NEXT_PUBLIC_MCP_BASE_URL', saved.mcp)
      vi.resetModules()
    }
  })

  it('has the lifetimes and limits of the specification', () => {
    expect(CODE_TTL_MS).toBe(5 * 60 * 1000)
    expect(ACCESS_TOKEN_TTL_MS).toBe(60 * 60 * 1000)
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(3600)
    expect(REFRESH_TOKEN_TTL_MS).toBe(60 * 24 * 60 * 60 * 1000)
    expect(CONSENT_TOKEN_TTL_MS).toBe(10 * 60 * 1000)
    expect(REGISTRATION_RATE_LIMIT).toEqual({ max: 10, windowMs: 60 * 60 * 1000 })
    expect(CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT).toEqual({ max: 300, windowMs: 60 * 60 * 1000 })
    expect(CALL_RATE_LIMIT).toEqual({ max: 120, windowMs: 10 * 60 * 1000 })
    expect(REQUEST_RATE_LIMIT).toEqual({ max: 600, windowMs: 10 * 60 * 1000 })
    expect(REFRESH_REUSE_LEEWAY_MS).toBe(60 * 1000)
    expect(MAX_CLIENTS).toBe(200)
    expect(UNUSED_CLIENT_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})

describe('Anthropic\'s egress range (where claude.ai registers from)', () => {
  it('is 160.79.104.0/21, edges included, and nothing else', () => {
    expect(CLAUDE_EGRESS_IPV4).toEqual({ base: '160.79.104.0', prefixBits: 21 })
    for (const inside of ['160.79.104.0', '160.79.104.10', '160.79.107.255', '160.79.111.255', ' 160.79.108.7 ', '::ffff:160.79.105.1', '::FFFF:160.79.110.2']) {
      expect(isClaudeEgressAddress(inside), inside).toBe(true)
    }
    for (const outside of [
      '160.79.103.255', '160.79.112.0', '160.79.4.1', '161.79.104.1', '60.79.104.1', '203.0.113.7', '10.0.0.1', '127.0.0.1',
      '160.79.104', '160.79.104.1.5', '160.79.104.010', '160.79.104.256', '160.79.104.-1', '160.79.104.1:443', '160.79.104.1x',
      '2607:6bc0::10', '::ffff:10.0.0.1', 'unknown', '', ' ', null, undefined, 7, ['160.79.104.1'],
    ]) {
      expect(isClaudeEgressAddress(outside), String(outside)).toBe(false)
    }
  })
})

describe('mcp metadata documents', () => {
  it('protected resource metadata (RFC 9728) has exactly these fields', () => {
    expect(protectedResourceMetadata()).toEqual({
      resource: `${PROD}/api/mcp`,
      authorization_servers: [PROD],
      scopes_supported: ['tkoc.read'],
      bearer_methods_supported: ['header'],
      resource_name: 'TKOC Intelligence',
    })
  })

  it('authorization server metadata (RFC 8414) has exactly these fields', () => {
    const doc = authorizationServerMetadata()
    expect(doc).toEqual({
      issuer: PROD,
      authorization_endpoint: `${PROD}/oauth/authorize`,
      token_endpoint: `${PROD}/api/oauth/token`,
      registration_endpoint: `${PROD}/api/oauth/register`,
      revocation_endpoint: `${PROD}/api/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['tkoc.read'],
      authorization_response_iss_parameter_supported: true,
    })
    // Dynamic registration only: Claude must not be told to use a client id metadata document
    expect(doc).not.toHaveProperty('client_id_metadata_document_supported')
  })
})

describe('redirect URI rules', () => {
  it('accepts exactly the two Claude callbacks', () => {
    expect(CLAUDE_CALLBACKS).toEqual([CLAUDE_AI, CLAUDE_COM])
    expect(isAllowedRedirectUri(CLAUDE_AI)).toBe(true)
    expect(isAllowedRedirectUri(CLAUDE_COM)).toBe(true)
  })

  it('accepts loopback on any port, with or without a path', () => {
    for (const ok of [
      'http://localhost/callback',
      'http://localhost:3118/callback',
      'http://localhost:65535/oauth/callback',
      'http://localhost:8080',
      'http://localhost:8080/',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:54321/callback',
      'http://127.0.0.1:1/cb?source=cli',
    ]) {
      expect(isLoopbackRedirectUri(ok), ok).toBe(true)
      expect(isAllowedRedirectUri(ok), ok).toBe(true)
    }
  })

  it('refuses everything else, including the usual tricks', () => {
    const refused: unknown[] = [
      // near misses of the Claude callbacks
      'https://claude.ai.evil.com/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback@evil',
      'https://claude.ai/api/mcp/auth_callback@evil.com',
      'https://claude.ai@evil.com/api/mcp/auth_callback',
      'https://user:pw@claude.ai/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback#fragment',
      'https://claude.ai/api/mcp/auth_callback/',
      'https://claude.ai/api/mcp/auth_callback?next=https://evil.com',
      'https://claude.ai/api/mcp/auth_callback/../evil',
      'https://claude.ai:443/api/mcp/auth_callback',
      'https://CLAUDE.AI/api/mcp/auth_callback',
      'http://claude.ai/api/mcp/auth_callback',
      'https://evil.claude.ai/api/mcp/auth_callback',
      'https://claude.ai.evil.com/',
      'https://claude.aI/api/mcp/auth_callback',
      ' https://claude.ai/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback ',
      'https://claude.ai/api/mcp/auth_callback\n',
      'https://claude.org/api/mcp/auth_callback',
      'https://evil.com/api/mcp/auth_callback',
      // loopback look-alikes
      'https://localhost/callback',
      'http://localhost@evil.com/callback',
      'http://localhost:80@evil.com/callback',
      'http://user@localhost/callback',
      'http://user:pw@127.0.0.1:8080/callback',
      'http://localhost.evil.com/callback',
      'http://127.0.0.1.evil.com/callback',
      'http://evil.com/localhost',
      'http://localhost#fragment',
      'http://localhost/callback#fragment',
      'http://localhost:8080/cb#',
      'http://LOCALHOST/callback',
      'HTTP://localhost/callback',
      'http://127.1/callback',
      'http://2130706433/callback',
      'http://0x7f.0.0.1/callback',
      'http://127.0.0.2/callback',
      'http://0.0.0.0/callback',
      'http://[::1]/callback',
      'http://[::1]:8080/callback',
      'http://localhost:/callback',
      'http://localhost:0/callback',
      'http://localhost:65536/callback',
      'http://localhost:999999/callback',
      'http://localhost:80a/callback',
      'http://localhost\\@evil.com/callback',
      'http://localhost/call back',
      'http://localhost/callback\r\nX-Injected: 1',
      'http:/localhost/callback',
      'http:localhost/callback',
      '//localhost/callback',
      'localhost:8080/callback',
      `http://localhost/${'a'.repeat(600)}`,
      // other schemes and non-strings
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'claude://callback',
      'com.example.app:/oauth',
      '',
      null,
      undefined,
      42,
      {},
      ['https://claude.ai/api/mcp/auth_callback'],
    ]
    for (const bad of refused) expect(isAllowedRedirectUri(bad), String(bad)).toBe(false)
  })

  it('matches a presented URI against the registered ones: exact for Claude, any port for loopback', () => {
    expect(redirectUriMatches([CLAUDE_AI], CLAUDE_AI)).toBe(true)
    expect(redirectUriMatches([CLAUDE_AI], CLAUDE_COM)).toBe(false)
    expect(redirectUriMatches([CLAUDE_AI], `${CLAUDE_AI}/`)).toBe(false)
    expect(redirectUriMatches([CLAUDE_AI], 'https://claude.ai.evil.com/api/mcp/auth_callback')).toBe(false)
    expect(redirectUriMatches([], CLAUDE_AI)).toBe(false)

    const registered = ['http://localhost:3118/callback']
    expect(redirectUriMatches(registered, 'http://localhost:3118/callback')).toBe(true)
    expect(redirectUriMatches(registered, 'http://localhost:49152/callback')).toBe(true)
    expect(redirectUriMatches(registered, 'http://localhost/callback')).toBe(true)
    expect(redirectUriMatches(registered, 'http://127.0.0.1:3118/callback')).toBe(false)
    expect(redirectUriMatches(registered, 'http://localhost:3118/other')).toBe(false)
    expect(redirectUriMatches(registered, 'http://localhost:3118/callback?x=1')).toBe(false)
    expect(redirectUriMatches(registered, 'http://localhost:3118/callback/')).toBe(false)
    expect(redirectUriMatches(registered, 'https://localhost:3118/callback')).toBe(false)
    expect(redirectUriMatches(registered, 'http://localhost@evil.com/callback')).toBe(false)
    expect(redirectUriMatches(registered, 'http://localhost.evil.com:3118/callback')).toBe(false)
    expect(redirectUriMatches(registered, CLAUDE_AI)).toBe(false)
    expect(redirectUriMatches(registered, undefined)).toBe(false)
    expect(redirectUriMatches(registered, ['http://localhost:3118/callback'])).toBe(false)
    // A loopback registration never lets a Claude callback through, and the reverse
    expect(redirectUriMatches([CLAUDE_AI], 'http://localhost:3118/callback')).toBe(false)
  })
})

describe('secrets', () => {
  it('creates 32 random bytes in base64url, never the same twice', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const s = randomSecret()
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(s, 'base64url')).toHaveLength(32)
      expect(looksLikeSecret(s)).toBe(true)
      seen.add(s)
    }
    expect(seen.size).toBe(200)
  })

  it('recognises what cannot be one of our secrets', () => {
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`, `${'a'.repeat(42)} `, null, undefined, 7]) {
      expect(looksLikeSecret(bad)).toBe(false)
    }
  })

  it('stores secrets as SHA-256 in hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const secret = randomSecret()
    expect(sha256Hex(secret)).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex(secret)).not.toContain(secret)
  })

  it('compares in constant time and by value', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('abc', undefined as unknown as string)).toBe(false)
  })
})

describe('PKCE S256', () => {
  // RFC 7636, appendix B
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

  it('reproduces the test vector of RFC 7636', () => {
    expect(pkceChallengeS256(VERIFIER)).toBe(CHALLENGE)
    expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true)
  })

  it('refuses a wrong verifier, a wrong challenge and the plain method', () => {
    expect(verifyPkceS256(`${VERIFIER.slice(0, -1)}l`, CHALLENGE)).toBe(false)
    expect(verifyPkceS256(VERIFIER, `${CHALLENGE.slice(0, -1)}N`)).toBe(false)
    // "plain": the challenge is the verifier itself
    expect(verifyPkceS256(VERIFIER, VERIFIER)).toBe(false)
    expect(verifyPkceS256(CHALLENGE, CHALLENGE)).toBe(false)
  })

  it('refuses malformed verifiers and challenges', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false)
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true)
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true)
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false)
    expect(isValidCodeVerifier(`${'a'.repeat(43)}+`)).toBe(false)
    expect(isValidCodeVerifier(`${'a'.repeat(43)} `)).toBe(false)
    expect(isValidCodeVerifier(undefined)).toBe(false)
    expect(isValidCodeChallenge(CHALLENGE)).toBe(true)
    expect(isValidCodeChallenge(`${CHALLENGE}=`)).toBe(false)
    expect(isValidCodeChallenge(CHALLENGE.slice(1))).toBe(false)
    expect(isValidCodeChallenge('')).toBe(false)
    expect(isValidCodeChallenge(null)).toBe(false)
    expect(verifyPkceS256('', '')).toBe(false)
    expect(verifyPkceS256(undefined, CHALLENGE)).toBe(false)
    expect(verifyPkceS256(VERIFIER, undefined)).toBe(false)
    expect(verifyPkceS256('short', pkceChallengeS256('short'))).toBe(false)
  })
})

describe('consent token', () => {
  const fields: ConsentFields = {
    userId: 'user_admin_1',
    clientId: 'client_abc',
    redirectUri: CLAUDE_AI,
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    state: 'state-123',
    resource: `${PROD}/api/mcp`,
    scope: 'tkoc.read',
  }
  const T0 = 1_800_000_000_000

  it('round-trips every field it binds', () => {
    const token = signConsentToken(fields, T0)
    const check = verifyConsentToken(token, T0 + 1000)
    expect(check).toEqual({ ok: true, fields, expiresAt: T0 + 10 * 60 * 1000 })
    const noState = verifyConsentToken(signConsentToken({ ...fields, state: null }, T0), T0)
    expect(noState.ok && noState.fields.state).toBe(null)
    // The longest request the authorization endpoint accepts still fits
    const longest: ConsentFields = { ...fields, state: '~'.repeat(STATE_MAX_CHARS), redirectUri: `http://localhost:65535/${'a'.repeat(REDIRECT_URI_MAX_CHARS - 23)}` }
    expect(isAllowedRedirectUri(longest.redirectUri)).toBe(true)
    expect(verifyConsentToken(signConsentToken(longest, T0), T0)).toEqual({ ok: true, fields: longest, expiresAt: T0 + 10 * 60 * 1000 })
  })

  it('expires after 10 minutes', () => {
    const token = signConsentToken(fields, T0)
    expect(verifyConsentToken(token, T0 + 10 * 60 * 1000 - 1).ok).toBe(true)
    expect(verifyConsentToken(token, T0 + 10 * 60 * 1000)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyConsentToken(token, T0 + 24 * 60 * 60 * 1000)).toEqual({ ok: false, reason: 'expired' })
  })

  it('cannot be altered: changing any bound field breaks the signature', () => {
    const token = signConsentToken(fields, T0)
    const [version, payload, signature] = token.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const variants: Record<string, unknown>[] = [
      { ...decoded, uid: 'user_other' },
      { ...decoded, cid: 'client_evil' },
      { ...decoded, ru: 'http://localhost:1/steal' },
      { ...decoded, cc: 'A'.repeat(43) },
      { ...decoded, st: 'other-state' },
      { ...decoded, rs: 'https://evil.example/api/mcp' },
      { ...decoded, sc: 'tkoc.write' },
      { ...decoded, exp: decoded.exp + 60 * 60 * 1000 },
    ]
    for (const v of variants) {
      const forged = `${version}.${Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')}.${signature}`
      expect(verifyConsentToken(forged, T0)).toEqual({ ok: false, reason: 'signature' })
    }
    // A signature made for another token does not fit either
    const other = signConsentToken({ ...fields, userId: 'user_other' }, T0)
    expect(verifyConsentToken(`${version}.${payload}.${other.split('.')[2]}`, T0)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyConsentToken(`${version}.${payload}.${'A'.repeat(43)}`, T0)).toEqual({ ok: false, reason: 'signature' })
  })

  it('depends on JWT_SECRET', () => {
    const token = signConsentToken(fields, T0)
    const real = process.env.JWT_SECRET
    try {
      process.env.JWT_SECRET = 'another-secret'
      expect(verifyConsentToken(token, T0)).toEqual({ ok: false, reason: 'signature' })
      delete process.env.JWT_SECRET
      expect(() => signConsentToken(fields, T0)).toThrow(/JWT_SECRET/)
      expect(() => verifyConsentToken(token, T0)).toThrow(/JWT_SECRET/)
    } finally {
      process.env.JWT_SECRET = real
    }
    expect(verifyConsentToken(token, T0).ok).toBe(true)
  })

  it('is not a session token, and a session token is not a consent token', () => {
    const secret = process.env.JWT_SECRET as string
    const session = jwt.sign({ userId: 'user_admin_1', role: 'ADMIN' }, secret, { expiresIn: '7d' })
    expect(verifyConsentToken(session, Date.now()).ok).toBe(false)
    const consent = signConsentToken(fields, T0)
    expect(() => jwt.verify(consent, secret)).toThrow()
    // Key separation: the same body signed with JWT_SECRET itself (the key of
    // the session tokens) is not a valid consent token
    const [version, payload] = consent.split('.')
    const rawKeySignature = createHmac('sha256', secret).update(`${version}.${payload}`, 'utf8').digest('base64url')
    expect(verifyConsentToken(`${version}.${payload}.${rawKeySignature}`, T0)).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses garbage without throwing', () => {
    const token = signConsentToken(fields, T0)
    const [version, payload, signature] = token.split('.')
    for (const bad of [
      '',
      'v1',
      'v1.',
      'v1..',
      `v2.${payload}.${signature}`,
      `${version}.${payload}`,
      `${version}.${payload}.${signature}.extra`,
      `${version}.${payload}.${signature}=`,
      `${version}.${payload}.${signature} `,
      'x'.repeat(10_000),
      null,
      undefined,
      42,
      {},
    ]) {
      const check = verifyConsentToken(bad, T0)
      expect(check.ok, String(bad).slice(0, 40)).toBe(false)
    }
  })
})

describe('client registration body (RFC 7591)', () => {
  it('accepts a public client with the Claude callback', () => {
    expect(
      parseClientRegistration({
        client_name: 'Claude',
        redirect_uris: [CLAUDE_AI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'tkoc.read',
      }),
    ).toEqual({ name: 'Claude', redirectUris: [CLAUDE_AI] })
  })

  it('accepts the minimum and a loopback client, and gives a nameless client a name', () => {
    expect(parseClientRegistration({ redirect_uris: ['http://localhost:3118/callback'] })).toEqual({
      name: 'Cliente MCP',
      redirectUris: ['http://localhost:3118/callback'],
    })
    expect(parseClientRegistration({ redirect_uris: [CLAUDE_AI, CLAUDE_AI, CLAUDE_COM], client_name: null, scope: '' }).redirectUris).toEqual([CLAUDE_AI, CLAUDE_COM])
  })

  it('refuses any redirect URI that is not allowed', async () => {
    for (const uris of [
      undefined,
      [],
      'https://claude.ai/api/mcp/auth_callback',
      ['https://evil.com/callback'],
      [CLAUDE_AI, 'https://evil.com/callback'],
      ['https://claude.ai.evil.com/api/mcp/auth_callback'],
      ['https://claude.ai/api/mcp/auth_callback@evil'],
      ['http://localhost@evil.com/callback'],
      ['http://localhost/callback#x'],
      [42],
      Array.from({ length: 11 }, (_, i) => `http://localhost:${4000 + i}/callback`),
    ]) {
      const e = await oauthError(() => parseClientRegistration({ redirect_uris: uris }))
      expect(e.code).toBe('invalid_redirect_uri')
      expect(e.status).toBe(400)
    }
  })

  it('refuses confidential clients and other grant or response types', async () => {
    const base = { redirect_uris: [CLAUDE_AI] }
    for (const extra of [
      { token_endpoint_auth_method: 'client_secret_basic' },
      { token_endpoint_auth_method: 'client_secret_post' },
      { token_endpoint_auth_method: 'private_key_jwt' },
      { grant_types: ['authorization_code', 'client_credentials'] },
      { grant_types: ['password'] },
      { grant_types: ['implicit'] },
      { grant_types: 'authorization_code' },
      { response_types: ['token'] },
      { response_types: ['code', 'id_token'] },
      { scope: 7 },
      { scope: ['tkoc.read'] },
      { client_name: 42 },
      { client_name: 'x'.repeat(101) },
    ]) {
      const e = await oauthError(() => parseClientRegistration({ ...base, ...extra }))
      expect(e.code, JSON.stringify(extra)).toBe('invalid_client_metadata')
    }
    for (const body of [null, undefined, 'text', 7, []]) {
      expect((await oauthError(() => parseClientRegistration(body))).code).toBe('invalid_client_metadata')
    }
  })

  it('ignores the scope it asks for: it grants nothing, and an unknown value must not stop Claude from registering', () => {
    for (const scope of ['tkoc.read', 'tkoc.read offline_access', 'tkoc.write', 'tkoc.read tkoc.write', 'openid profile', '', '   ']) {
      expect(parseClientRegistration({ redirect_uris: [CLAUDE_AI], client_name: 'Claude', scope }), scope).toEqual({ name: 'Claude', redirectUris: [CLAUDE_AI] })
    }
  })

  it('keeps the name as plain text, without control or direction characters', () => {
    const rlo = String.fromCharCode(0x202e)
    const zeroWidth = String.fromCharCode(0x200b)
    const parsed = parseClientRegistration({ redirect_uris: [CLAUDE_AI], client_name: `  Claude\n\t${rlo}<b>x</b>${zeroWidth}  ` })
    expect(parsed.name).toBe('Claude <b>x</b>')
    expect(parseClientRegistration({ redirect_uris: [CLAUDE_AI], client_name: 'x'.repeat(100) }).name).toHaveLength(100)
    expect(parseClientRegistration({ redirect_uris: [CLAUDE_AI], client_name: ' \n ' }).name).toBe('Cliente MCP')
  })
})

describe('authorization response', () => {
  it('sends the code, the state and always the issuer', () => {
    const url = new URL(buildAuthorizeRedirect(CLAUDE_AI, { code: 'the-code', state: 'st&=? 1' }))
    expect(url.origin + url.pathname).toBe(CLAUDE_AI)
    expect([...url.searchParams.keys()]).toEqual(['code', 'state', 'iss'])
    expect(url.searchParams.get('code')).toBe('the-code')
    expect(url.searchParams.get('state')).toBe('st&=? 1')
    expect(url.searchParams.get('iss')).toBe(PROD)
  })

  it('sends an error the same way, and no state when the client sent none', () => {
    expect(buildAuthorizeRedirect(CLAUDE_AI, { error: 'access_denied', state: 'abc' })).toBe(
      `${CLAUDE_AI}?error=access_denied&state=abc&iss=${encodeURIComponent(PROD)}`,
    )
    const url = new URL(buildAuthorizeRedirect('http://localhost:3118/callback?source=cli', { error: 'invalid_scope', errorDescription: 'The only scope is tkoc.read', state: null }))
    expect(url.host).toBe('localhost:3118')
    expect(url.searchParams.get('source')).toBe('cli')
    expect(url.searchParams.get('error')).toBe('invalid_scope')
    expect(url.searchParams.get('error_description')).toBe('The only scope is tkoc.read')
    expect(url.searchParams.has('state')).toBe(false)
    expect(url.searchParams.get('iss')).toBe(PROD)
    expect(url.searchParams.has('code')).toBe(false)
  })
})

describe('typed errors and checks that need no database', () => {
  it('an OAuthError carries the RFC 6749 code, the status and the JSON body', () => {
    const e = new OAuthError('invalid_grant', 'The authorization code expired')
    expect(e).toBeInstanceOf(Error)
    expect(isOAuthError(e)).toBe(true)
    expect(isOAuthError(new Error('x'))).toBe(false)
    expect(e.code).toBe('invalid_grant')
    expect(e.status).toBe(400)
    expect(e.body).toEqual({ error: 'invalid_grant', error_description: 'The authorization code expired' })
    expect(new OAuthError('temporarily_unavailable', 'later', 429).status).toBe(429)
  })

  it('the token endpoint refuses a missing, repeated or unsupported grant_type', async () => {
    expect((await oauthError(() => handleTokenRequest(new URLSearchParams('')))).code).toBe('invalid_request')
    expect((await oauthError(() => handleTokenRequest(new URLSearchParams('grant_type=')))).code).toBe('invalid_request')
    expect((await oauthError(() => handleTokenRequest(new URLSearchParams('grant_type=authorization_code&grant_type=refresh_token')))).code).toBe('invalid_request')
    for (const type of ['password', 'client_credentials', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code']) {
      const e = await oauthError(() => handleTokenRequest(new URLSearchParams({ grant_type: type })))
      expect(e.code).toBe('unsupported_grant_type')
      expect(e.status).toBe(400)
    }
    // Required fields are checked before anything is looked up
    expect((await oauthError(() => handleTokenRequest(new URLSearchParams({ grant_type: 'authorization_code' })))).code).toBe('invalid_request')
    expect((await oauthError(() => handleTokenRequest({ grant_type: 'refresh_token' }))).code).toBe('invalid_request')
    expect((await oauthError(() => handleTokenRequest({ grant_type: ['refresh_token', 'refresh_token'] }))).code).toBe('invalid_request')
  })

  it('a request without a usable bearer token is a 401 with the metadata address', async () => {
    const header = `Bearer resource_metadata="${PROD}/.well-known/oauth-protected-resource"`
    for (const value of [null, undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'token-without-scheme']) {
      const r = await authenticateBearer(value)
      expect(r).toMatchObject({ ok: false, reason: 'missing', status: 401, wwwAuthenticate: header })
    }
    for (const value of ['Bearer not-one-of-ours', `Bearer ${'a'.repeat(44)}`, 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc', `Bearer ${'a'.repeat(43)} extra`]) {
      const r = await authenticateBearer(value)
      expect(r).toMatchObject({ ok: false, status: 401, wwwAuthenticate: header })
      expect(r.ok === false && (r.reason === 'malformed' || r.reason === 'missing')).toBe(true)
      expect(JSON.stringify(r)).not.toContain('not-one-of-ours')
    }
  })
})

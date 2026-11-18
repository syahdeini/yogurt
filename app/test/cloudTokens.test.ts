import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCloudAuth, type CloudAccount, type MsalClient, type TokenResult } from '../src/main/cloud/auth'
import { accessTokenExpired, openCache, sealCache, shouldForceRefresh, type TokenSeal } from '../src/main/cloud/tokens'

const seal: TokenSeal = {
  available: () => true,
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').toString('base64'), 'utf8'),
  decrypt: (sealed) => Buffer.from(sealed.toString('utf8'), 'base64').toString('utf8'),
}
const account: CloudAccount = { homeAccountId: 'home', localAccountId: 'local', username: 'a@pbn.org', name: 'Ada' }

function memoryClient() {
  const silent: boolean[] = []
  let signedIn = false
  let cache = ''
  const client: MsalClient = {
    async getAuthCodeUrl(req) { return `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?challenge=${req.codeChallenge}` },
    async acquireTokenByCode(req): Promise<TokenResult> {
      if (req.codeVerifier !== 'verifier') throw new Error('pkce')
      signedIn = true
      return { accessToken: 'PLAINTEXTTOKEN', expiresOn: Date.now() + 3_600_000, account }
    },
    async acquireTokenSilent(req): Promise<TokenResult> {
      silent.push(!!req.forceRefresh)
      if (!signedIn) throw new Error('not-signed-in')
      const expiresOn = silent.length === 1 ? Date.now() - 1_000 : Date.now() + 3_600_000
      return { accessToken: req.forceRefresh ? 'refreshed-token' : 'silent-token', expiresOn, account }
    },
    deserialize(next) { cache = next; signedIn = cache.includes('home') },
    serialize: () => cache || JSON.stringify({ account }),
    async getAccount() { return signedIn ? account : null },
    async clear() { signedIn = false; cache = '' },
  }
  return { client, silent }
}

describe('token handling', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })) })

  it('treats a token inside the skew as expired and asks for a refresh', () => {
    const now = 1_000_000
    expect(accessTokenExpired(now + 60_000, now)).toBe(true)
    expect(accessTokenExpired(now + 10 * 60_000, now)).toBe(false)
    expect(shouldForceRefresh(null)).toBe(false)
    expect(shouldForceRefresh(Date.now() - 1)).toBe(true)
  })

  it('seals the cache so the access token is not stored in the clear, and opens it again', () => {
    const sealed = sealCache(JSON.stringify({ accessToken: 'PLAINTEXTTOKEN', account }), seal)
    expect(sealed.toString('utf8')).not.toContain('PLAINTEXTTOKEN')
    expect(openCache(sealed, seal)).toContain('PLAINTEXTTOKEN')
  })

  it('signs in with PKCE, keeps the cache sealed, refreshes a stale token, and signs out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-auth-'))
    dirs.push(dir)
    const file = join(dir, 'entra-cache.bin')
    const box: { stored: Buffer | null } = { stored: null }
    const { client, silent } = memoryClient()
    const seen: string[] = []
    const auth = createCloudAuth({
      config: () => ({ tenantId: '6a94fd93-b4dc-42db-9712-8defab2a3e93', clientId: 'desktop', scope: 'api://api/access_as_user' }),
      client,
      seal,
      read: () => box.stored,
      write: (buf) => { box.stored = buf; if (buf) writeFileSync(file, buf) },
      openBrowser: async (url) => { seen.push(url) },
      listenForCode: async () => ({ redirectUri: 'http://localhost:4321', wait: async () => ({ code: 'auth-code' }), close() {} }),
      pkce: async () => ({ verifier: 'verifier', challenge: 'challenge' }),
    })
    await expect(auth.getAccessToken()).rejects.toThrow(/not-signed-in/)
    const signed = await auth.signIn()
    expect(signed.username).toBe('a@pbn.org')
    expect(seen[0]).toContain('challenge=challenge')
    expect(box.stored?.toString('utf8')).not.toContain('PLAINTEXTTOKEN')
    expect(readFileSync(file).toString('utf8')).not.toContain('PLAINTEXTTOKEN')
    expect(await auth.getAccessToken()).toBe('silent-token')
    expect(await auth.getAccessToken()).toBe('refreshed-token')
    expect(silent).toEqual([false, true])
    await auth.signOut()
    expect(box.stored).toBeNull()
    await expect(auth.getAccessToken()).rejects.toThrow(/not-signed-in/)
  })
})

import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { PublicClientApplication, type AccountInfo, type Configuration } from '@azure/msal-node'
import type { CloudAccount, MsalClient, TokenResult } from './auth'

/** PKCE S256, the same transform MSAL uses for a public desktop client. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function listenForAuthCode(timeoutMs = 3 * 60 * 1000): Promise<{ redirectUri: string; wait: () => Promise<{ code: string }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, code?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (error) waitReject(error)
      else waitResolve({ code: code ?? '' })
    }
    let waitResolve: (value: { code: string }) => void = () => {}
    let waitReject: (error: Error) => void = () => {}
    const wait = () => new Promise<{ code: string }>((ok, no) => { waitResolve = ok; waitReject = no })
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(code
        ? '<p>You are signed in to Yogurt. You can close this window.</p>'
        : '<p>Sign-in did not finish. You can close this window.</p>')
      if (code) finish(undefined, code)
      else finish(new Error(error === 'access_denied' ? 'cancelled' : 'cancelled'))
    })
    const timer = setTimeout(() => finish(new Error('cancelled')), timeoutMs)
    server.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      if (!port) { finish(new Error('failed')); reject(new Error('failed')); return }
      resolve({ redirectUri: `http://localhost:${port}`, wait, close: () => finish(new Error('cancelled')) })
    })
  })
}

export function createMsalClient(o: { clientId: string; tenantId: string }): MsalClient {
  let cacheRaw = ''
  const cachePlugin = {
    beforeCacheAccess: async (context: { tokenCache: { deserialize(data: string): void } }) => {
      if (cacheRaw) context.tokenCache.deserialize(cacheRaw)
    },
    afterCacheAccess: async (context: { tokenCache: { serialize(): string }; cacheHasChanged: boolean }) => {
      if (context.cacheHasChanged) cacheRaw = context.tokenCache.serialize()
    },
  }
  const configuration: Configuration = {
    auth: { clientId: o.clientId, authority: `https://login.microsoftonline.com/${o.tenantId}` },
    cache: { cachePlugin },
  }
  const app = new PublicClientApplication(configuration)
  const toAccount = (account: AccountInfo): CloudAccount => ({
    homeAccountId: account.homeAccountId, localAccountId: account.localAccountId, username: account.username, name: account.name,
  })
  const toResult = (result: { accessToken: string; expiresOn: Date | null; account: AccountInfo | null }): TokenResult => {
    if (!result.account) throw new Error('Sign-in did not return an account')
    return { accessToken: result.accessToken, expiresOn: result.expiresOn?.getTime() ?? Date.now() + 3_600_000, account: toAccount(result.account) }
  }
  return {
    getAuthCodeUrl: (req) => app.getAuthCodeUrl({ ...req, prompt: 'select_account' }),
    acquireTokenByCode: async (req) => toResult(await app.acquireTokenByCode(req)),
    acquireTokenSilent: async (req) => {
      const accounts = await app.getTokenCache().getAllAccounts()
      const account = accounts.find((item) => item.homeAccountId === req.account.homeAccountId) ?? accounts[0]
      if (!account) throw new Error('not-signed-in')
      return toResult(await app.acquireTokenSilent({ scopes: req.scopes, account, forceRefresh: req.forceRefresh }))
    },
    deserialize(cache) { cacheRaw = cache },
    serialize: () => cacheRaw,
    async getAccount() {
      const accounts = await app.getTokenCache().getAllAccounts()
      return accounts[0] ? toAccount(accounts[0]) : null
    },
    async clear() {
      const cache = app.getTokenCache()
      for (const account of await cache.getAllAccounts()) await cache.removeAccount(account)
      cacheRaw = cache.serialize()
    },
  }
}

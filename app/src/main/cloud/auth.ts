import { KeychainUnavailableError, NotSignedInError, openCache, sealCache, shouldForceRefresh, type TokenSeal } from './tokens'

export type CloudAccount = { homeAccountId: string; localAccountId: string; username: string; name?: string; tid?: string }

export type TokenResult = { accessToken: string; expiresOn: number; account: CloudAccount }

/**
 * The slice of MSAL's public client this app uses: auth code + PKCE, then silent refresh
 * from the persisted cache. Tests pass a stand-in; entra.ts builds the real one.
 */
export type MsalClient = {
  getAuthCodeUrl(req: { scopes: string[]; redirectUri: string; codeChallenge: string; codeChallengeMethod: 'S256' }): Promise<string>
  acquireTokenByCode(req: { code: string; scopes: string[]; redirectUri: string; codeVerifier: string }): Promise<TokenResult>
  acquireTokenSilent(req: { scopes: string[]; account: CloudAccount; forceRefresh: boolean }): Promise<TokenResult>
  deserialize(cache: string): void
  serialize(): string
  getAccount(): Promise<CloudAccount | null>
  clear(): Promise<void>
}

export type AuthErrorCode = 'not-configured' | 'cancelled' | 'keychain' | 'failed' | 'not-signed-in' | 'wrong-org'

export class CloudAuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string = code) { super(message) }
}

export function createCloudAuth(deps: {
  config: () => { tenantId: string; clientId: string; scope: string }
  client: MsalClient
  seal: TokenSeal
  read: () => Buffer | null
  write: (buf: Buffer | null) => void
  openBrowser: (url: string) => Promise<void>
  /** Resolves once the loopback is listening. wait() resolves with the auth code. */
  listenForCode: () => Promise<{ redirectUri: string; wait: () => Promise<{ code: string }>; close: () => void }>
  pkce: () => Promise<{ verifier: string; challenge: string }>
}) {
  let expiresOn: number | null = null
  let loaded = false

  const load = () => {
    if (loaded) return
    loaded = true
    const sealed = deps.read()
    if (!sealed) return
    try { deps.client.deserialize(openCache(sealed, deps.seal)) } catch (e) {
      console.warn('could not read the sealed sign-in cache; asking the person to sign in again', e)
      deps.write(null)
    }
  }

  const persist = () => {
    deps.write(sealCache(deps.client.serialize(), deps.seal))
  }

  const scopes = () => {
    const { scope, tenantId, clientId } = deps.config()
    if (!scope || !tenantId || !clientId) throw new CloudAuthError('not-configured')
    return [scope]
  }

  return {
    async account(): Promise<CloudAccount | null> {
      load()
      try { return await deps.client.getAccount() } catch { return null }
    },
    async getAccessToken(): Promise<string> {
      load()
      const account = await deps.client.getAccount()
      if (!account) throw new NotSignedInError()
      const forceRefresh = shouldForceRefresh(expiresOn)
      const result = await deps.client.acquireTokenSilent({ scopes: scopes(), account, forceRefresh })
      if (!result.accessToken) throw new NotSignedInError()
      expiresOn = result.expiresOn
      persist()
      return result.accessToken
    },
    async signIn(): Promise<CloudAccount> {
      load()
      const scopeList = scopes()
      const { verifier, challenge } = await deps.pkce()
      const loop = await deps.listenForCode()
      try {
        const url = await deps.client.getAuthCodeUrl({ scopes: scopeList, redirectUri: loop.redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256' })
        await deps.openBrowser(url)
        const { code } = await loop.wait()
        if (!code) throw new CloudAuthError('cancelled')
        const result = await deps.client.acquireTokenByCode({ code, scopes: scopeList, redirectUri: loop.redirectUri, codeVerifier: verifier })
        expiresOn = result.expiresOn
        persist()
        return result.account
      } catch (e) {
        if (e instanceof CloudAuthError || e instanceof KeychainUnavailableError) throw e
        if (e instanceof Error && e.message === 'cancelled') throw new CloudAuthError('cancelled')
        throw new CloudAuthError('failed', e instanceof Error ? e.message : 'failed')
      } finally { loop.close() }
    },
    async signOut(): Promise<void> {
      load()
      await deps.client.clear()
      expiresOn = null
      deps.write(null)
    },
  }
}

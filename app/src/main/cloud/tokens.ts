/** Refresh a little early so a request does not leave with a token that expires mid-upload. */
export const TOKEN_SKEW_MS = 5 * 60 * 1000

export function accessTokenExpired(expiresOnMs: number, now = Date.now(), skewMs = TOKEN_SKEW_MS): boolean {
  return !Number.isFinite(expiresOnMs) || expiresOnMs - skewMs <= now
}

/** True when the next silent call should ask the identity platform for a new access token. */
export function shouldForceRefresh(expiresOnMs: number | null, now = Date.now()): boolean {
  return expiresOnMs == null ? false : accessTokenExpired(expiresOnMs, now)
}

export type TokenSeal = {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(sealed: Buffer): string
}

export type SealedCache = { cache: string }

export function sealCache(cache: string, seal: TokenSeal): Buffer {
  if (!seal.available()) throw new KeychainUnavailableError()
  return seal.encrypt(JSON.stringify({ cache } satisfies SealedCache))
}

export function openCache(sealed: Buffer, seal: TokenSeal): string {
  if (!seal.available()) throw new KeychainUnavailableError()
  const parsed = JSON.parse(seal.decrypt(sealed)) as Partial<SealedCache>
  if (!parsed || typeof parsed.cache !== 'string') throw new Error('Sealed sign-in cache is unreadable')
  return parsed.cache
}

export class KeychainUnavailableError extends Error {
  constructor() { super('keychain') }
  readonly code = 'keychain' as const
}

export class NotSignedInError extends Error {
  constructor() { super('not-signed-in') }
  readonly code = 'not-signed-in' as const
}

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { assertPilotClaims, HttpError, requiredEnv } from './claims.js'

let keys: JWTVerifyGetKey | undefined

export async function verifyEntraToken(token: string, env: NodeJS.ProcessEnv = process.env): Promise<{ oid: string }> {
  const tenantId = requiredEnv('ENTRA_TENANT_ID', env)
  const audiences = withBareAppIds(requiredEnv('ENTRA_API_AUDIENCE', env).split(',').map((item) => item.trim()).filter(Boolean))
  const clientId = env.ENTRA_ALLOWED_CLIENT_ID?.trim() || undefined
  keys ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`))
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, audience: audiences })
    return assertPilotClaims(payload as Record<string, unknown>, { tenantId, audiences, scope: 'access_as_user', clientId })
  } catch (error) {
    if (error instanceof HttpError) throw error
    const name = error instanceof Error ? error.name : ''
    if (name.startsWith('JWT') || name.startsWith('JWS') || name.startsWith('JWKS')) throw new HttpError(403, 'Sign-in was not accepted')
    throw error
  }
}

/**
 * A v2 access token's `aud` is the API's bare app id, not its `api://<app id>` URI, so accept both forms.
 * Without this every signed-in request gets 401.
 */
export function withBareAppIds(audiences: string[]): string[] {
  const bare = audiences.map((item) => /^api:\/\/([0-9a-f-]{36})$/i.exec(item)?.[1]).filter((item): item is string => !!item)
  return [...new Set([...audiences, ...bare])]
}

export function bearer(header: string | null): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  if (!match) throw Object.assign(new Error('Sign in required'), { status: 401 })
  return match[1]
}

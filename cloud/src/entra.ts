import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { assertPilotClaims, requiredEnv } from './claims.js'

let keys: JWTVerifyGetKey | undefined

export async function verifyEntraToken(token: string, env: NodeJS.ProcessEnv = process.env): Promise<{ oid: string }> {
  const tenantId = requiredEnv('ENTRA_TENANT_ID', env)
  const audiences = requiredEnv('ENTRA_API_AUDIENCE', env).split(',').map((item) => item.trim()).filter(Boolean)
  const clientId = env.ENTRA_ALLOWED_CLIENT_ID?.trim() || undefined
  keys ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`))
  const { payload } = await jwtVerify(token, keys, { issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, audience: audiences })
  return assertPilotClaims(payload as Record<string, unknown>, { tenantId, audiences, scope: 'access_as_user', clientId })
}

export function bearer(header: string | null): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  if (!match) throw Object.assign(new Error('Sign in required'), { status: 401 })
  return match[1]
}

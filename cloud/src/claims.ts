export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export type PilotClaims = {
  tenantId: string
  audiences: string[]
  scope: string
  clientId?: string
}

/** Checks the claims our API cares about after the signature is verified. */
export function assertPilotClaims(payload: Record<string, unknown>, expected: PilotClaims): { oid: string } {
  const tenant = String(payload.tid ?? '')
  const issuer = String(payload.iss ?? '')
  const expectedIssuer = `https://login.microsoftonline.com/${expected.tenantId}/v2.0`
  if (issuer && issuer !== expectedIssuer) throw new HttpError(403, 'Wrong issuer')
  if (tenant !== expected.tenantId) throw new HttpError(403, 'Wrong tenant')
  if (payload.ver != null && payload.ver !== '2.0') throw new HttpError(401, 'Wrong token version')
  const audience = payload.aud
  const audiences = Array.isArray(audience) ? audience.map(String) : [String(audience ?? '')]
  if (!audiences.some((item) => expected.audiences.includes(item))) throw new HttpError(403, 'Wrong audience')
  const scopes = String(payload.scp ?? '').split(' ').filter(Boolean)
  if (!scopes.includes(expected.scope)) throw new HttpError(401, 'Missing scope')
  const client = String(payload.azp ?? payload.appid ?? '')
  if (expected.clientId && client !== expected.clientId) throw new HttpError(401, 'Wrong client')
  const oid = String(payload.oid ?? '')
  if (!oid) throw new HttpError(401, 'Missing user')
  return { oid }
}

export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

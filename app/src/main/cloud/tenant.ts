/** Preferred by Nature directory. Desktop sign-in never uses /common or /organizations. */
export const PILOT_TENANT_ID = '6a94fd93-b4dc-42db-9712-8defab2a3e93'

/** Tenant-specific authority. A GUID is required so the app cannot fall back to a multi-tenant endpoint. */
export function entraAuthority(tenantId: string): string {
  const tenant = tenantId.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
    throw new Error('Sign-in must use the Preferred by Nature directory')
  }
  return `https://login.microsoftonline.com/${tenant}`
}

/**
 * The id token's tenant must be this directory. When a username is present it must be a @pbn.org account.
 * A missing username still passes on the tenant, because some tokens omit the UPN.
 */
export function pilotAccountAllowed(account: { tid?: string; username?: string }, tenantId: string): boolean {
  const tenant = tenantId.trim().toLowerCase()
  const tid = (account.tid ?? '').trim().toLowerCase()
  if (!tenant || tid !== tenant) return false
  const user = (account.username ?? '').trim().toLowerCase()
  if (user.includes('@') && !user.endsWith('@pbn.org')) return false
  return true
}

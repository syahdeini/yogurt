import type { Settings } from '../settings'

/**
 * Cloud mode is off unless a setting or YOGURT_CLOUD turns it on. YOGURT_CLOUD=0 forces local
 * mode, which stays the fallback when nothing asks for the cloud.
 */
export function cloudModeEnabled(settings: Pick<Settings, 'cloudMode'>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.YOGURT_CLOUD === '0') return false
  if (env.YOGURT_CLOUD === '1') return true
  return settings.cloudMode === true
}

export type CloudForce = 'on' | 'off' | null
export function cloudForce(env: NodeJS.ProcessEnv = process.env): CloudForce {
  if (env.YOGURT_CLOUD === '0') return 'off'
  if (env.YOGURT_CLOUD === '1') return 'on'
  return null
}

export type CloudConfig = {
  enabled: boolean
  tenantId: string
  clientId: string
  apiUrl: string
  scope: string
}

export function readCloudConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const tenantId = (env.YOGURT_ENTRA_TENANT_ID || settings.cloudTenantId || '').trim()
  const clientId = (env.YOGURT_ENTRA_CLIENT_ID || settings.cloudClientId || '').trim()
  const apiUrl = (env.YOGURT_CLOUD_API_URL || settings.cloudApiUrl || '').trim().replace(/\/$/, '')
  const scope = (env.YOGURT_ENTRA_API_SCOPE || settings.cloudApiScope || '').trim()
  return { enabled: cloudModeEnabled(settings, env), tenantId, clientId, apiUrl, scope }
}

export function cloudConfigured(config: CloudConfig): boolean {
  return !!(config.tenantId && config.clientId && config.apiUrl && config.scope)
}

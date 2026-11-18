import { bakedCloud, type BakedCloud } from './baked'
import type { Settings } from '../settings'

/**
 * Cloud mode is off unless a setting, YOGURT_CLOUD, or a pilot build's baked defaults turn it on.
 * YOGURT_CLOUD=0 forces local mode. An explicit cloudMode: false in settings does too, so a
 * baked installer can be turned off.
 */
export function cloudModeEnabled(settings: Pick<Settings, 'cloudMode'>, env: NodeJS.ProcessEnv = process.env, baked: BakedCloud = bakedCloud): boolean {
  if (env.YOGURT_CLOUD === '0') return false
  if (env.YOGURT_CLOUD === '1') return true
  if (settings.cloudMode === false) return false
  if (settings.cloudMode === true) return true
  return baked.enabled === true
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

export function readCloudConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env, baked: BakedCloud = bakedCloud): CloudConfig {
  const tenantId = (env.YOGURT_ENTRA_TENANT_ID || settings.cloudTenantId || baked.tenantId || '').trim()
  const clientId = (env.YOGURT_ENTRA_CLIENT_ID || settings.cloudClientId || baked.clientId || '').trim()
  const apiUrl = (env.YOGURT_CLOUD_API_URL || settings.cloudApiUrl || baked.apiUrl || '').trim().replace(/\/$/, '')
  const scope = (env.YOGURT_ENTRA_API_SCOPE || settings.cloudApiScope || baked.scope || '').trim()
  return { enabled: cloudModeEnabled(settings, env, baked), tenantId, clientId, apiUrl, scope }
}

export function cloudConfigured(config: CloudConfig): boolean {
  return !!(config.tenantId && config.clientId && config.apiUrl && config.scope)
}

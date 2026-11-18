import { describe, expect, it } from 'vitest'
import { cloudConfigured, cloudForce, cloudModeEnabled, readCloudConfig } from '../src/main/cloud/config'
import type { Settings } from '../src/main/settings'

const empty = {} as Settings

describe('cloud mode', () => {
  it('stays on this computer unless a setting or YOGURT_CLOUD asks for the cloud', () => {
    expect(cloudModeEnabled(empty, {})).toBe(false)
    expect(cloudModeEnabled({ cloudMode: true }, {})).toBe(true)
    expect(cloudModeEnabled(empty, { YOGURT_CLOUD: '1' })).toBe(true)
    expect(cloudModeEnabled({ cloudMode: true }, { YOGURT_CLOUD: '0' })).toBe(false)
    expect(cloudForce({})).toBeNull()
    expect(cloudForce({ YOGURT_CLOUD: '1' })).toBe('on')
    expect(cloudForce({ YOGURT_CLOUD: '0' })).toBe('off')
  })

  it('reads the pilot addresses from the environment before settings, and never from a secret', () => {
    const config = readCloudConfig({
      cloudTenantId: 'from-settings', cloudClientId: 'client-settings', cloudApiUrl: 'https://settings.example/api/', cloudApiScope: 'scope-settings',
    }, {
      YOGURT_ENTRA_TENANT_ID: '6a94fd93-b4dc-42db-9712-8defab2a3e93',
      YOGURT_ENTRA_CLIENT_ID: 'desktop-client',
      YOGURT_CLOUD_API_URL: 'https://func.example/api/',
      YOGURT_ENTRA_API_SCOPE: 'api://api-client/access_as_user',
      YOGURT_CLOUD: '1',
    })
    expect(config).toEqual({
      enabled: true,
      tenantId: '6a94fd93-b4dc-42db-9712-8defab2a3e93',
      clientId: 'desktop-client',
      apiUrl: 'https://func.example/api',
      scope: 'api://api-client/access_as_user',
    })
    expect(cloudConfigured(config)).toBe(true)
    expect(cloudConfigured(readCloudConfig(empty, {}))).toBe(false)
    expect(JSON.stringify(config)).not.toMatch(/api[-_]?key|secret|subscription/i)
  })

  it('uses addresses baked into a pilot installer, unless the setting or YOGURT_CLOUD=0 says otherwise', () => {
    const baked = {
      enabled: true,
      tenantId: '6a94fd93-b4dc-42db-9712-8defab2a3e93',
      clientId: '9e9aa69e-3390-42f4-8076-a5f1f6ce16f6',
      apiUrl: 'https://func-yogurt-pilot.azurewebsites.net/api/',
      scope: 'api://e797299f-c081-494b-8864-9fb143e2e84f/access_as_user',
    }
    expect(readCloudConfig(empty, {}, baked)).toEqual({
      enabled: true,
      tenantId: baked.tenantId,
      clientId: baked.clientId,
      apiUrl: 'https://func-yogurt-pilot.azurewebsites.net/api',
      scope: baked.scope,
    })
    expect(cloudModeEnabled({ cloudMode: false }, {}, baked)).toBe(false)
    expect(cloudModeEnabled(empty, { YOGURT_CLOUD: '0' }, baked)).toBe(false)
    expect(readCloudConfig({ cloudTenantId: 'from-settings' }, {}, baked).tenantId).toBe('from-settings')
  })
})

import { describe, expect, it } from 'vitest'
import { entraAuthority, PILOT_TENANT_ID, pilotAccountAllowed } from '../src/main/cloud/tenant'

describe('Preferred by Nature sign-in', () => {
  it('uses only the tenant-specific authority', () => {
    expect(entraAuthority(PILOT_TENANT_ID)).toBe(`https://login.microsoftonline.com/${PILOT_TENANT_ID}`)
    expect(() => entraAuthority('common')).toThrow(/Preferred by Nature/)
    expect(() => entraAuthority('organizations')).toThrow(/Preferred by Nature/)
    expect(() => entraAuthority('consumers')).toThrow(/Preferred by Nature/)
    expect(() => entraAuthority('')).toThrow(/Preferred by Nature/)
  })

  it('accepts this tenant and a @pbn.org account, and rejects the others', () => {
    expect(pilotAccountAllowed({ tid: PILOT_TENANT_ID, username: 'a@pbn.org' }, PILOT_TENANT_ID)).toBe(true)
    expect(pilotAccountAllowed({ tid: PILOT_TENANT_ID, username: 'A@PBN.ORG' }, PILOT_TENANT_ID)).toBe(true)
    expect(pilotAccountAllowed({ tid: PILOT_TENANT_ID }, PILOT_TENANT_ID)).toBe(true)
    expect(pilotAccountAllowed({ tid: 'other', username: 'a@pbn.org' }, PILOT_TENANT_ID)).toBe(false)
    expect(pilotAccountAllowed({ tid: PILOT_TENANT_ID, username: 'a@example.com' }, PILOT_TENANT_ID)).toBe(false)
    expect(pilotAccountAllowed({ tid: PILOT_TENANT_ID, username: 'not-an-email' }, PILOT_TENANT_ID)).toBe(true)
    expect(pilotAccountAllowed({ username: 'a@pbn.org' }, PILOT_TENANT_ID)).toBe(false)
  })
})

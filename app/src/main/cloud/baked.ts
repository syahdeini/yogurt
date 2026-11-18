/** Values written into a pilot installer by scripts/bake-cloud.mjs. Empty here, so a normal build stays on this computer. */
export const bakedCloud = {
  enabled: false,
  tenantId: '',
  clientId: '',
  apiUrl: '',
  scope: '',
} as const

export type BakedCloud = { enabled: boolean; tenantId: string; clientId: string; apiUrl: string; scope: string }

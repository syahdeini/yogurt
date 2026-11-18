/**
 * Writes app/src/main/cloud/baked.ts from YOGURT_CLOUD and the Entra addresses.
 * The pilot Windows workflow runs this before electron-vite so the installer carries the
 * defaults. They are not secrets. A normal build does not run this, so bakedCloud stays off.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bake = {
  enabled: process.env.YOGURT_CLOUD === '1',
  tenantId: (process.env.YOGURT_ENTRA_TENANT_ID ?? '').trim(),
  clientId: (process.env.YOGURT_ENTRA_CLIENT_ID ?? '').trim(),
  apiUrl: (process.env.YOGURT_CLOUD_API_URL ?? '').trim().replace(/\/$/, ''),
  scope: (process.env.YOGURT_ENTRA_API_SCOPE ?? '').trim(),
}
const file = join(dirname(fileURLToPath(import.meta.url)), '../src/main/cloud/baked.ts')
const body = `/** Written by scripts/bake-cloud.mjs for this build. Not a secret. */\nexport const bakedCloud = ${JSON.stringify(bake, null, 2)} as const\n\nexport type BakedCloud = { enabled: boolean; tenantId: string; clientId: string; apiUrl: string; scope: string }\n`
writeFileSync(file, body)
console.log(`baked cloud mode ${bake.enabled ? 'on' : 'off'} into ${file}`)

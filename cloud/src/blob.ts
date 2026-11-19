import { DefaultAzureCredential } from '@azure/identity'
import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, SASProtocol } from '@azure/storage-blob'
import { requiredEnv } from './claims.js'

let service: BlobServiceClient | undefined

function client(): BlobServiceClient {
  service ??= new BlobServiceClient(`https://${requiredEnv('STORAGE_ACCOUNT_NAME')}.blob.core.windows.net`, new DefaultAzureCredential())
  return service
}

const container = () => process.env.STORAGE_CONTAINER?.trim() || 'audio'

export function extensionFor(contentType: string): string {
  if (contentType.includes('ogg')) return '.ogg'
  if (contentType.includes('wav')) return '.wav'
  if (contentType.includes('webm')) return '.webm'
  return '.m4a'
}

export function blobNameFor(oid: string, meetingId: string, track: 'me' | 'them', contentType: string): string {
  return `${oid}/${meetingId}/${track}${extensionFor(contentType)}`
}

async function sas(blobName: string, permissions: string, minutes: number): Promise<{ url: string; expiresAt: string }> {
  const account = requiredEnv('STORAGE_ACCOUNT_NAME')
  const startsOn = new Date(Date.now() - 5 * 60 * 1000)
  const expiresOn = new Date(Date.now() + minutes * 60 * 1000)
  const key = await client().getUserDelegationKey(startsOn, expiresOn)
  const query = generateBlobSASQueryParameters({
    containerName: container(), blobName, permissions: BlobSASPermissions.parse(permissions), startsOn, expiresOn, protocol: SASProtocol.Https,
  }, key, account).toString()
  return { url: `https://${account}.blob.core.windows.net/${container()}/${blobName}?${query}`, expiresAt: expiresOn.toISOString() }
}

/** Read is needed too: the app lists the blob's uncommitted blocks (Get Block List) to resume an upload. */
export const uploadSas = (blobName: string) => sas(blobName, 'rcw', 120)
export const readSas = (blobName: string) => sas(blobName, 'r', 180)

/** A block blob exists only after its block list is committed, so this is true once an upload has finished. */
export async function blobExists(blobName: string): Promise<boolean> {
  return client().getContainerClient(container()).getBlobClient(blobName).exists()
}

export async function deleteBlob(blobName: string): Promise<void> {
  await client().getContainerClient(container()).getBlobClient(blobName).deleteIfExists()
}

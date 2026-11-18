import { open, stat } from 'node:fs/promises'

export const CHUNK_BYTES = 4 * 1024 * 1024

/** Azure requires every block id in a blob to be the same length. Eight digits covers a multi-hour recording. */
export function blockId(index: number): string {
  return Buffer.from(String(index).padStart(8, '0'), 'utf8').toString('base64')
}

export function blockIdsFromList(xml: string): string[] {
  return [...xml.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1]).filter(Boolean)
}

export function blockListXml(ids: string[]): string {
  const items = ids.map((id) => `<Latest>${id}</Latest>`).join('')
  return `<?xml version="1.0" encoding="utf-8"?><BlockList>${items}</BlockList>`
}

export function withQuery(sasUrl: string, extra: Record<string, string>): string {
  const url = new URL(sasUrl)
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)
  return url.toString()
}

export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 408 || error.status === 429 || error.status >= 500
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|offline|socket|ECONNRESET|Failed to fetch|aborted/i.test(message)
}

export const OFFLINE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

export async function retryOffline<T>(run: () => Promise<T>, o: {
  signal?: AbortSignal
  delaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  retryable?: (error: unknown) => boolean
} = {}): Promise<T> {
  const delays = o.delaysMs ?? OFFLINE_DELAYS_MS
  const sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const retryable = o.retryable ?? isRetryable
  let last: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (o.signal?.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted')
    try { return await run() } catch (error) {
      last = error
      if (o.signal?.aborted || !retryable(error) || attempt === delays.length) throw error
      await sleep(delays[attempt] ?? 30_000)
    }
  }
  throw last
}

export type ByteSource = { size: number; read(offset: number, length: number): Promise<Uint8Array> }

export async function fileSource(path: string): Promise<ByteSource> {
  const size = (await stat(path)).size
  const handle = await open(path, 'r')
  return {
    size,
    async read(offset, length) {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return buf.subarray(0, bytesRead)
    },
  }
}

export async function uploadBlockBlob(o: {
  sasUrl: string
  source: ByteSource
  contentType: string
  chunkBytes?: number
  fetch?: typeof fetch
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  delaysMs?: number[]
}): Promise<void> {
  const fetchImpl = o.fetch ?? fetch
  const chunkBytes = o.chunkBytes ?? CHUNK_BYTES
  const retry = <T>(run: () => Promise<T>) => retryOffline(run, { signal: o.signal, sleep: o.sleep, delaysMs: o.delaysMs })
  const present = await retry(async () => {
    const response = await fetchImpl(withQuery(o.sasUrl, { comp: 'blocklist', blocklisttype: 'uncommitted' }), { method: 'GET', signal: o.signal })
    if (response.status === 404) return []
    if (!response.ok) throw new HttpStatusError(response.status, `listing blocks failed (${response.status})`)
    return blockIdsFromList(await response.text())
  })
  const done = new Set(present)
  const ids: string[] = []
  const count = Math.max(1, Math.ceil(o.source.size / chunkBytes))
  for (let index = 0; index < count; index++) {
    const id = blockId(index)
    ids.push(id)
    if (done.has(id)) continue
    const start = index * chunkBytes
    const bytes = await o.source.read(start, Math.min(chunkBytes, o.source.size - start))
    await retry(async () => {
      const response = await fetchImpl(withQuery(o.sasUrl, { comp: 'block', blockid: id }), {
        method: 'PUT', body: Buffer.from(bytes), signal: o.signal, headers: { 'content-type': 'application/octet-stream' },
      })
      if (!response.ok) throw new HttpStatusError(response.status, `uploading a block failed (${response.status})`)
    })
  }
  await retry(async () => {
    const response = await fetchImpl(withQuery(o.sasUrl, { comp: 'blocklist' }), {
      method: 'PUT',
      body: blockListXml(ids),
      signal: o.signal,
      headers: { 'content-type': 'application/xml', 'x-ms-blob-content-type': o.contentType },
    })
    if (!response.ok) throw new HttpStatusError(response.status, `committing the upload failed (${response.status})`)
  })
}

export function audioContentType(path: string): string {
  if (path.endsWith('.ogg')) return 'audio/ogg'
  if (path.endsWith('.wav')) return 'audio/wav'
  if (path.endsWith('.webm')) return 'audio/webm'
  return 'audio/mp4'
}

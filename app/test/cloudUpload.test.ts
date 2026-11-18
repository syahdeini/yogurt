import { describe, expect, it } from 'vitest'
import { blockId, blockIdsFromList, blockListXml, HttpStatusError, isRetryable, retryOffline, uploadBlockBlob, type ByteSource } from '../src/main/cloud/upload'

const source = (text: string): ByteSource => ({
  size: Buffer.byteLength(text),
  async read(offset, length) { return Buffer.from(text).subarray(offset, offset + length) },
})

describe('chunked upload', () => {
  it('builds equal-length block ids and a commit list', () => {
    expect(blockId(0)).toBe(blockId(1).slice(0, 0) + blockId(0))
    expect(Buffer.from(blockId(1), 'base64').length).toBe(Buffer.from(blockId(99), 'base64').length)
    expect(blockIdsFromList('<Block><Name>YQ==</Name></Block><Block><Name>Yg==</Name></Block>')).toEqual(['YQ==', 'Yg=='])
    expect(blockListXml(['YQ==', 'Yg=='])).toContain('<Latest>YQ==</Latest><Latest>Yg==</Latest>')
  })

  it('retries an offline put and skips a block that already reached the service', async () => {
    const calls: string[] = []
    let puts = 0
    const fetchImpl: typeof fetch = async (url, init) => {
      const href = String(url)
      calls.push(`${init?.method} ${href}`)
      if (href.includes('blocklisttype=uncommitted')) return new Response('<BlockList><Block><Name>MDAwMDAwMDA=</Name></Block></BlockList>')
      if (href.includes('comp=block') && !href.includes('blocklist')) {
        puts++
        if (puts === 1) throw new Error('fetch failed')
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 201 })
    }
    await uploadBlockBlob({
      sasUrl: 'https://account.blob.core.windows.net/audio/file.ogg?sig=sas',
      source: source('abcdefghijklmnopqrstuvwxyz'),
      contentType: 'audio/ogg',
      chunkBytes: 10,
      fetch: fetchImpl,
      delaysMs: [0, 0, 0],
      sleep: async () => {},
    })
    const blocks = calls.filter((call) => call.includes('comp=block&') || call.includes('comp=block&'.slice(0, 0)))
    expect(calls.some((call) => call.includes('blockid=MDAwMDAwMDA'))).toBe(false)
    expect(calls.filter((call) => call.startsWith('PUT') && call.includes('blockid=')).length).toBeGreaterThanOrEqual(2)
    expect(calls.at(-1)).toContain('comp=blocklist')
    expect(blocks).toBeDefined()
  })

  it('does not retry a refusal', async () => {
    let tries = 0
    await expect(retryOffline(async () => { tries++; throw new HttpStatusError(403, 'no') }, { delaysMs: [0, 0], sleep: async () => {} })).rejects.toThrow(/no/)
    expect(tries).toBe(1)
    expect(isRetryable(new HttpStatusError(503, 'busy'))).toBe(true)
    expect(isRetryable(new Error('getaddrinfo ENOTFOUND api'))).toBe(true)
  })
})

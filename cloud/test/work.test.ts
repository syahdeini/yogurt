import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingRow, TrackState } from '../src/db'

// An in-memory notes.meetings with the same lease rules as the SQL.
const state = vi.hoisted(() => ({
  rows: new Map<string, MeetingRow & { lease: boolean }>(),
  blobs: new Set<string>(),
  speechStarted: [] as string[],
  speechStatus: 'running' as 'running' | 'succeeded' | 'failed',
  summaryFails: false,
  summaries: 0,
}))

vi.mock('../src/db.js', () => {
  const active = (row: MeetingRow) => ['uploaded', 'transcribing', 'summarizing'].includes(row.status)
  const plain = ({ lease: _lease, ...row }: MeetingRow & { lease: boolean }): MeetingRow => ({ ...row })
  return {
    tracksOf: (raw: string | null) => raw ? JSON.parse(raw) : [],
    activeMeetings: async () => [...state.rows.values()].filter(active).map(plain),
    findByBlob: async (name: string) => [...state.rows.values()].map(plain).find((row) => row.status !== 'failed' && row.tracks.includes(name)),
    claimLease: async (id: string) => {
      const row = state.rows.get(id)
      if (!row || row.lease || !active(row)) return undefined
      row.lease = true
      return plain(row)
    },
    releaseLease: async (id: string) => { const row = state.rows.get(id); if (row) row.lease = false },
    saveTracks: async (id: string, _oid: string, tracks: TrackState[], status: string) => {
      const row = state.rows.get(id)!
      row.tracks = JSON.stringify(tracks); row.status = status
    },
    markFailed: async (id: string, _oid: string, error: string) => {
      const row = state.rows.get(id)!
      if (row.status !== 'ready') { row.status = 'failed'; row.error = error }
    },
    bumpAttempts: async (id: string) => { const row = state.rows.get(id)!; row.attempts += 1; return row.attempts },
    storeResult: async (row: MeetingRow) => { state.rows.get(row.id)!.status = 'ready' },
    readResult: async () => ({ segments: [], summary: null }),
  }
})
vi.mock('../src/blob.js', () => ({
  blobExists: async (name: string) => state.blobs.has(name),
  readSas: async (name: string) => ({ url: `https://blob/${name}?sas`, expiresAt: '' }),
}))
vi.mock('../src/speech/client.js', () => ({
  startBatchTranscription: async ({ contentUrl }: { contentUrl: string }) => {
    // Gives the other caller a chance to run, as a real HTTP call would.
    await new Promise((resolve) => setTimeout(resolve, 5))
    state.speechStarted.push(contentUrl)
    return { self: `https://speech/jobs/${state.speechStarted.length}` }
  },
  transcriptionStatus: async () => state.speechStatus,
  transcriptionSegments: async (_self: string, track: 'me' | 'them') => [{ track, speaker: null, startMs: 0, endMs: 1, text: 'hi' }],
}))
vi.mock('../src/summary/azureOpenAi.js', () => ({
  createSummaryProvider: () => ({
    id: 'azure-openai-gpt-5-mini',
    async summarize() {
      state.summaries++
      if (state.summaryFails) throw new Error('model down')
      return { markdown: '## Plan', actionItems: [] }
    },
  }),
}))

const { onBlob, pollActive, MAX_SUMMARY_ATTEMPTS } = await import('../src/work')

const log = () => {}
const me = 'oid/m1/me.ogg'
const them = 'oid/m1/them.ogg'

function addMeeting() {
  const tracks: TrackState[] = [
    { track: 'me', blobName: me, contentType: 'audio/ogg' },
    { track: 'them', blobName: them, contentType: 'audio/ogg' },
  ]
  state.rows.set('m1', {
    id: 'm1', user_oid: 'oid', local_id: 'l1', title: 'Weekly', status: 'uploaded', tracks: JSON.stringify(tracks),
    language: null, error: null, attempts: 0, lease: false,
  })
}

beforeEach(() => {
  state.rows.clear(); state.blobs.clear(); state.speechStarted = []
  state.speechStatus = 'running'; state.summaryFails = false; state.summaries = 0
  addMeeting()
})

describe('cloud worker', () => {
  it('does not start Speech while a track is still uploading', async () => {
    await pollActive(log) // row exists, nothing uploaded yet
    state.blobs.add(me)
    await onBlob(me, log) // me committed, them still uploading
    expect(state.speechStarted).toEqual([])
    expect(state.rows.get('m1')!.status).toBe('uploaded')

    state.blobs.add(them)
    await onBlob(them, log)
    expect(state.speechStarted).toHaveLength(2)
    expect(state.rows.get('m1')!.status).toBe('transcribing')
  })

  it('starts each Speech job once when the timer and Event Grid race', async () => {
    state.blobs.add(me); state.blobs.add(them)
    await Promise.all([onBlob(me, log), onBlob(them, log), pollActive(log)])
    expect(state.speechStarted).toHaveLength(2)
    await pollActive(log) // jobs exist now; polling never starts more
    expect(state.speechStarted).toHaveLength(2)
  })

  it('stores the result once Speech succeeds', async () => {
    state.blobs.add(me); state.blobs.add(them)
    await pollActive(log)
    state.speechStatus = 'succeeded'
    await pollActive(log)
    expect(state.rows.get('m1')!.status).toBe('ready')
  })

  it('gives up on a summary that keeps failing instead of retrying forever', async () => {
    state.blobs.add(me); state.blobs.add(them)
    await pollActive(log)
    state.speechStatus = 'succeeded'
    state.summaryFails = true
    for (let minute = 0; minute < MAX_SUMMARY_ATTEMPTS + 3; minute++) await pollActive(log)
    expect(state.summaries).toBe(MAX_SUMMARY_ATTEMPTS)
    expect(state.rows.get('m1')!.status).toBe('failed')
    expect(state.rows.get('m1')!.error).toMatch(/Summary failed after 5 attempts/)
  })
})

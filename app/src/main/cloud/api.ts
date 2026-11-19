import type { SummaryInput, SummaryOutput } from '../../engine/summaryProvider'
import { requireSummaryModel } from '../../engine/summaryProvider'
import type { CloudTrack, TranscriptionSegment } from '../asr/provider'
import { retryOffline } from './upload'

export type CloudMeetingStatus = 'uploaded' | 'transcribing' | 'summarizing' | 'ready' | 'failed'

export type CloudMeeting = {
  meetingId: string
  status: CloudMeetingStatus
  language: string | null
  segments: TranscriptionSegment[]
  summary: SummaryOutput | null
  error: string | null
}

export type UploadTarget = { track: CloudTrack; blobName: string; sasUrl: string; expiresAt: string }

/** status is where the server already is; anything past uploaded means the audio is already there. */
export type CreatedUpload = { meetingId: string; status: CloudMeetingStatus; uploads: UploadTarget[] }

const STATUSES: readonly string[] = ['uploaded', 'transcribing', 'summarizing', 'ready', 'failed']

export function createCloudApi(o: {
  apiUrl: string
  token: () => Promise<string>
  fetch?: typeof fetch
}) {
  const fetchImpl = o.fetch ?? fetch
  const send = async (path: string, init: { method: string; body?: unknown }, signal?: AbortSignal) => {
    const token = await o.token()
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' })
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchImpl(`${o.apiUrl}${path}`, {
      method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Cloud API ${init.method} ${path} failed (${response.status}) ${detail}`.trim())
    }
    return response.json() as Promise<unknown>
  }
  return {
    createMeeting(body: { localId: string; title: string; tracks: Array<{ track: CloudTrack; contentType: string; bytes: number }> }, signal?: AbortSignal) {
      return send('/meetings', { method: 'POST', body }, signal).then(parseCreated)
    },
    refreshSas(meetingId: string, signal?: AbortSignal) {
      return send(`/meetings/${encodeURIComponent(meetingId)}/sas`, { method: 'POST', body: {} }, signal).then(parseCreated)
    },
    getMeeting(meetingId: string, signal?: AbortSignal) {
      return send(`/meetings/${encodeURIComponent(meetingId)}`, { method: 'GET' }, signal).then(parseMeeting)
    },
    summarize(meetingId: string, body: SummaryInput, signal?: AbortSignal) {
      return send(`/meetings/${encodeURIComponent(meetingId)}/summarize`, { method: 'POST', body }, signal).then(parseMeeting)
    },
  }
}
export type CloudApi = ReturnType<typeof createCloudApi>

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Cloud API returned an unexpected response')
  return value as Record<string, unknown>
}

export function parseCreated(value: unknown): CreatedUpload {
  const body = asObject(value)
  const meetingId = typeof body.meetingId === 'string' ? body.meetingId : ''
  const uploads = Array.isArray(body.uploads) ? body.uploads.map(parseUpload) : []
  if (!meetingId || !uploads.length) throw new Error('Cloud API did not return an upload')
  const status = typeof body.status === 'string' && STATUSES.includes(body.status) ? body.status as CloudMeetingStatus : 'uploaded'
  return { meetingId, status, uploads }
}

function parseUpload(value: unknown): UploadTarget {
  const body = asObject(value)
  const track = body.track === 'me' || body.track === 'them' ? body.track : null
  if (!track || typeof body.sasUrl !== 'string' || typeof body.blobName !== 'string') throw new Error('Cloud API returned a bad upload')
  return { track, blobName: body.blobName, sasUrl: body.sasUrl, expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '' }
}

export function parseMeeting(value: unknown): CloudMeeting {
  const body = asObject(value)
  const status = typeof body.status === 'string' && STATUSES.includes(body.status) ? body.status as CloudMeetingStatus : null
  const meetingId = typeof body.meetingId === 'string' ? body.meetingId : ''
  if (!status || !meetingId) throw new Error('Cloud API returned a bad meeting')
  const summary = body.summary == null ? null : parseSummary(body.summary)
  return {
    meetingId, status, summary,
    language: typeof body.language === 'string' ? body.language : null,
    segments: Array.isArray(body.segments) ? body.segments.flatMap(parseSegment) : [],
    error: typeof body.error === 'string' ? body.error : null,
  }
}

function parseSegment(value: unknown): TranscriptionSegment[] {
  const body = asObject(value)
  const track = body.track === 'me' || body.track === 'them' ? body.track : null
  if (!track || typeof body.text !== 'string' || !body.text.trim()) return []
  const startMs = Number(body.startMs), endMs = Number(body.endMs)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return []
  return [{ track, speaker: typeof body.speaker === 'string' && body.speaker ? body.speaker : null, startMs, endMs, text: body.text.trim() }]
}

function parseSummary(value: unknown): SummaryOutput {
  const body = asObject(value)
  const markdown = typeof body.markdown === 'string' ? body.markdown : ''
  const model = requireSummaryModel(typeof body.model === 'string' ? body.model : '')
  const actionItems = Array.isArray(body.actionItems) ? body.actionItems.flatMap((item) => {
    const row = asObject(item)
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    if (!text) return []
    return [{ owner: typeof row.owner === 'string' && row.owner ? row.owner : null, text, due: typeof row.due === 'string' && row.due ? row.due : null }]
  }) : []
  return { markdown, model, actionItems }
}

export async function pollUntilReady(get: () => Promise<CloudMeeting>, o: {
  signal?: AbortSignal
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
} = {}): Promise<CloudMeeting> {
  const interval = o.intervalMs ?? 3_000
  // Batch transcription of a long meeting can queue; an hour leaves room before the app gives up.
  const timeout = o.timeoutMs ?? 60 * 60 * 1000
  const sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = o.now ?? Date.now
  const start = now()
  for (;;) {
    if (o.signal?.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted')
    const meeting = await retryOffline(get, { signal: o.signal, sleep, delaysMs: [1_000, 2_000, 4_000] })
    if (meeting.status === 'ready') return meeting
    if (meeting.status === 'failed') throw new Error(meeting.error || 'Cloud transcription failed')
    if (now() - start > timeout) throw new Error('Cloud transcription timed out')
    await sleep(interval)
  }
}

import { randomUUID } from 'node:crypto'
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { blobNameFor, uploadSas } from './blob.js'
import { HttpError } from './claims.js'
import { findOwn, findOwnByLocal, insertMeeting, readResult, type MeetingRow, type TrackState } from './db.js'
import { bearer, verifyEntraToken } from './entra.js'
import { resumarize } from './work.js'

function json(status: number, body: unknown): HttpResponseInit {
  return { status, jsonBody: body }
}

async function user(request: HttpRequest): Promise<{ oid: string }> {
  try { return await verifyEntraToken(bearer(request.headers.get('authorization'))) }
  catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(401, 'Sign in required')
  }
}

function view(row: MeetingRow, result?: Awaited<ReturnType<typeof readResult>>) {
  return {
    meetingId: row.id,
    status: row.status,
    language: row.language,
    segments: row.status === 'ready' ? result?.segments ?? [] : [],
    summary: row.status === 'ready' ? result?.summary ?? null : null,
    error: row.error,
  }
}

export async function health(): Promise<HttpResponseInit> {
  return json(200, { ok: true })
}

export async function createMeeting(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const { oid } = await user(request)
    const body = await request.json() as { localId?: string; title?: string; tracks?: Array<{ track?: string; contentType?: string; bytes?: number }> }
    const localId = typeof body.localId === 'string' ? body.localId.slice(0, 64) : ''
    const tracks = (body.tracks ?? []).flatMap((track): TrackState[] => {
      if ((track.track !== 'me' && track.track !== 'them') || typeof track.contentType !== 'string') return []
      return [{ track: track.track, contentType: track.contentType, blobName: '' }]
    })
    if (!localId || !tracks.length) return json(400, { error: 'localId and tracks are required' })
    const existing = await findOwnByLocal(oid, localId)
    const id = existing?.id ?? randomUUID()
    const stored: TrackState[] = tracks.map((track) => ({
      ...track,
      blobName: blobNameFor(oid, id, track.track, track.contentType),
    }))
    if (!existing) await insertMeeting({ id, oid, localId, title: typeof body.title === 'string' ? body.title : 'Meeting', tracks: stored })
    const uploads = await Promise.all(stored.map(async (track) => {
      const sas = await uploadSas(track.blobName)
      return { track: track.track, blobName: track.blobName, sasUrl: sas.url, expiresAt: sas.expiresAt }
    }))
    context.log(`upload sas for meeting ${id} tracks=${uploads.length}`)
    return json(existing ? 200 : 201, { meetingId: id, uploads })
  } catch (error) { return fail(context, error) }
}

export async function refreshSas(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const { oid } = await user(request)
    const id = request.params.id ?? ''
    const row = await findOwn(oid, id)
    if (!row) return json(404, { error: 'Meeting not found' })
    const uploads = await Promise.all((JSON.parse(row.tracks) as TrackState[]).map(async (track) => {
      const sas = await uploadSas(track.blobName)
      return { track: track.track, blobName: track.blobName, sasUrl: sas.url, expiresAt: sas.expiresAt }
    }))
    return json(200, { meetingId: row.id, uploads })
  } catch (error) { return fail(context, error) }
}

export async function getMeeting(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const { oid } = await user(request)
    const row = await findOwn(oid, request.params.id ?? '')
    if (!row) return json(404, { error: 'Meeting not found' })
    const result = row.status === 'ready' ? await readResult(oid, row.id) : undefined
    return json(200, view(row, result))
  } catch (error) { return fail(context, error) }
}

export async function summarize(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const { oid } = await user(request)
    const row = await findOwn(oid, request.params.id ?? '')
    if (!row) return json(404, { error: 'Meeting not found' })
    const body = await request.json() as { title?: string; notes?: string; attendees?: string[]; instruction?: string; language?: string }
    await resumarize(row, body)
    const updated = await findOwn(oid, row.id)
    const result = updated ? await readResult(oid, updated.id) : undefined
    return json(200, view(updated ?? row, result))
  } catch (error) { return fail(context, error) }
}

function fail(context: InvocationContext, error: unknown): HttpResponseInit {
  const status = error instanceof HttpError ? error.status : (error as { status?: number }).status
  if (typeof status === 'number' && status >= 400 && status < 500) return json(status, { error: error instanceof Error ? error.message : 'Request failed' })
  context.error('request failed', error)
  return json(500, { error: 'Cloud notes failed' })
}

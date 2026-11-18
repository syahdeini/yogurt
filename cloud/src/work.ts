import { readSas } from './blob.js'
import { findByBlob, activeMeetings, markFailed, readResult, saveTracks, storeResult, tracksOf, type MeetingRow, type TrackState } from './db.js'
import { startBatchTranscription, transcriptionSegments, transcriptionStatus } from './speech/client.js'
import type { CloudSegment } from './speech/parse.js'
import { createSummaryProvider } from './summary/azureOpenAi.js'

type Log = (message: string) => void

function transcriptText(segments: CloudSegment[]): string {
  return segments.map((segment) => `${segment.track === 'me' ? 'You' : segment.speaker || 'Them'}: ${segment.text}`).join('\n')
}

async function startMissing(row: MeetingRow, log: Log): Promise<void> {
  const tracks = tracksOf(row.tracks)
  let changed = false
  for (const track of tracks) {
    if (track.speechUrl) continue
    const sas = await readSas(track.blobName)
    const job = await startBatchTranscription({ contentUrl: sas.url, displayName: row.id })
    track.speechUrl = job.self
    track.speechStatus = 'running'
    changed = true
    log(`meeting ${row.id} started speech for ${track.track}`)
  }
  if (changed) await saveTracks(row.id, row.user_oid, tracks, 'transcribing')
}

async function advance(row: MeetingRow, log: Log): Promise<void> {
  if (row.status === 'ready' || row.status === 'failed') return
  const tracks = tracksOf(row.tracks)
  if (tracks.some((track) => !track.speechUrl)) await startMissing(row, log)
  const current = tracksOf((await reload(row))?.tracks ?? row.tracks)
  if (current.some((track) => !track.speechUrl)) return
  const segments: CloudSegment[] = []
  for (const track of current) {
    if (track.speechStatus === 'succeeded') continue
    try {
      const status = await transcriptionStatus(track.speechUrl!)
      if (status === 'running') return
      if (status === 'failed') {
        track.speechStatus = 'failed'
        await saveTracks(row.id, row.user_oid, current, 'failed')
        await markFailed(row.id, row.user_oid, 'Speech transcription failed')
        log(`meeting ${row.id} speech failed`)
        return
      }
      track.speechStatus = 'succeeded'
    } catch (error) {
      log(`meeting ${row.id} speech poll will retry: ${error instanceof Error ? error.message : 'error'}`)
      return
    }
  }
  for (const track of current) {
    if (track.speechStatus !== 'succeeded' || !track.speechUrl) return
    segments.push(...await transcriptionSegments(track.speechUrl, track.track))
  }
  segments.sort((a, b) => a.startMs - b.startMs || a.track.localeCompare(b.track))
  await saveTracks(row.id, row.user_oid, current, 'summarizing')
  const provider = createSummaryProvider()
  const summary = await provider.summarize({
    title: row.title || 'Meeting',
    transcript: transcriptText(segments),
    attendees: [],
  })
  await storeResult(row, segments, { ...summary, model: provider.id }, null)
  log(`meeting ${row.id} ready segments=${segments.length} model=${provider.id}`)
}

async function reload(row: MeetingRow): Promise<MeetingRow | undefined> {
  const matches = await activeMeetings()
  return matches.find((item) => item.id === row.id)
}

export async function onBlob(blobName: string, log: Log): Promise<void> {
  const row = await findByBlob(blobName)
  if (!row) { log(`blob ${blobName} has no meeting`); return }
  await advance(row, log)
}

export async function pollActive(log: Log): Promise<void> {
  for (const row of await activeMeetings()) {
    try { await advance(row, log) } catch (error) {
      log(`meeting ${row.id} poll failed: ${error instanceof Error ? error.message : 'error'}`)
    }
  }
}

export async function resumarize(row: MeetingRow, input: { title?: string; notes?: string; attendees?: string[]; instruction?: string; language?: string }): Promise<void> {
  const saved = await readResult(row.user_oid, row.id)
  if (!saved.segments.length) throw Object.assign(new Error('Transcript is not ready'), { status: 409 })
  const provider = createSummaryProvider()
  const summary = await provider.summarize({
    title: input.title || row.title || 'Meeting',
    transcript: transcriptText(saved.segments),
    notes: input.notes,
    attendees: input.attendees,
    instruction: input.instruction,
    language: input.language,
  })
  await storeResult(row, saved.segments, { ...summary, model: provider.id }, row.language)
}

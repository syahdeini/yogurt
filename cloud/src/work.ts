import { blobExists, readSas } from './blob.js'
import {
  activeMeetings, bumpAttempts, claimLease, findByBlob, markFailed, readResult, releaseLease, saveTracks, storeResult, tracksOf,
  type MeetingRow,
} from './db.js'
import { startBatchTranscription, transcriptionSegments, transcriptionStatus } from './speech/client.js'
import type { CloudSegment } from './speech/parse.js'
import { createSummaryProvider } from './summary/azureOpenAi.js'

type Log = (message: string) => void

/** Long enough for a summary call; a crashed worker frees the meeting again after this. */
export const LEASE_SECONDS = 600
/** A summary that fails this many times in a row marks the meeting failed instead of retrying every minute. */
export const MAX_SUMMARY_ATTEMPTS = 5

/** One line per turn: back-to-back segments from the same voice are joined, which reads better and costs fewer tokens. */
export function transcriptText(segments: CloudSegment[]): string {
  const turns: Array<{ who: string; text: string }> = []
  for (const segment of segments) {
    const who = segment.track === 'me' ? 'You' : segment.speaker || 'Speaker 1'
    const last = turns.at(-1)
    if (last && last.who === who) last.text += ` ${segment.text}`
    else turns.push({ who, text: segment.text })
  }
  return turns.map((turn) => `${turn.who}: ${turn.text}`).join('\n')
}

const minutesOf = (segments: CloudSegment[]) => segments.length ? Math.max(...segments.map((segment) => segment.endMs)) / 60_000 : undefined

const message = (error: unknown) => error instanceof Error ? error.message : 'error'

/**
 * Moves one meeting forward by a step. Only one caller works on a meeting at a time (lease), so the Event Grid
 * trigger for each track and the timer can all call this without starting duplicate Speech jobs.
 */
async function advance(candidate: MeetingRow, log: Log): Promise<void> {
  if (candidate.status === 'ready' || candidate.status === 'failed') return
  const row = await claimLease(candidate.id, candidate.user_oid, LEASE_SECONDS)
  if (!row) return
  try { await step(row, log) } finally {
    await releaseLease(row.id, row.user_oid).catch((error) => log(`meeting ${row.id} lease release failed: ${message(error)}`))
  }
}

async function step(row: MeetingRow, log: Log): Promise<void> {
  const tracks = tracksOf(row.tracks)
  if (!tracks.length) { await markFailed(row.id, row.user_oid, 'Meeting has no audio tracks'); return }

  // 1. Start Speech only once every track has finished uploading. The row exists before the upload starts, and
  //    the tracks upload one after another, so a missing blob just means "not yet".
  if (tracks.some((track) => !track.speechUrl)) {
    for (const track of tracks) {
      if (!await blobExists(track.blobName)) { log(`meeting ${row.id} waiting for ${track.track} upload`); return }
    }
    for (const track of tracks) {
      if (track.speechUrl) continue
      const sas = await readSas(track.blobName)
      const job = await startBatchTranscription({ contentUrl: sas.url, displayName: row.id })
      track.speechUrl = job.self
      track.speechStatus = 'running'
      // Saved after each job so a failure on the next track never loses (and later duplicates) this one.
      await saveTracks(row.id, row.user_oid, tracks, 'transcribing')
      log(`meeting ${row.id} started speech for ${track.track}`)
    }
    return
  }

  // 2. Wait for every Speech job.
  let changed = false
  for (const track of tracks) {
    if (track.speechStatus === 'succeeded') continue
    let status: Awaited<ReturnType<typeof transcriptionStatus>>
    try { status = await transcriptionStatus(track.speechUrl!) } catch (error) {
      log(`meeting ${row.id} speech poll will retry: ${message(error)}`)
      return
    }
    if (status === 'running') { if (changed) await saveTracks(row.id, row.user_oid, tracks, 'transcribing'); return }
    if (status === 'failed') {
      track.speechStatus = 'failed'
      await saveTracks(row.id, row.user_oid, tracks, 'transcribing')
      await markFailed(row.id, row.user_oid, `Speech transcription failed for ${track.track}`)
      log(`meeting ${row.id} speech failed for ${track.track}`)
      return
    }
    track.speechStatus = 'succeeded'
    changed = true
  }
  if (changed || row.status !== 'summarizing') await saveTracks(row.id, row.user_oid, tracks, 'summarizing')

  // 3. Summarize, with a cap so a model that keeps failing does not get called every minute forever.
  try {
    const segments: CloudSegment[] = []
    for (const track of tracks) segments.push(...await transcriptionSegments(track.speechUrl!, track.track))
    segments.sort((a, b) => a.startMs - b.startMs || a.track.localeCompare(b.track))
    const provider = createSummaryProvider()
    const summary = await provider.summarize({ title: row.title || 'Meeting', transcript: transcriptText(segments), attendees: [], minutes: minutesOf(segments) })
    await storeResult(row, segments, { ...summary, model: provider.id }, null)
    log(`meeting ${row.id} ready segments=${segments.length} model=${provider.id}`)
  } catch (error) {
    const attempts = await bumpAttempts(row.id, row.user_oid, `Summary attempt failed: ${message(error)}`)
    if (attempts >= MAX_SUMMARY_ATTEMPTS) {
      await markFailed(row.id, row.user_oid, `Summary failed after ${attempts} attempts: ${message(error)}`)
      log(`meeting ${row.id} summary gave up after ${attempts} attempts`)
    } else {
      log(`meeting ${row.id} summary attempt ${attempts} failed, will retry: ${message(error)}`)
    }
  }
}

export async function onBlob(blobName: string, log: Log): Promise<void> {
  const row = await findByBlob(blobName)
  if (!row) { log(`blob ${blobName} has no meeting`); return }
  await advance(row, log)
}

export async function pollActive(log: Log): Promise<void> {
  for (const row of await activeMeetings()) {
    try { await advance(row, log) } catch (error) {
      log(`meeting ${row.id} poll failed: ${message(error)}`)
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
    minutes: minutesOf(saved.segments),
    notes: input.notes,
    attendees: input.attendees,
    instruction: input.instruction,
    language: input.language,
  })
  await storeResult(row, saved.segments, { ...summary, model: provider.id }, row.language)
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { SummaryInput, SummaryOutput } from '../../engine/summaryProvider'
import { createCloudTranscriptionProvider } from '../asr/cloud'
import type { CloudTrack } from '../asr/provider'
import { createCloudSummaryProvider } from '../notes/cloudSummary'
import type { Segment, Store } from '../store'
import type { Settings } from '../settings'
import { createCloudApi, type CloudMeeting } from './api'
import { createCloudAuth, type CloudAccount, type MsalClient } from './auth'
import { cloudConfigured, cloudForce, readCloudConfig, type CloudConfig } from './config'
import { createMsalClient, createPkce, listenForAuthCode } from './entra'
import { KeychainUnavailableError, type TokenSeal } from './tokens'
import { audioContentType, fileSource, uploadBlockBlob } from './upload'

export type CloudRuntimeDeps = {
  settings: () => Settings
  env?: NodeJS.ProcessEnv
  cacheFile: string
  jobsFile: string
  seal: TokenSeal
  meetingDir: (id: string) => string
  exts: readonly string[]
  store: Pick<Store, 'meeting' | 'segments' | 'addSegments' | 'updateMeeting' | 'notes'>
  sendSegments: (id: string) => void
  openBrowser?: (url: string) => Promise<void>
  client?: MsalClient
  fetch?: typeof fetch
}

type JobRecord = { localId: string; cloudId?: string; summaryKey?: string }

export function createCloudRuntime(deps: CloudRuntimeDeps) {
  const env = deps.env ?? process.env
  const config = (): CloudConfig => readCloudConfig(deps.settings(), env)
  let client = deps.client
  const msal = (): MsalClient => {
    if (!client) {
      const current = config()
      client = createMsalClient({ clientId: current.clientId, tenantId: current.tenantId })
    }
    return client
  }
  const auth = createCloudAuth({
    config,
    client: {
      getAuthCodeUrl: (req) => msal().getAuthCodeUrl(req),
      acquireTokenByCode: (req) => msal().acquireTokenByCode(req),
      acquireTokenSilent: (req) => msal().acquireTokenSilent(req),
      deserialize: (cache) => msal().deserialize(cache),
      serialize: () => msal().serialize(),
      getAccount: () => msal().getAccount(),
      clear: () => msal().clear(),
    },
    seal: deps.seal,
    read: () => existsSync(deps.cacheFile) ? readFileSync(deps.cacheFile) : null,
    write: (buf) => {
      if (!buf) { rmSync(deps.cacheFile, { force: true }); return }
      mkdirSync(dirname(deps.cacheFile), { recursive: true })
      writeFileSync(deps.cacheFile, buf)
    },
    openBrowser: deps.openBrowser ?? (async () => { throw new Error('browser') }),
    listenForCode: () => listenForAuthCode(),
    pkce: createPkce,
  })
  const jobs = new Map<string, JobRecord>()
  const results = new Map<string, CloudMeeting>()
  const inflight = new Map<string, Promise<CloudMeeting>>()
  let jobsLoaded = false

  const loadJobs = () => {
    if (jobsLoaded) return
    jobsLoaded = true
    if (!existsSync(deps.jobsFile)) return
    try {
      const parsed = JSON.parse(readFileSync(deps.jobsFile, 'utf8')) as JobRecord[]
      for (const job of parsed) if (job?.localId) jobs.set(job.localId, job)
    } catch { /* the next recording uploads again */ }
  }
  const saveJobs = () => {
    mkdirSync(dirname(deps.jobsFile), { recursive: true })
    writeFileSync(deps.jobsFile, JSON.stringify([...jobs.values()]))
  }
  const remember = (id: string, patch: Partial<JobRecord>) => {
    jobs.set(id, { localId: id, ...jobs.get(id), ...patch })
    saveJobs()
  }

  const apiFor = async () => {
    const current = config()
    if (!cloudConfigured(current)) {
      const error = new Error('not-configured') as Error & { code: string }
      error.code = 'not-configured'
      throw error
    }
    return createCloudApi({ apiUrl: current.apiUrl, token: () => auth.getAccessToken(), fetch: deps.fetch })
  }

  const filesFor = async (id: string) => {
    const dir = deps.meetingDir(id)
    const found = []
    for (const track of ['me', 'them'] as const) {
      const path = deps.exts.map((ext) => join(dir, `${track}.${ext}`)).find((candidate) => existsSync(candidate))
      if (!path) continue
      const bytes = (await stat(path)).size
      if (bytes <= 0) continue
      found.push({ track: track satisfies CloudTrack, path, contentType: audioContentType(path), bytes })
    }
    return found
  }

  const apply = (id: string, meeting: CloudMeeting) => {
    results.set(id, meeting)
    if (!deps.store.segments(id).length && meeting.segments.length) {
      const rows: Omit<Segment, 'id'>[] = meeting.segments.map((segment) => ({
        meetingId: id, track: segment.track, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, speaker: segment.speaker,
      }))
      deps.store.addSegments(rows)
      deps.sendSegments(id)
    }
    deps.store.updateMeeting(id, { transcriptionPending: false, ...(meeting.language ? { language: meeting.language } : {}) })
  }

  const prepare = (id: string, signal?: AbortSignal): Promise<CloudMeeting> => {
    const existing = inflight.get(id)
    if (existing) return existing
    const run = (async () => {
      loadJobs()
      const cached = results.get(id)
      if (cached?.status === 'ready') return cached
      const files = await filesFor(id)
      if (!files.length) throw new Error('This meeting has no audio to upload')
      const provider = createCloudTranscriptionProvider({
        api: await apiFor(),
        upload: async (target, file, uploadSignal) => {
          await uploadBlockBlob({ sasUrl: target.sasUrl, source: await fileSource(file.path), contentType: file.contentType, signal: uploadSignal, fetch: deps.fetch })
        },
        jobs: { get: (localId) => jobs.get(localId)?.cloudId, set: (localId, cloudId) => remember(localId, { cloudId }) },
      })
      const result = await provider.transcribe({ localId: id, title: deps.store.meeting(id)?.title ?? '', files }, signal)
      const meeting: CloudMeeting = {
        meetingId: result.meetingId, status: 'ready', language: result.language, segments: result.segments, summary: result.summary, error: null,
      }
      apply(id, meeting)
      return meeting
    })().finally(() => { if (inflight.get(id) === run) inflight.delete(id) })
    inflight.set(id, run)
    return run
  }

  return {
    enabled: () => config().enabled,
    configured: () => cloudConfigured(config()),
    forced: () => cloudForce(env),
    account: (): Promise<CloudAccount | null> => auth.account().catch(() => null),
    async signIn() {
      if (!deps.seal.available()) throw new KeychainUnavailableError()
      return auth.signIn()
    },
    signOut: () => auth.signOut(),
    async prepare(id: string, signal?: AbortSignal) { await prepare(id, signal) },
    async summarize(id: string, input: { title: string; instruction?: string; language?: string }, signal?: AbortSignal): Promise<SummaryOutput> {
      const meeting = await prepare(id, signal)
      const attendees = deps.store.meeting(id)?.attendees.map((person) => person.name).filter(Boolean) ?? []
      const notes = (deps.store.notes(id).mine || '').trim()
      const transcript = deps.store.segments(id).map((segment) => `${segment.track === 'me' ? 'You' : segment.speaker || 'Them'}: ${segment.text}`).join('\n')
      const request: SummaryInput = { title: input.title, transcript, instruction: input.instruction, language: input.language, attendees, notes: notes || undefined }
      const summaryKey = JSON.stringify({ notes: request.notes ?? '', instruction: request.instruction ?? '', attendees })
      const provider = createCloudSummaryProvider({
        id: meeting.summary?.model,
        summarize: async (body, requestSignal) => {
          const savedKey = jobs.get(id)?.summaryKey
          if (meeting.summary && savedKey === summaryKey) return meeting.summary
          if (meeting.summary && !body.instruction && !body.notes && !savedKey) {
            remember(id, { cloudId: meeting.meetingId, summaryKey })
            return meeting.summary
          }
          const updated = await (await apiFor()).summarize(meeting.meetingId, body, requestSignal)
          if (!updated.summary) throw new Error('Cloud summary was empty')
          results.set(id, updated)
          remember(id, { cloudId: meeting.meetingId, summaryKey })
          return updated.summary
        },
      })
      return provider.summarize(request, signal)
    },
  }
}

export type CloudRuntime = ReturnType<typeof createCloudRuntime>

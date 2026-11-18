import { describe, expect, it } from 'vitest'
import { isSummaryModel, requireSummaryModel, SUMMARY_MODELS, titleFromSummary } from '../src/engine/summaryProvider'
import { createCloudTranscriptionProvider } from '../src/main/asr/cloud'
import { createCloudApi, parseMeeting, pollUntilReady } from '../src/main/cloud/api'
import { createCloudSummaryProvider } from '../src/main/notes/cloudSummary'

const summary = { markdown: '## Pricing\n- Hold the price\n## Next steps\n- **You:** Send the note', model: 'azure-openai-gpt-5-mini', actionItems: [{ owner: 'You', text: 'Send the note', due: null }] }

describe('cloud providers', () => {
  it('names the models the API can swap in, and a topic from the summary', () => {
    expect(SUMMARY_MODELS).toEqual(['azure-openai-gpt-5-mini', 'claude', 'openai'])
    expect(isSummaryModel('claude')).toBe(true)
    expect(() => requireSummaryModel('gpt-local')).toThrow(/Unknown summary model/)
    expect(titleFromSummary(summary.markdown)).toBe('Pricing')
    expect(titleFromSummary('## Next steps\n- **You:** Send it')).toBe('')
  })

  it('calls only our API with the Entra access token', async () => {
    const seen: Array<{ url: string; authorization: string | null; apiKey: string | null }> = []
    const api = createCloudApi({
      apiUrl: 'https://func.example/api',
      token: async () => 'entra-access',
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        seen.push({ url: String(url), authorization: headers.get('authorization'), apiKey: headers.get('api-key') ?? headers.get('ocp-apim-subscription-key') })
        return new Response(JSON.stringify({ meetingId: 'm1', status: 'ready', language: 'en-US', segments: [{ track: 'them', speaker: 'Speaker 1', startMs: 0, endMs: 1000, text: 'Hello' }], summary }), { status: 200 })
      },
    })
    const meeting = await api.getMeeting('m1')
    expect(meeting.summary?.model).toBe('azure-openai-gpt-5-mini')
    expect(seen).toEqual([{ url: 'https://func.example/api/meetings/m1', authorization: 'Bearer entra-access', apiKey: null }])
    expect(() => parseMeeting({ meetingId: 'm', status: 'ready', summary: { markdown: 'x', model: 'mystery' } })).toThrow(/Unknown summary model/)
  })

  it('uploads each track and returns the transcript the API stored', async () => {
    const uploaded: string[] = []
    let polls = 0
    const api = createCloudApi({
      apiUrl: 'https://func.example/api',
      token: async () => 'entra-access',
      fetch: async (url, init) => {
        const href = String(url)
        if (init?.method === 'POST' && href.endsWith('/meetings')) {
          return new Response(JSON.stringify({ meetingId: 'meeting-1', uploads: [
            { track: 'me', blobName: 'oid/meeting-1/me.ogg', sasUrl: 'https://blob/me?sig=1', expiresAt: '' },
            { track: 'them', blobName: 'oid/meeting-1/them.ogg', sasUrl: 'https://blob/them?sig=1', expiresAt: '' },
          ] }), { status: 201 })
        }
        polls++
        const status = polls < 2 ? 'transcribing' : 'ready'
        return new Response(JSON.stringify({ meetingId: 'meeting-1', status, language: 'en-US', segments: status === 'ready' ? [{ track: 'me', startMs: 0, endMs: 500, text: 'Thanks' }] : [], summary: status === 'ready' ? summary : null }), { status: 200 })
      },
    })
    const provider = createCloudTranscriptionProvider({
      api,
      upload: async (target) => { uploaded.push(target.blobName) },
    })
    const result = await pollUntilReady(() => Promise.resolve({ meetingId: 'x', status: 'ready' as const, language: null, segments: [], summary: null, error: null }), { sleep: async () => {}, now: () => 0 })
    expect(result.status).toBe('ready')
    const transcript = await provider.transcribe({ localId: 'local', title: 'Weekly', files: [
      { track: 'me', path: 'me.ogg', contentType: 'audio/ogg', bytes: 10 },
      { track: 'them', path: 'them.ogg', contentType: 'audio/ogg', bytes: 12 },
    ] })
    expect(uploaded).toEqual(['oid/meeting-1/me.ogg', 'oid/meeting-1/them.ogg'])
    expect(transcript.segments.map((segment) => segment.text)).toEqual(['Thanks'])
    expect(transcript.summary?.model).toBe('azure-openai-gpt-5-mini')
  })

  it('records a later model when the API swaps off GPT-5 mini', async () => {
    const provider = createCloudSummaryProvider({
      summarize: async () => ({ markdown: '## Plan\n- Go', actionItems: [], model: 'claude' }),
    })
    expect(provider.id).toBe('azure-openai-gpt-5-mini')
    const output = await provider.summarize({ title: 'Weekly', transcript: 'You: Go' })
    expect(output.model).toBe('claude')
    expect(provider.id).toBe('claude')
  })
})

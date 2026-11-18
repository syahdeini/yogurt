import { describe, expect, it } from 'vitest'
import { assertPilotClaims, HttpError } from '../src/claims'
import { blobNameFromSubject, segmentsFromSpeech, trackFromBlob } from '../src/speech/parse'
import { parseSummaryJson } from '../src/summary/parse'
import { selectSummaryProvider, type SummaryProvider } from '../src/summary/provider'

const tenant = '6a94fd93-b4dc-42db-9712-8defab2a3e93'
const audience = 'api://api-app'
const good = { tid: tenant, ver: '2.0', aud: audience, scp: 'access_as_user', azp: 'desktop', oid: 'user-1' }

describe('entra claims', () => {
  it('accepts a delegated token for this tenant and API', () => {
    expect(assertPilotClaims(good, { tenantId: tenant, audiences: [audience, 'api-app'], scope: 'access_as_user', clientId: 'desktop' }).oid).toBe('user-1')
  })
  it('rejects another tenant, audience, client or a missing scope', () => {
    const check = { tenantId: tenant, audiences: [audience], scope: 'access_as_user' }
    expect(() => assertPilotClaims({ ...good, tid: 'other' }, check)).toThrow(HttpError)
    expect(() => assertPilotClaims({ ...good, aud: 'https://graph.microsoft.com' }, check)).toThrow(HttpError)
    expect(() => assertPilotClaims({ ...good, scp: 'User.Read' }, check)).toThrow(HttpError)
    expect(() => assertPilotClaims({ ...good, azp: 'other-app' }, { ...check, clientId: 'desktop' })).toThrow(HttpError)
  })
})

describe('speech', () => {
  it('keeps diarized speakers on the far side and folds a single mic speaker into You', () => {
    const them = segmentsFromSpeech('them', [
      { speaker: 1, offsetInTicks: 10_000_000, durationInTicks: 5_000_000, nBest: [{ display: 'Hello' }] },
      { speaker: 2, offsetInTicks: 20_000_000, durationInTicks: 5_000_000, nBest: [{ display: 'Hi' }] },
    ])
    expect(them.map((segment) => segment.speaker)).toEqual(['Speaker 1', 'Speaker 2'])
    expect(them[0].startMs).toBe(1000)
    const me = segmentsFromSpeech('me', [{ speaker: 1, offsetInTicks: 0, durationInTicks: 10_000_000, nBest: [{ display: 'Thanks' }] }])
    expect(me[0].speaker).toBeNull()
    expect(blobNameFromSubject('/blobServices/default/containers/audio/blobs/oid/meeting/them.ogg')).toBe('oid/meeting/them.ogg')
    expect(trackFromBlob('oid/meeting/me.m4a')).toBe('me')
  })
})

describe('summary provider', () => {
  it('parses notes and tasks, and refuses a provider that is not configured', () => {
    const parsed = parseSummaryJson('```json\n{"markdown":"## Plan\\n- Ship","actionItems":[{"owner":"You","text":"Ship","due":null}]}\n```')
    expect(parsed.markdown.includes('## Plan')).toBe(true)
    expect(parsed.actionItems[0].owner).toBe('You')
    const azure: SummaryProvider = { id: 'azure-openai-gpt-5-mini', async summarize() { return parsed } }
    expect(selectSummaryProvider(undefined, { 'azure-openai-gpt-5-mini': azure }).id).toBe('azure-openai-gpt-5-mini')
    expect(() => selectSummaryProvider('claude', { 'azure-openai-gpt-5-mini': azure })).toThrow(/not configured/)
    expect(() => selectSummaryProvider('openai', {})).toThrow(/not configured/)
  })
})


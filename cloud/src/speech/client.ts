import { DefaultAzureCredential } from '@azure/identity'
import { segmentsFromSpeech, type CloudSegment, type SpeechPhrase } from './parse.js'
import { requiredEnv } from '../claims.js'

export type SpeechJob = { self: string }

type Transcription = { status?: string; links?: { files?: string }; properties?: { error?: { message?: string } } }

export async function speechToken(): Promise<string> {
  const credential = new DefaultAzureCredential()
  const token = await credential.getToken('https://cognitiveservices.azure.com/.default')
  if (!token) throw new Error('Speech managed identity returned no token')
  return token.token
}

async function speechFetch(url: string, init?: RequestInit, signed = true): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (signed) headers.set('authorization', `Bearer ${await speechToken()}`)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const error = new Error(`Speech ${response.status} ${detail}`.slice(0, 500)) as Error & { status: number }
    error.status = response.status
    throw error
  }
  return response
}

export async function startBatchTranscription(o: { contentUrl: string; locale?: string; displayName: string }): Promise<SpeechJob> {
  const endpoint = requiredEnv('SPEECH_ENDPOINT').replace(/\/$/, '')
  const locale = o.locale || 'en-US'
  const base = {
    contentUrls: [o.contentUrl],
    locale,
    displayName: o.displayName.slice(0, 80),
    properties: {
      diarizationEnabled: true,
      diarization: { speakers: { minCount: 1, maxCount: 8 } },
      punctuationMode: 'DictatedAndAutomatic',
      timeToLiveHours: 24,
    },
  }
  const withLanguage = {
    ...base,
    properties: {
      ...base.properties,
      languageIdentification: { candidateLocales: ['en-US', 'en-GB', 'da-DK', 'de-DE', 'es-ES', 'fr-FR', 'id-ID', 'nl-NL', 'pt-BR', 'sv-SE'] },
    },
  }
  let response: Response
  try {
    response = await speechFetch(`${endpoint}/speechtotext/v3.2/transcriptions`, { method: 'POST', body: JSON.stringify(withLanguage) })
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status !== 400) throw error
    response = await speechFetch(`${endpoint}/speechtotext/v3.2/transcriptions`, { method: 'POST', body: JSON.stringify(base) })
  }
  const body = await response.json() as { self?: string }
  if (!body.self) throw new Error('Speech did not return a transcription')
  return { self: body.self }
}

export async function transcriptionStatus(self: string): Promise<'running' | 'succeeded' | 'failed'> {
  const body = await (await speechFetch(self)).json() as Transcription
  if (body.status === 'Succeeded') return 'succeeded'
  if (body.status === 'Failed') return 'failed'
  return 'running'
}

export async function transcriptionSegments(self: string, track: 'me' | 'them'): Promise<CloudSegment[]> {
  const body = await (await speechFetch(self)).json() as Transcription
  if (!body.links?.files) return []
  const files = await (await speechFetch(body.links.files)).json() as { values?: Array<{ kind?: string; links?: { contentUrl?: string } }> }
  const content = files.values?.find((file) => file.kind === 'Transcription')?.links?.contentUrl
  if (!content) return []
  // contentUrl is a SAS link to Speech's own storage: a bearer token there fails with 401 "Issuer did not match".
  const transcript = await (await speechFetch(content, undefined, false)).json() as { recognizedPhrases?: SpeechPhrase[] }
  return segmentsFromSpeech(track, transcript.recognizedPhrases ?? [])
}

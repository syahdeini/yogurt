import type { SummaryOutput } from '../../engine/summaryProvider'

/** local-whisper is the on-device pipeline in this folder. azure-speech uploads audio and waits for the API. */
export type TranscriptionProviderId = 'local-whisper' | 'azure-speech'

export type CloudTrack = 'me' | 'them'

export type TranscriptionSegment = {
  track: CloudTrack
  speaker: string | null
  startMs: number
  endMs: number
  text: string
}

export type TranscriptionRequest = {
  localId: string
  title: string
  files: Array<{ track: CloudTrack; path: string; contentType: string; bytes: number }>
}

export type TranscriptionResult = {
  meetingId: string
  language: string | null
  segments: TranscriptionSegment[]
  summary: SummaryOutput | null
}

export interface TranscriptionProvider {
  readonly id: TranscriptionProviderId
  transcribe(input: TranscriptionRequest, signal?: AbortSignal): Promise<TranscriptionResult>
}

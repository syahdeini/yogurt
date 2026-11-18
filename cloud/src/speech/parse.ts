export type SpeechPhrase = {
  speaker?: number
  offsetInTicks?: number
  durationInTicks?: number
  nBest?: Array<{ display?: string; lexical?: string }>
}

export type CloudSegment = {
  track: 'me' | 'them'
  speaker: string | null
  startMs: number
  endMs: number
  text: string
}

const ticksToMs = (ticks: number | undefined) => Math.round((ticks ?? 0) / 10_000)

/** One track of a batch transcription. Several speakers on the far side keep their diarization numbers. */
export function segmentsFromSpeech(track: 'me' | 'them', phrases: SpeechPhrase[]): CloudSegment[] {
  const speakers = new Set(phrases.map((phrase) => phrase.speaker).filter((speaker) => speaker != null))
  const many = speakers.size > 1
  return phrases.flatMap((phrase) => {
    const text = (phrase.nBest?.[0]?.display || phrase.nBest?.[0]?.lexical || '').trim()
    if (!text) return []
    const startMs = ticksToMs(phrase.offsetInTicks)
    const endMs = Math.max(startMs + 1, startMs + ticksToMs(phrase.durationInTicks))
    const speaker = phrase.speaker
    const named = speaker != null && (track === 'them' ? many : many) ? `Speaker ${speaker}` : null
    return [{ track, speaker: track === 'me' && !many ? null : named, startMs, endMs, text }]
  })
}

export function blobNameFromSubject(subject: string): string | null {
  const marker = '/blobs/'
  const at = subject.indexOf(marker)
  if (at < 0) return null
  const name = decodeURIComponent(subject.slice(at + marker.length))
  return name || null
}

export function trackFromBlob(blobName: string): 'me' | 'them' | null {
  const file = blobName.split('/').pop() ?? ''
  if (file.startsWith('me.')) return 'me'
  if (file.startsWith('them.')) return 'them'
  return null
}

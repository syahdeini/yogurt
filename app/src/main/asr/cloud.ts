import type { CloudApi, UploadTarget } from '../cloud/api'
import { pollUntilReady } from '../cloud/api'
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResult } from './provider'

/**
 * Azure AI Speech, through our API. The app uploads the recording with a user-delegation SAS and
 * polls until the transcript (and the first summary) are stored. No speech key is on the machine.
 */
export function createCloudTranscriptionProvider(deps: {
  api: CloudApi
  upload: (target: UploadTarget, file: TranscriptionRequest['files'][number], signal?: AbortSignal) => Promise<void>
  jobs?: { get(localId: string): string | undefined; set(localId: string, cloudId: string): void }
}): TranscriptionProvider {
  return {
    id: 'azure-speech',
    async transcribe(input, signal) {
      let meetingId = deps.jobs?.get(input.localId)
      let created = meetingId
        ? await deps.api.refreshSas(meetingId, signal)
        : await deps.api.createMeeting({
          localId: input.localId,
          title: input.title,
          tracks: input.files.map(({ track, contentType, bytes }) => ({ track, contentType, bytes })),
        }, signal)
      meetingId = created.meetingId
      deps.jobs?.set(input.localId, meetingId)
      // After a restart the server may already have the audio and be transcribing; uploading again would
      // overwrite blobs Speech is reading.
      const needsUpload = created.status === 'uploaded'
      for (const file of needsUpload ? input.files : []) {
        const target = created.uploads.find((upload) => upload.track === file.track)
        if (!target) throw new Error(`Cloud API did not offer an upload for ${file.track}`)
        await deps.upload(target, file, signal)
      }
      const ready = await pollUntilReady(() => deps.api.getMeeting(meetingId!, signal), { signal })
      return toResult(ready)
    },
  }
}

function toResult(meeting: { meetingId: string; language: string | null; segments: TranscriptionResult['segments']; summary: TranscriptionResult['summary'] }): TranscriptionResult {
  return { meetingId: meeting.meetingId, language: meeting.language, segments: meeting.segments, summary: meeting.summary }
}

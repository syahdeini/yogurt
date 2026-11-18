import { app, type InvocationContext } from '@azure/functions'
import { blobNameFromSubject } from './speech/parse.js'
import { createMeeting, getMeeting, health, refreshSas, summarize } from './http.js'
import { onBlob, pollActive } from './work.js'

app.http('health', { methods: ['GET'], authLevel: 'anonymous', route: 'health', handler: health })
app.http('createMeeting', { methods: ['POST'], authLevel: 'anonymous', route: 'meetings', handler: createMeeting })
app.http('getMeeting', { methods: ['GET'], authLevel: 'anonymous', route: 'meetings/{id}', handler: getMeeting })
app.http('refreshSas', { methods: ['POST'], authLevel: 'anonymous', route: 'meetings/{id}/sas', handler: refreshSas })
app.http('summarize', { methods: ['POST'], authLevel: 'anonymous', route: 'meetings/{id}/summarize', handler: summarize })

app.eventGrid('onAudioBlob', {
  handler: async (event, context: InvocationContext) => {
    const events = Array.isArray(event) ? event : [event]
    for (const item of events) {
      const record = item as { eventType?: string; subject?: string }
      if (record.eventType && record.eventType !== 'Microsoft.Storage.BlobCreated') continue
      const name = blobNameFromSubject(record.subject ?? '')
      if (!name) continue
      context.log(`blob created ${name}`)
      await onBlob(name, (message) => context.log(message))
    }
  },
})

app.timer('pollMeetings', {
  schedule: '0 */1 * * * *',
  handler: async (_timer, context: InvocationContext) => {
    await pollActive((message) => context.log(message))
  },
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookNotes } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'
import { openStore, type Store } from '../src/main/store'
import type { Llm } from '../src/main/notes/enhance'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe('cloud notes', () => {
  it('shows the API summary in the meeting without loading the on-device model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-cloud-notes-'))
    dirs.push(dir)
    const store = openStore(join(dir, 'yogurt.db'))
    stores.push(store)
    const meeting = store.createMeeting({ title: 'Meeting', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'stopped', titleSource: 'generic' })
    const llm: Llm = { contextSize: 100, count: async () => { throw new Error('local model') }, chat: async () => { throw new Error('local model') } }
    const queue = createQueue({ recording: () => false, smallMac: false, modelReady: () => false, readyWithoutModel: (kind) => kind === 'enhance' })
    let prepared = false
    const notes = hookNotes({
      store, queue, model: { llm: async () => llm }, language: () => null, onStop: () => {}, send: () => {}, changed: () => {},
      transcribed: async () => {},
      cloud: {
        enabled: () => true,
        prepare: async (id) => {
          prepared = true
          store.addSegments([{ meetingId: id, track: 'them', startMs: 0, endMs: 1000, text: 'Ship Tuesday.', speaker: null }])
        },
        summarize: async () => ({ markdown: '## Launch\n- Ship Tuesday\n## Next steps\n- **You:** Send the note' }),
      },
    })
    await notes.writeAgain(meeting.id)
    expect(prepared).toBe(true)
    expect(store.notes(meeting.id).enhanced).toContain('Ship Tuesday')
    expect(store.meeting(meeting.id)).toMatchObject({ state: 'done', title: 'Launch', titleSource: 'auto' })
    expect(store.segments(meeting.id).map((segment) => segment.text)).toEqual(['Ship Tuesday.'])
  })
})

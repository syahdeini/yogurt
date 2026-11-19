import { describe, expect, it } from 'vitest'
import { forOs } from '../src/shared/platform'
// @ts-expect-error plain JS script
import { i18nKeys } from '../scripts/i18n-keys.mjs'

const keys: string[] = i18nKeys()

describe('words for each computer', () => {
  const both = { mac: 'on your Mac', other: 'on your computer' }
  const each = { mac: 'in the menu bar', windows: 'in the notification area', linux: 'in the tray' }
  it('a Mac keeps its own words', () => {
    expect(forOs(both, 'darwin')).toBe('on your Mac')
    expect(forOs(each, 'darwin')).toBe('in the menu bar')
  })
  it('Windows and Linux share one sentence, or each get their own', () => {
    expect(forOs(both, 'win32')).toBe('on your computer')
    expect(forOs(both, 'linux')).toBe('on your computer')
    expect(forOs(each, 'win32')).toBe('in the notification area')
    expect(forOs(each, 'linux')).toBe('in the tray')
  })
})

describe('Mac text', () => {
  // every key that names the Mac, exactly as it was before Windows and Linux: each is shown only on a Mac,
  // or beside its own Windows and Linux sentence. A new one belongs here only if it is Mac only too.
  const MAC = [
    'Apps on this Mac can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.',
    'Connect the calendars on this Mac to see your upcoming meetings.',
    'Everything stays on your Mac.',
    'Its notes, transcript and recording are removed from this Mac for good.',
    'Match my Mac',
    'No calendars found on this Mac.',
    'Open PBN Whisper when your Mac starts',
    "PBN Whisper hears you through your microphone, and everyone else through your Mac's sound.",
    'PBN Whisper needs a Mac with at least 8 GB of memory.',
    'Saved on this Mac',
    'This conversation is removed from this Mac for good. Your meetings stay as they are.',
    'Try reading the calendars on this Mac again.',
    'Uses the microphone your Mac is set to',
    "Your Mac's sound",
    '{count} meetings, with their notes, transcripts and recordings, are removed from this Mac for good.',
  ]
  it('uses Mac wording only for Mac-specific features', () => {
    expect(keys.filter((k) => /\bMac\b/.test(k))).toEqual(MAC)
  })
  it('keeps the ⌘, menu bar, Finder and System Settings words', () => {
    for (const k of ['Ask PBN Whisper (⌘J)', 'Menu bar and Dock', 'Menu bar only', 'Dock only', 'Show in Finder', 'Open System Settings', 'Turn it on in System Settings'])
      expect(keys).toContain(k)
  })
  it('has a Windows and Linux sentence beside each one shown there', () => {
    for (const k of [
      'Everything stays on your computer.', 'Saved on this computer',
      'PBN Whisper stores your meetings, notes and audio on this computer.', 'Apps on this computer can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.',
      'Match Windows', 'Match my system', 'Open PBN Whisper when Windows starts', 'Open PBN Whisper when you log in',
      'Show PBN Whisper in the notification area', 'Show PBN Whisper in the tray', 'Show in File Explorer', 'Show in Files',
    ]) expect(keys).toContain(k)
  })
})

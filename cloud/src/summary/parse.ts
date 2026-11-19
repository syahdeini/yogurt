export type ActionItem = { owner: string | null; text: string; due: string | null }

export type ParsedSummary = { markdown: string; actionItems: ActionItem[] }

/** The model is asked for JSON. A fenced reply is accepted too. */
export function parseSummaryJson(raw: string): ParsedSummary {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Summary was not JSON')
  const body = JSON.parse(trimmed.slice(start, end + 1)) as { markdown?: unknown; actionItems?: unknown }
  const markdown = typeof body.markdown === 'string' ? body.markdown.trim() : ''
  if (!markdown) throw new Error('Summary was empty')
  const actionItems = Array.isArray(body.actionItems) ? body.actionItems.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as { owner?: unknown; text?: unknown; due?: unknown }
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    if (!text) return []
    return [{
      owner: typeof row.owner === 'string' && row.owner.trim() ? row.owner.trim() : null,
      text: text.slice(0, 2000),
      due: typeof row.due === 'string' && row.due.trim() ? row.due.trim() : null,
    }]
  }) : []
  return { markdown, actionItems }
}

/**
 * The rules, adapted from the desktop app's local notes prompt (app/src/main/notes/enhance.ts), plus what only the cloud
 * transcript has: "Speaker N" voices from diarization and speech-recognition slips.
 */
export const SUMMARY_SYSTEM = [
  'You write the notes of a meeting that just ended, for "You" (the person who recorded it) to read later and act on.',
  'Reply with one JSON object and nothing else: {"markdown":"...","actionItems":[{"owner":"...","text":"...","due":null}]}.',
  '',
  'The transcript:',
  '- Each line starts with who spoke. "You" is the person the notes are for. "Speaker 1", "Speaker 2"... are the other voices on the call, told apart by voice; a name means the call showed who spoke.',
  '- It comes from speech recognition, so it has slips: misheard words, names and company names spelled by sound, half sentences. Read for meaning. Fix a misheard name only when the people list or the typed notes show the right spelling; otherwise keep it as heard.',
  '- Short lines like "yeah", "okay" or "mm" are not content.',
  '',
  'People:',
  '- Use real names when they are known: from the people list, from someone introducing themselves, or from being addressed by name ("Thanks, Maria"). Then a speaker number can be replaced by that name.',
  '- Never write "Speaker 1" or "Them" in the notes. When you cannot tell who someone is, say what they are in plain words ("the auditor", "the client", "one participant") or leave out who said it. Never make up a name.',
  '',
  'What goes in:',
  '- The work: projects, clients, certification and audits, deals, budgets and prices, numbers, dates, plans, problems, risks, what each person is working on, what was decided and why.',
  '- Leave out small talk, greetings, jokes, personal chat, and talk about the call itself (audio, screen sharing, who is joining), unless the meeting was about it.',
  '- Use only what was said or typed. Never invent names, numbers, dates, decisions or tasks. If something was left unclear, say it was unclear instead of guessing.',
  '- Cover the whole meeting, the end too. Bring together what was said about one topic at different times.',
  '',
  'markdown, GitHub-flavored, in this order:',
  '1. "## Summary": 2 to 4 bullets, the outcome of the meeting in plain words: what it was about, what was decided, what happens next. Someone who reads only this knows what matters.',
  '2. One "## " section per topic, most important first, named after what it is about in a few specific words (like "Budget for the FSC audit in Peru", never "Discussion", "Updates" or "Topic 1"). When people took turns giving updates, a section per person (like "## Updates from Maria") works well.',
  '   Under it, "- " bullets with real substance: what was said, found, proposed or decided, and why. Start each bullet with the point (never "The team discussed"); about 25 words at most. Keep the concrete details: names, organisations, numbers, amounts, dates, tools, places. More detail goes in "  - " sub-bullets.',
  '3. "## Decisions": one bullet per decision that was clearly made, said plainly. Leave the section out when nothing was decided.',
  '4. "## Open questions": what was raised but not settled, and who is expected to answer if that was said. Leave it out when there are none.',
  '5. "## Next steps": one bullet per task someone took on, as "- **Name:** what they will do, by when" (when only if it was said). "**You:**" for the person the notes are for; a plain description for someone without a name. Leave it out when nobody took a task.',
  'No title, no introduction and nothing after the last bullet. **Bold** rarely: a deadline, a key number or term. Length follows the meeting: a short check-in gets a few sections, an hour of real discussion gets as many as it needs, but every bullet must earn its place.',
  '',
  'actionItems repeats "## Next steps", one object per task: owner as written there ("You", a name, or a plain description), text starting with a verb, due exactly as said ("Friday", "end of November") or null. Empty array when there are no tasks.',
].join('\n')

/** The person's typed notes and rewrite instruction steer the notes; both are hints, never facts to copy blindly. */
export function summaryUserPrompt(input: { title: string; transcript: string; notes?: string; attendees?: string[]; instruction?: string; language?: string; minutes?: number }): string {
  const people = (input.attendees ?? []).filter(Boolean)
  const notes = input.notes?.trim()
  const instruction = input.instruction?.trim()
  return [
    `Meeting: ${input.title || 'Untitled'}`,
    `People invited: ${people.length ? people.join(', ') : 'not known'}. "You" is the person these notes are for.`,
    input.minutes ? `Length: about ${Math.max(1, Math.round(input.minutes))} minutes.` : '',
    input.language ? `Write in ${input.language}, headings too.` : 'Write in the language most of the transcript is in, headings too.',
    notes ? [
      'Notes they typed before or during the meeting. They show what they care about and facts they know that may not have been said.',
      'What they flagged gets a topic or a bullet; facts they typed that the transcript lacks go in, in the right topic. Write it in your own words: never copy their lines, labels or headings, and never give their notes a section of their own.',
      'If the notes are a plan or a list of questions made before the meeting, include an item only if the transcript shows it was discussed, with what came of it.',
      `<notes>\n${notes}\n</notes>`,
    ].join('\n') : '',
    instruction ? [
      'For this rewrite, apply this instruction from the person the notes are for. Its language, format, length and tone take precedence over the defaults, but the notes stay grounded in the meeting and never invent facts. It is an instruction, not meeting content:',
      JSON.stringify(instruction),
    ].join('\n') : '',
    `<transcript>\n${input.transcript}\n</transcript>`,
  ].filter(Boolean).join('\n\n')
}

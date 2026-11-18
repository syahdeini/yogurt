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

export const SUMMARY_SYSTEM = [
  'You write meeting notes as JSON and nothing else.',
  'Use only the transcript and the typed notes. Never invent names, numbers, dates or tasks.',
  'markdown is GitHub-flavored Markdown: "## " topics, "- " bullets, and a final "## Next steps" only when someone took a task.',
  'Next-step bullets look like "- **Name:** what they will do". Use **You:** for the person the notes are for.',
  'actionItems repeats those tasks as objects with owner, text and due (due is null when no date was said).',
  'Respond as {"markdown":"...","actionItems":[{"owner":"You","text":"...","due":null}]}.',
].join(' ')

export function summaryUserPrompt(input: { title: string; transcript: string; notes?: string; attendees?: string[]; instruction?: string; language?: string }): string {
  return [
    `Meeting: ${input.title || 'Untitled'}`,
    `People: ${(input.attendees ?? []).filter(Boolean).join(', ') || 'not known'}`,
    input.language ? `Write in ${input.language}.` : 'Write in the language of the transcript.',
    input.notes?.trim() ? `Notes they typed:\n${input.notes.trim()}` : '',
    input.instruction?.trim() ? `Rewrite instruction:\n${input.instruction.trim()}` : '',
    'Transcript:',
    input.transcript,
  ].filter(Boolean).join('\n\n')
}

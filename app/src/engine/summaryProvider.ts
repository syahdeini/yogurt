/**
 * Cloud summary models. The desktop app never calls a model vendor itself: it sends the Entra
 * access token to our API, and the API's createSummaryProvider (cloud/src/summary/provider.ts)
 * picks the model. azure-openai-gpt-5-mini is the pilot. claude and openai are the later swaps.
 * On-device notes stay in notes/enhance.ts and are not a cloud model.
 */
export const SUMMARY_MODELS = ['azure-openai-gpt-5-mini', 'claude', 'openai'] as const
export type SummaryModel = (typeof SUMMARY_MODELS)[number]

export type SummaryInput = {
  title: string
  transcript: string
  /** notes the person typed, hints rather than text to copy */
  notes?: string
  attendees?: string[]
  /** a one-off rewrite instruction from the note */
  instruction?: string
  language?: string
}

export type SummaryActionItem = { owner: string | null; text: string; due: string | null }

export type SummaryOutput = {
  markdown: string
  actionItems: SummaryActionItem[]
  model: SummaryModel
}

export interface SummaryProvider {
  /** the model that produced the latest summary; a cloud result can change it */
  readonly id: SummaryModel | 'local'
  summarize(input: SummaryInput, signal?: AbortSignal): Promise<SummaryOutput>
}

export function isSummaryModel(id: string): id is SummaryModel {
  return (SUMMARY_MODELS as readonly string[]).includes(id)
}

/** Reject a model id the app does not know how to record. The backend is what actually runs it. */
export function requireSummaryModel(id: string): SummaryModel {
  if (isSummaryModel(id)) return id
  throw new Error(`Unknown summary model: ${id}`)
}

/** A generic title can take the first real topic. "Next steps" is not a name for the meeting. */
export function titleFromSummary(markdown: string): string {
  const heading = markdown.match(/^##\s+(.+)$/m)?.[1]?.replace(/[*_`]/g, '').trim() ?? ''
  if (!heading || /^next steps$/i.test(heading)) return ''
  return heading.slice(0, 80)
}

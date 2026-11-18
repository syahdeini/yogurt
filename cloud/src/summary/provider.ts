import { parseSummaryJson, SUMMARY_SYSTEM, summaryUserPrompt, type ParsedSummary } from './parse.js'

export const SUMMARY_MODEL_IDS = ['azure-openai-gpt-5-mini', 'claude', 'openai'] as const
export type SummaryModelId = (typeof SUMMARY_MODEL_IDS)[number]

export type SummaryRequest = { title: string; transcript: string; notes?: string; attendees?: string[]; instruction?: string; language?: string }

export interface SummaryProvider {
  readonly id: SummaryModelId
  summarize(input: SummaryRequest): Promise<ParsedSummary>
}

export type ChatComplete = (system: string, user: string) => Promise<string>

/** azure-openai-gpt-5-mini is the pilot. claude and openai are the swap points. */
export function selectSummaryProvider(id: string | undefined, providers: Partial<Record<SummaryModelId, SummaryProvider>>): SummaryProvider {
  const chosen = (id || 'azure-openai-gpt-5-mini') as SummaryModelId
  const provider = providers[chosen]
  if (provider) return provider
  if (chosen === 'claude' || chosen === 'openai') {
    throw new Error(`${chosen} summary provider is not configured. Set SUMMARY_PROVIDER=azure-openai-gpt-5-mini for this pilot.`)
  }
  throw new Error(`Unknown SUMMARY_PROVIDER ${id}`)
}

export function createChatSummaryProvider(id: SummaryModelId, complete: ChatComplete): SummaryProvider {
  return {
    id,
    async summarize(input) {
      const raw = await complete(SUMMARY_SYSTEM, summaryUserPrompt(input))
      return parseSummaryJson(raw)
    },
  }
}

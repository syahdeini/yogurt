import { requireSummaryModel, type SummaryInput, type SummaryModel, type SummaryOutput, type SummaryProvider } from '../../engine/summaryProvider'

/**
 * Asks our API to summarize. The model id is whatever the API ran, so a later swap to Claude or
 * OpenAI shows up here without a vendor SDK or an API key in the app.
 */
export function createCloudSummaryProvider(deps: {
  id?: string
  summarize: (input: SummaryInput, signal?: AbortSignal) => Promise<SummaryOutput>
}): SummaryProvider {
  let id: SummaryModel | 'local' = deps.id ? requireSummaryModel(deps.id) : 'azure-openai-gpt-5-mini'
  return {
    get id() { return id },
    async summarize(input, signal) {
      const output = await deps.summarize(input, signal)
      id = requireSummaryModel(output.model)
      return { ...output, model: id }
    },
  }
}

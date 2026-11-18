import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity'
import { AzureOpenAI } from 'openai'
import { createChatSummaryProvider, selectSummaryProvider, type SummaryProvider } from './provider.js'
import { requiredEnv } from '../claims.js'

let cached: SummaryProvider | undefined

export function createSummaryProvider(env: NodeJS.ProcessEnv = process.env): SummaryProvider {
  if (cached) return cached
  const azure = createChatSummaryProvider('azure-openai-gpt-5-mini', async (system, user) => {
    const endpoint = requiredEnv('AZURE_OPENAI_ENDPOINT', env).replace(/\/$/, '')
    const deployment = env.AZURE_OPENAI_DEPLOYMENT?.trim() || 'gpt-5-mini'
    const credential = new DefaultAzureCredential()
    const client = new AzureOpenAI({
      endpoint,
      deployment,
      apiVersion: env.AZURE_OPENAI_API_VERSION?.trim() || '2024-10-21',
      azureADTokenProvider: getBearerTokenProvider(credential, 'https://cognitiveservices.azure.com/.default'),
    })
    const response = await client.chat.completions.create({
      model: deployment,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 4000,
      stream: false,
    } as Parameters<AzureOpenAI['chat']['completions']['create']>[0])
    const completion = response as { choices?: Array<{ message?: { content?: string | null } }> }
    return completion.choices?.[0]?.message?.content ?? ''
  })
  cached = selectSummaryProvider(env.SUMMARY_PROVIDER, { 'azure-openai-gpt-5-mini': azure })
  return cached
}

export function resetSummaryProvider() { cached = undefined }

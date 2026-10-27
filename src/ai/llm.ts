import { env } from '../config.js'

/**
 * One JSON-schema-constrained chat completion from any OpenAI-compatible
 * endpoint (Fireworks by default, serving DeepSeek). Used for the one thing a
 * decision model cannot do: write an answer the applicant will send
 * (fields/draft.ts).
 */

export interface Usage {
  promptTokens: number
  completionTokens: number
}

export function llmConfigured(): boolean {
  return Boolean(env.llmApiKey)
}

/**
 * Reasoning is switched off wherever the model allows it. The calls here
 * have their whole input in front of the model; hidden reasoning added
 * nothing visible to the output but was most of the bill and the wait
 * (measured on DeepSeek V4 Pro: ~4× the tokens, ~4× the time, same answer).
 * Unknown models are left alone rather than risking a rejected request.
 */
export function modelParams(model: string): { reasoning_effort?: 'none' | 'low' } {
  if (model.includes('gpt-oss')) return { reasoning_effort: 'low' }
  if (/deepseek|kimi|qwen3p8/.test(model)) return { reasoning_effort: 'none' }
  return {}
}

/** Thinking-only models may prefix the JSON with a <think> block; the schema governs what follows it. */
function stripReasoning(content: string): string {
  const close = content.lastIndexOf('</think>')
  return close === -1 ? content : content.slice(close + '</think>'.length)
}

export interface StructuredArgs {
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
  maxOutputTokens: number
  model?: string
  /** Injected in tests; nothing in the test suite reaches the network. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Two attempts, no more: one retry absorbs a flaky generation or a network
 * blip, and a truncated answer (finish_reason `length`) is reported as that
 * rather than as malformed JSON. A second failure throws to the caller.
 */
export async function callStructured<T>(args: StructuredArgs): Promise<{ output: T; usage: Usage }> {
  if (!env.llmApiKey) throw new Error('LLM_API_KEY is not set')
  const model = args.model ?? env.fireworksModel
  const fetchImpl = args.fetchImpl ?? fetch
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchImpl(`${env.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.llmApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: args.maxOutputTokens,
          ...modelParams(model),
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.user },
          ],
          response_format: { type: 'json_schema', json_schema: { name: args.schemaName, schema: args.schema } },
        }),
        signal: AbortSignal.timeout(args.timeoutMs ?? 150_000),
      })
      if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`)
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const choice = body.choices?.[0]
      const usage = { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 }
      if (choice?.finish_reason === 'length') {
        throw new Error(`output truncated at max_tokens=${args.maxOutputTokens} (${usage.completionTokens} completion tokens)`)
      }
      const output = JSON.parse(stripReasoning(choice?.message?.content ?? '').trim()) as T
      return { output, usage }
    } catch (error) {
      lastError = error as Error
      console.warn(`[llm] ${args.schemaName} attempt ${attempt}/2 failed: ${lastError.message}`)
    }
  }
  throw lastError
}

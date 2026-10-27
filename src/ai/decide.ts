import { env } from '../config.js'

/**
 * A small client for TypeSafe's Jev, the "System One" decision model.
 *
 * Jev answers typed questions about a piece of state — pick one of these
 * options, place this on a scale, is this statement true — with a probability
 * for every answer and a confidence derived from how spread out they are. It
 * reads, it does not write: no prose, no reasoning tokens, input billed at
 * ~$0.42/M, 70–500 ms. That makes it the right tool for every decision in the
 * apply pipeline that has a fixed set of answers, and the wrong one for
 * anything the applicant will read (that is DeepSeek's job, in fireworksJson.ts).
 *
 * Docs: https://docs.typesafe.ai — POST /v1/systemone with {model, state,
 * questions}. One request can carry many questions, and callers batch: a form
 * is a handful of calls, not one per field.
 *
 * Never throws. A missing key, a timeout, a 4xx/5xx or a malformed answer all
 * come back as `{ ok: false }`, and every caller treats that as "no decision":
 * the field stays unmapped or the question is asked, which is what happened
 * before this client existed.
 */

export type JevInstructions = string | Record<string, unknown> | unknown[]

export interface ChoiceQuestion {
  type: 'choice'
  instructions: JevInstructions
  /** Option key → description (or null). 1–255 options. */
  criteria: Record<string, string | null>
}

export interface ScoreQuestion {
  type: 'score'
  instructions: JevInstructions
  /** Ordered levels, 2–10, level 0 first. */
  criteria: string[]
}

export interface NoulQuestion {
  type: 'noul'
  instructions: JevInstructions
  criteria?: { true?: string; false?: string }
}

export type JevQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion

export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface ScoreAnswer {
  type: 'score'
  score: number
  confidence: number
  probabilities: Record<string, number>
  legend?: Record<string, string>
}

export interface NoulAnswer {
  type: 'noul'
  /** Probability the statement is true, 0–1. */
  noul: number
}

export type JevAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer

type AnswerFor<Q extends JevQuestion> = Q extends ChoiceQuestion ? ChoiceAnswer : Q extends ScoreQuestion ? ScoreAnswer : NoulAnswer

export interface DecisionUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  /** The model that answered — the pinned version, or what an alias resolved to. */
  model: string
}

export type DecideResult<Q extends Record<string, JevQuestion>> =
  | { ok: true; answers: { [K in keyof Q]: AnswerFor<Q[K]> }; usage: DecisionUsage }
  | { ok: false; reason: 'not_configured' | 'invalid_request' | 'timeout' | 'http_error' | 'bad_response'; message: string; usage?: DecisionUsage }

export const MAX_CHOICE_OPTIONS = 255
export const MIN_SCORE_LEVELS = 2
export const MAX_SCORE_LEVELS = 10

export function jevConfigured(): boolean {
  return Boolean(env.typesafeApiKey)
}

/** The noul equivalent of a choice confidence: |2p − 1|. */
export function noulConfidence(answer: NoulAnswer): number {
  return Math.abs(2 * answer.noul - 1)
}

export function costOf(inputTokens: number, outputTokens: number): number {
  return (inputTokens * env.typesafeInputUsdPerM + outputTokens * env.typesafeOutputUsdPerM) / 1_000_000
}

function validate(questions: Record<string, JevQuestion>): string | null {
  const entries = Object.entries(questions)
  if (entries.length === 0) return 'no questions'
  for (const [id, question] of entries) {
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length
      if (count < 1 || count > MAX_CHOICE_OPTIONS) return `${id}: choice needs 1–${MAX_CHOICE_OPTIONS} options, got ${count}`
    } else if (question.type === 'score') {
      const count = question.criteria.length
      if (count < MIN_SCORE_LEVELS || count > MAX_SCORE_LEVELS) return `${id}: score needs ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} levels, got ${count}`
    }
  }
  return null
}

function wellFormed(question: JevQuestion, answer: unknown): answer is JevAnswer {
  if (!answer || typeof answer !== 'object') return false
  const a = answer as Record<string, unknown>
  if (question.type === 'choice') {
    return typeof a.choice === 'string' && a.choice in question.criteria && typeof a.confidence === 'number'
  }
  if (question.type === 'score') return typeof a.score === 'number' && typeof a.confidence === 'number'
  return typeof a.noul === 'number'
}

export interface DecideOptions {
  timeoutMs?: number
  /** Injected in tests; nothing in the test suite reaches the network. */
  fetchImpl?: typeof fetch
  apiKey?: string
  model?: string
  /** Called once per completed request with what it cost. */
  onUsage?: (usage: DecisionUsage) => void
}

/** Ask Jev a batch of questions about `state`. */
export async function decide<Q extends Record<string, JevQuestion>>(
  state: string | Record<string, unknown> | unknown[],
  questions: Q,
  options: DecideOptions = {},
): Promise<DecideResult<Q>> {
  const apiKey = options.apiKey ?? env.typesafeApiKey
  if (!apiKey) return { ok: false, reason: 'not_configured', message: 'TYPESAFE_API_KEY is not set' }
  const invalid = validate(questions)
  if (invalid) return { ok: false, reason: 'invalid_request', message: invalid }

  const model = options.model ?? env.typesafeModel
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? env.typesafeTimeoutMs)
  const startedAt = Date.now()

  let response: Response
  try {
    response = await fetchImpl(`${env.typesafeBaseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    const aborted = controller.signal.aborted
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'http_error',
      message: aborted ? `no answer within ${options.timeoutMs ?? env.typesafeTimeoutMs} ms` : (error as Error).message,
    }
  }
  clearTimeout(timeout)

  let body: { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number }; detail?: unknown }
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'bad_response', message: `${response.status}: response was not JSON` }
  }

  const inputTokens = body.usage?.input_tokens ?? 0
  const outputTokens = body.usage?.output_tokens ?? 0
  const usage: DecisionUsage = {
    inputTokens,
    outputTokens,
    costUsd: costOf(inputTokens, outputTokens),
    latencyMs: Date.now() - startedAt,
    model: body.model ?? model,
  }
  if (inputTokens || outputTokens) options.onUsage?.(usage)

  if (!response.ok) {
    const detail = body.detail ? JSON.stringify(body.detail).slice(0, 300) : ''
    return { ok: false, reason: 'http_error', message: `typesafe -> ${response.status} ${detail}`.trim(), usage }
  }

  const answers = body.answers ?? {}
  for (const [id, question] of Object.entries(questions)) {
    if (!wellFormed(question, answers[id])) {
      return { ok: false, reason: 'bad_response', message: `answer for ${id} is missing or malformed`, usage }
    }
  }
  return { ok: true, answers: answers as { [K in keyof Q]: AnswerFor<Q[K]> }, usage }
}

/** Running totals for one attempt's decisions, written onto the attempt. */
export class DecisionMeter {
  calls = 0
  inputTokens = 0
  outputTokens = 0
  costUsd = 0
  latencyMs = 0
  model = ''

  record = (usage: DecisionUsage): void => {
    this.calls += 1
    this.inputTokens += usage.inputTokens
    this.outputTokens += usage.outputTokens
    this.costUsd += usage.costUsd
    this.latencyMs += usage.latencyMs
    this.model = usage.model
  }

  toJSON() {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: Number(this.costUsd.toFixed(6)),
      latencyMs: this.latencyMs,
      model: this.model,
    }
  }
}

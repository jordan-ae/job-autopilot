import type { FormAts, FormField } from 'ats-form-fill'
import { fillAnswers, fillContext } from '../plan/answers.js'
import { questionForField, yoursToAnswer } from '../plan/plan.js'
import type { ApplyContext, ApplyQuestion } from '../types.js'
import type { AgentDeps, AgentAnswer, ClassificationCache } from './agent.js'
import { agentCostUsd, runAgentPass, type AgentRunRecord } from './agentRun.js'

/**
 * The write step for one open form: every question on it that stored data
 * does not answer goes to the agent pass (fields/agent.ts), and what the
 * agent adds comes back as attempt questions for the fill plan.
 *
 * Only the agent's additions are returned as answers. What the resolver
 * already answers is left for the fill plan to resolve again on the page
 * (plan/plan.ts), so each filled value keeps the resolver layer it came from,
 * and the source gate can tell stored data from the agent's drafts.
 *
 * Never put to the agent: files, traps, equal-opportunity questions and
 * consents (plan.ts `yoursToAnswer`), and anything already answered on this
 * attempt. A draft from an earlier run stays a draft: the record that marks
 * it as the agent's is carried over, never replaced.
 */
export async function answerForm(
  fields: FormField[],
  input: {
    ctx: ApplyContext
    ats: FormAts
    /** The attempt's questions so far: the applicant's own answers, and earlier drafts. */
    existing: ApplyQuestion[]
    /** The agent pass's record from earlier runs of this attempt. */
    previous?: AgentRunRecord | null
    cache: ClassificationCache
    jobDescription?: string
    deps?: Partial<AgentDeps>
  },
): Promise<{ questions: ApplyQuestion[]; record: AgentRunRecord | null; agentAnswers: AgentAnswer[]; costUsd: number }> {
  const answered = new Set(input.existing.filter((question) => question.answer != null && question.answer !== '').map((question) => question.id))
  const open = fields
    .filter((field) => !yoursToAnswer(field) && !answered.has(field.key))
    .map((field): ApplyQuestion => ({ ...questionForField(field, ''), answer: null }))
  if (open.length === 0) return { questions: input.existing, record: input.previous ?? null, agentAnswers: [], costUsd: 0 }

  const stored = fillAnswers(open, input.ctx.profile, input.ctx.job.company, fillContext(input.ctx))
  const { questions: after, record, agentAnswers } = await runAgentPass(stored, input.ctx, input.ats, {
    cache: input.cache,
    jobDescription: input.jobDescription,
    deps: input.deps,
  })

  const added: ApplyQuestion[] = []
  after.forEach((question, index) => {
    const before = stored[index]
    const has = (value: ApplyQuestion['answer']) => value != null && value !== '' && !(Array.isArray(value) && value.length === 0)
    if (!has(before?.answer) && has(question.answer)) added.push(question)
  })
  const keep = input.existing.filter((question) => !added.some((entry) => entry.id === question.id))
  return { questions: [...keep, ...added], record: mergeRecords(input.previous ?? null, record), agentAnswers, costUsd: agentCostUsd(record) }
}

/** Earlier runs' record with this run's added: every draft ever made on the attempt stays listed. */
export function mergeRecords(previous: AgentRunRecord | null, next: AgentRunRecord | null): AgentRunRecord | null {
  if (!previous) return next
  if (!next) return previous
  const ids = new Set(next.answers.map((answer) => answer.questionId))
  return {
    usage: {
      calls: previous.usage.calls + next.usage.calls,
      inputTokens: previous.usage.inputTokens + next.usage.inputTokens,
      outputTokens: previous.usage.outputTokens + next.usage.outputTokens,
      costUsd: Number((previous.usage.costUsd + next.usage.costUsd).toFixed(6)),
      latencyMs: previous.usage.latencyMs + next.usage.latencyMs,
      model: next.usage.model || previous.usage.model,
    },
    draftCostUsd: Number((previous.draftCostUsd + next.draftCostUsd).toFixed(6)),
    mappings: [...previous.mappings.filter((mapping) => !next.mappings.some((entry) => entry.questionId === mapping.questionId)), ...next.mappings],
    notes: [...previous.notes, ...next.notes].slice(-20),
    answers: [...previous.answers.filter((answer) => !ids.has(answer.questionId)), ...next.answers],
  }
}

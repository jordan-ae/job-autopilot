import { DecisionMeter, jevConfigured } from '../ai/decide.js'
import type { AgentAnswerRecord } from '../store/types.js'
import type { ApplyContext, ApplyQuestion } from '../types.js'
import { agentFill, defaultAgentDeps, type AgentAnswer, type AgentDeps, type AgentOutcome, type ClassificationCache } from './agent.js'
import { draftConfigured } from './draft.js'
import { jobFingerprint } from './text.js'

/**
 * The agent pass as a run uses it: wired to Jev, the drafter and the shared
 * classification cache, with its cost recorded and its failures contained.
 * Whatever goes wrong here, the application carries on with what the
 * deterministic resolver answered; the rest is asked, as before.
 */

export interface AgentRunRecord {
  usage: ReturnType<DecisionMeter['toJSON']>
  draftCostUsd: number
  mappings: AgentOutcome['mappings']
  notes: string[]
  /** What the agent answered on this attempt, for the review list. */
  answers: Array<Pick<AgentAnswer, 'questionId' | 'label' | 'answer' | 'via' | 'confidence' | 'fieldKey'>>
}

export async function runAgentPass(
  questions: ApplyQuestion[],
  ctx: ApplyContext,
  ats: string,
  options: { cache: ClassificationCache; jobDescription?: string; deps?: Partial<AgentDeps> },
): Promise<{ questions: ApplyQuestion[]; record: AgentRunRecord | null; agentAnswers: AgentAnswer[] }> {
  const jevEnabled = options.deps?.jevEnabled ?? jevConfigured()
  if (!jevEnabled) return { questions, record: null, agentAnswers: [] }
  const meter = options.deps?.meter ?? new DecisionMeter()
  try {
    const outcome = await agentFill(
      questions,
      {
        profile: ctx.profile,
        company: ctx.job.company,
        job: { id: ctx.job.id, location: ctx.job.location, foundOn: ctx.job.found_on ?? null },
        resume: ctx.resume ?? null,
        overrides: ctx.overrides ?? {},
        documents: { resume: true, coverLetter: Boolean(ctx.coverLetterText) },
        ats,
        jobTitle: ctx.job.role,
        jobDescription: options.jobDescription ?? '',
      },
      { ...defaultAgentDeps(options.cache, meter, true, draftConfigured()), ...options.deps, jevEnabled: true },
    )
    return {
      questions: outcome.questions,
      agentAnswers: outcome.answers,
      record: {
        usage: meter.toJSON(),
        draftCostUsd: Number(outcome.draftCostUsd.toFixed(6)),
        mappings: outcome.mappings,
        notes: outcome.notes,
        answers: outcome.answers.map(({ questionId, label, answer, via, confidence, fieldKey }) => ({ questionId, label, answer, via, confidence, fieldKey })),
      },
    }
  } catch (error) {
    console.warn(`[fields] agent pass failed, asking instead: ${(error as Error).message}`)
    return { questions, record: { usage: meter.toJSON(), draftCostUsd: 0, mappings: [], notes: [`failed:${(error as Error).message}`.slice(0, 200)], answers: [] }, agentAnswers: [] }
  }
}

/**
 * The agent's answers as review-list entries. A job-scoped answer (one that
 * names the employer) is kept under its own fingerprint, so no other
 * application ever sees it.
 */
export function agentAnswerRecords(userId: string, answers: AgentAnswer[], context: { jobId: string; attemptId: string }, now = new Date()): AgentAnswerRecord[] {
  return answers.map((answer) => ({
    userId,
    fingerprint: answer.jobScoped ? jobFingerprint(answer.fingerprint, context.jobId) : answer.fingerprint,
    label: answer.label,
    answer: Array.isArray(answer.answer) ? answer.answer.join(', ') : typeof answer.answer === 'boolean' ? (answer.answer ? 'Yes' : 'No') : answer.answer,
    fieldKey: answer.fieldKey,
    jobId: answer.jobScoped ? context.jobId : null,
    attemptId: context.attemptId,
    via: answer.via,
    confidence: answer.confidence,
    reviewState: 'pending',
    createdAt: now.toISOString(),
  }))
}

export const agentCostUsd = (record: AgentRunRecord | null) => (record ? record.usage.costUsd + record.draftCostUsd : 0)

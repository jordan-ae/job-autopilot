import { newNumbersIn } from '../ai/facts.js'
import { env } from '../config.js'
import { callStructured, llmConfigured, type Usage } from '../ai/llm.js'
import { estimateCostUsd } from '../ai/pricing.js'

/**
 * Written answers to application questions, drafted by DeepSeek from the
 * applicant's own material and nothing else.
 *
 * The model sees the question, the job, and the applicant's CV, profile
 * facts and banked answers. It is told to write only what that material
 * supports, and to say so when it does not — an essay about an experience the
 * CV never mentions is not an answer the agent will send. On top of the prompt,
 * the numeric fabrication guard (ai/facts.ts) rejects any draft that states a
 * quantity the material does not contain: the one kind of invention a prompt
 * reliably fails to prevent.
 *
 * Every draft is kept for the applicant to review (fields/agentRun.ts), and
 * the submit gates treat it as a draft until they have (executor/submitGates.ts).
 */

export interface DraftArgs {
  question: string
  /** Help text under the question, often the real prompt. */
  description?: string
  company: string
  jobTitle?: string
  jobDescription?: string
  /** Everything the applicant has on file, as plain text. The only source. */
  material: string
  /** Characters the box takes, when the form says. */
  maxLength?: number | null
}

export interface DraftResult {
  answer: string
  usage: Usage
}

export type DraftRejection = 'not_configured' | 'ungrounded' | 'new_numbers' | 'empty' | 'failed'

const SYSTEM = `You write answers to job-application questions on behalf of an applicant, in the first person.

Rules — follow all of them:
- Use ONLY facts from APPLICANT MATERIAL. Never invent employers, projects, skills, dates, numbers, titles or outcomes.
- Never state a number, percentage, duration or count that does not appear in APPLICANT MATERIAL.
- You may refer to the employer and role named in JOB, and what JOB says about them.
- If APPLICANT MATERIAL does not contain enough to answer honestly, set "grounded" to false and leave "answer" empty.
- Plain, specific, warm, no clichés ("I am passionate", "fast-paced environment"), no headings, no lists unless asked.
- Match the length the question asks for; otherwise 60–150 words.
- Never mention demographic or protected characteristics (gender, race, age, disability, religion, nationality).`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['grounded', 'answer'],
  properties: {
    grounded: { type: 'boolean' },
    answer: { type: 'string' },
  },
}

export function draftConfigured(): boolean {
  return llmConfigured()
}

/** Draft one answer, or say why there is none. */
export async function draftAnswer(args: DraftArgs): Promise<DraftResult | { rejected: DraftRejection; usage?: Usage }> {
  if (!llmConfigured()) return { rejected: 'not_configured' }
  const user = [
    `QUESTION: ${args.question}`,
    args.description ? `QUESTION DETAILS: ${args.description}` : '',
    `JOB: ${args.jobTitle ? `${args.jobTitle} at ` : ''}${args.company}`,
    args.jobDescription ? `JOB DESCRIPTION (excerpt):\n${args.jobDescription.slice(0, 4000)}` : '',
    args.maxLength ? `LIMIT: at most ${args.maxLength} characters.` : '',
    `APPLICANT MATERIAL:\n${args.material.slice(0, 12000)}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  let output: { grounded: boolean; answer: string }
  let usage: Usage
  try {
    ;({ output, usage } = await callStructured<{ grounded: boolean; answer: string }>({
      system: SYSTEM,
      user,
      schemaName: 'application_answer',
      schema: SCHEMA,
      maxOutputTokens: 900,
      model: env.fireworksModel,
    }))
  } catch (error) {
    console.warn(`[fields] draft failed: ${(error as Error).message}`)
    return { rejected: 'failed' }
  }

  return checkDraft(output, args, usage)
}

/** The guard, separate so tests can run it without a model. */
export function checkDraft(
  output: { grounded: boolean; answer: string },
  args: Pick<DraftArgs, 'material' | 'jobDescription' | 'maxLength' | 'company' | 'jobTitle'>,
  usage: Usage = { promptTokens: 0, completionTokens: 0 },
): DraftResult | { rejected: DraftRejection; usage?: Usage } {
  const answer = output.answer.trim()
  if (!output.grounded) return { rejected: 'ungrounded', usage }
  if (!answer) return { rejected: 'empty', usage }
  // Figures may come from the applicant's material or from the job ad
  // ("your 3-day hybrid policy"); from anywhere else they are invented.
  const source = `${args.material}\n${args.jobDescription ?? ''}\n${args.jobTitle ?? ''} ${args.company}`
  if (newNumbersIn(answer, source).length > 0) return { rejected: 'new_numbers', usage }
  const capped = args.maxLength && answer.length > args.maxLength ? answer.slice(0, args.maxLength).replace(/\s+\S*$/, '') : answer
  return { answer: capped, usage }
}

/** What a draft cost, for the attempt's cost record. */
export function draftCostUsd(usage: Usage): number {
  return estimateCostUsd(env.fireworksModel, usage.promptTokens, usage.completionTokens)
}

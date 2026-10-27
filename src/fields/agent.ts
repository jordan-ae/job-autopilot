import { decide as jevDecide, type ChoiceQuestion, type DecideOptions, type DecisionMeter, type NoulQuestion } from '../ai/decide.js'
import { coerce } from '../plan/answers.js'
import type { ApplyQuestion } from '../types.js'
import type { Classification } from './classify.js'
import { draftAnswer as deepseekDraft, draftCostUsd, type DraftArgs, type DraftRejection, type DraftResult } from './draft.js'
import { CANONICAL_FIELDS, effectiveMode, fieldByKey, type CanonicalField } from './registry.js'
import { resolveQuestion, type ResolveContext } from './resolver.js'
import { fingerprintQuestion, namesCompany } from './text.js'
import { DECISION_THRESHOLDS, MAX_MODEL_QUESTIONS_PER_FORM } from './thresholds.js'

/**
 * The agent pass: what runs after the deterministic resolver has answered
 * everything it can, on the questions it could not.
 *
 *   A. map    — an unrecognised question → a canonical field. The shared
 *               classification cache first (one answer per ATS field, for
 *               every user), then Jev. Unsure → left unmapped.
 *   B. option — we hold a stored value but no option has the same text ("No"
 *               vs "No, I will not require sponsorship", "Indonesia" vs "ID —
 *               Indonesia"): Jev picks the option that says the same thing.
 *   C. prose  — an open-ended free-text question: a Jev yes/no gate decides
 *               whether it wants a written answer; if so DeepSeek drafts one
 *               from the user's CV, profile and bank (fields/draft.ts),
 *               guarded against invented numbers.
 *
 * The rule (decided in Arkoo on 2026-10-03): personal, factual and
 * legal questions — work authorisation, sponsorship, salary, years of X, EEO,
 * notice, start date, "how did you hear" — are answered only from a stored
 * value. Jev may say which field a question is and which option a stored
 * value is; it never decides the value. With nothing stored, the question
 * goes to needs_input. Only open-ended questions (draftable fields, or
 * unmapped free text the gate says wants prose) are ever drafted.
 *
 * Every drafted answer is the agent's, not the user's: it goes into the
 * answer bank with source 'agent', is listed for review in the Field Mapper,
 * and the user's correction replaces it next time.
 *
 * Never touches EEO or consent questions, never acts on a field whose mode is
 * `ask` or `decline_or_blank`, and does nothing at all without
 * TYPESAFE_API_KEY (the degraded path is exactly the old one: ask).
 */

export interface CachedClassification {
  /** Null: classified as matching no canonical field. */
  canonicalKey: string | null
  confidence: number
}

export interface ClassificationCacheKey {
  ats: string
  nativeKey: string
  fingerprint: string
}

export interface ClassificationCache {
  get(keys: ClassificationCacheKey[]): Promise<Map<string, CachedClassification>>
  put(rows: Array<ClassificationCacheKey & CachedClassification & { model: string }>): Promise<void>
}

export const cacheId = (key: ClassificationCacheKey) => `${key.ats}\u0000${key.nativeKey}\u0000${key.fingerprint}`

export interface AgentDeps {
  decide: typeof jevDecide
  draft: (args: DraftArgs) => Promise<DraftResult | { rejected: DraftRejection }>
  cache: ClassificationCache
  meter?: DecisionMeter
  /** Whether a Jev key is configured. Without one the pass is skipped. */
  jevEnabled: boolean
  draftEnabled: boolean
}

export interface AgentContext extends ResolveContext {
  ats: string
  jobTitle?: string
  jobDescription?: string
}

export type AgentVia = 'draft'

export interface AgentAnswer {
  questionId: string
  label: string
  /** The bank fingerprint the answer is stored under. */
  fingerprint: string
  fieldKey: string | null
  answer: string | string[] | boolean
  via: AgentVia
  confidence: number | null
  /** True when the answer names the employer or the field is per-employer:
   * it is kept for this job only. */
  jobScoped: boolean
}

export interface AgentMapping {
  questionId: string
  fieldKey: string
  via: 'cache' | 'model'
  confidence: number
}

export interface AgentOutcome {
  questions: ApplyQuestion[]
  answers: AgentAnswer[]
  mappings: AgentMapping[]
  /** What the drafts cost (Jev's cost is on the meter). */
  draftCostUsd: number
  /** Why the pass did less than it might have, for the attempt record. */
  notes: string[]
}

/**
 * A question's choices, only when they really are a list of strings. An
 * adapter once handed over an object here ({"length":120}), whose `length`
 * looked like a list and whose `.slice` threw, taking the whole pass down.
 */
const optionsOf = (question: ApplyQuestion): string[] =>
  Array.isArray(question.options) ? question.options.filter((option): option is string => typeof option === 'string') : []

const answered = (question: ApplyQuestion) =>
  question.answer != null && question.answer !== '' && !(Array.isArray(question.answer) && question.answer.length === 0)

const eligible = (question: ApplyQuestion) => !question.kind && !question.manual && question.type !== 'file' && !answered(question)

const isChoice = (question: ApplyQuestion) =>
  question.type === 'boolean' || ((question.type === 'select' || question.type === 'multiselect') && optionsOf(question).length > 0)

function forced(field: CanonicalField, via: 'cache' | 'model', confidence: number): Classification {
  return { field, via, confidence, ...(field.block ? { entryIndex: 0 } : {}) }
}

/** Options as Jev criteria: stable short keys, the text as description. */
function optionCriteria(options: string[], extra: Record<string, string>): Record<string, string> {
  const criteria: Record<string, string> = {}
  options.slice(0, 250).forEach((option, index) => {
    criteria[`o${index}`] = option
  })
  return { ...criteria, ...extra }
}

const choiceOptions = (question: ApplyQuestion) => (question.type === 'boolean' ? ['Yes', 'No'] : optionsOf(question))

function fromOptionKey(question: ApplyQuestion, key: string): string | boolean | string[] | null {
  const match = /^o(\d+)$/.exec(key)
  if (!match) return null
  const option = choiceOptions(question)[Number(match[1])]
  if (option == null) return null
  if (question.type === 'boolean') return option === 'Yes'
  return question.type === 'multiselect' ? [option] : option
}

/** What the applicant has on file, as plain text — the only material the
 * agent may answer from. */
export function applicantMaterial(ctx: ResolveContext): string {
  const p = ctx.profile
  const lines: string[] = []
  const fact = (label: string, value: unknown) => {
    if (value != null && value !== '' && !(Array.isArray(value) && value.length === 0)) lines.push(`${label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
  }
  fact('Location', p.location)
  fact('Country of residence', p.country)
  fact('Citizenship', p.citizenship)
  fact('Work authorization (as written)', p.work_authorization)
  for (const row of p.work_authorizations ?? []) {
    lines.push(
      `Work authorization in ${row.region}: authorized=${row.authorized ?? 'unknown'}, needs sponsorship=${row.needs_sponsorship ?? 'unknown'}, open to contractor/EOR=${row.open_to_contractor_eor ?? 'unknown'}`,
    )
  }
  fact('Notice period (days)', p.notice_period_days)
  fact('Earliest start date', p.earliest_start_date)
  fact('Desired salary', p.desired_salary == null ? null : `${p.desired_salary} ${p.desired_salary_currency}`)
  fact('LinkedIn', p.linkedin_url)
  fact('GitHub', p.github_url)
  fact('Portfolio', p.portfolio_url)

  const resume = ctx.resume
  if (resume) {
    if (resume.summary.trim()) lines.push(`\nCV summary: ${resume.summary.trim()}`)
    if (resume.skills.trim()) lines.push(`Skills: ${resume.skills.trim()}`)
    if (resume.languages.length) lines.push(`Languages: ${resume.languages.join(', ')}`)
    for (const job of resume.experience.filter((entry) => entry.isVisible !== false)) {
      lines.push(`\nRole: ${job.jobTitle} at ${job.company} (${job.startDate || '?'} – ${job.endDate || 'present'})`)
      for (const bullet of job.bullets ?? []) lines.push(`- ${bullet}`)
    }
    for (const school of resume.education.filter((entry) => entry.isVisible !== false)) {
      lines.push(`Education: ${school.degree} — ${school.school}${school.year ? ` (${school.year})` : ''}${school.details ? `. ${school.details}` : ''}`)
    }
  }

  // The user's own banked answers, never the agent's unreviewed ones: an
  // agent answer is not evidence for another agent answer.
  const meta = p.answer_meta ?? {}
  const banked = Object.entries(p.custom_answers ?? {})
    .filter(([key, value]) => value && !key.includes('#') && (meta[key]?.source ?? 'user') !== 'agent')
    .slice(0, 30)
  if (banked.length) {
    lines.push('\nPreviously answered:')
    for (const [key, value] of banked) lines.push(`- ${key.startsWith('field:') ? key.slice(6) : key}: ${value.slice(0, 400)}`)
  }
  return lines.join('\n').trim()
}

function stateFor(question: ApplyQuestion, ctx: AgentContext) {
  return {
    question: {
      text: question.label,
      ...(question.description ? { help: question.description.slice(0, 600) } : {}),
      control: question.type,
      ...(optionsOf(question).length ? { options: optionsOf(question).slice(0, 30) } : {}),
    },
    job: { company: ctx.company, ...(ctx.jobTitle ? { title: ctx.jobTitle } : {}), ...(ctx.job?.location ? { location: ctx.job.location } : {}) },
  }
}

/** The fields worth offering the classifier, as choice criteria. */
function fieldCriteria(): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const field of CANONICAL_FIELDS) criteria[field.key] = field.hint ? `${field.label} — ${field.hint}` : field.label
  criteria.none = 'None of these: the question asks something specific to this job or employer'
  return criteria
}

export async function agentFill(questions: ApplyQuestion[], ctx: AgentContext, deps: AgentDeps): Promise<AgentOutcome> {
  const outcome: AgentOutcome = { questions: questions.map((question) => ({ ...question })), answers: [], mappings: [], draftCostUsd: 0, notes: [] }
  if (!deps.jevEnabled) {
    outcome.notes.push('jev_not_configured')
    return outcome
  }
  const decideOptions: DecideOptions = deps.meter ? { onUsage: deps.meter.record } : {}
  const work = outcome.questions.filter(eligible)
  if (work.length === 0) return outcome

  // ── A. Map the questions the registry does not recognise ───────────────
  const classified = new Map<string, Classification | null>()
  const unmapped: ApplyQuestion[] = []
  for (const question of work) {
    const resolution = resolveForAgent(question, ctx)
    classified.set(question.id, resolution.classification)
    if (!resolution.classification) unmapped.push(question)
  }

  if (unmapped.length) {
    const keyOf = (question: ApplyQuestion): ClassificationCacheKey => ({
      ats: ctx.ats,
      nativeKey: question.id,
      fingerprint: fingerprintQuestion(question.label, ctx.company),
    })
    const cached = await deps.cache.get(unmapped.map(keyOf)).catch(() => new Map<string, CachedClassification>())
    const toAsk: ApplyQuestion[] = []
    for (const question of unmapped) {
      const hit = cached.get(cacheId(keyOf(question)))
      if (!hit) {
        toAsk.push(question)
        continue
      }
      const field = hit.canonicalKey ? fieldByKey(hit.canonicalKey) : undefined
      if (field && hit.confidence >= DECISION_THRESHOLDS.mapLabel) {
        classified.set(question.id, forced(field, 'cache', hit.confidence))
        outcome.mappings.push({ questionId: question.id, fieldKey: field.key, via: 'cache', confidence: hit.confidence })
      }
    }

    // A long form's optional extras are not worth a classification each.
    const asking = toAsk.length > MAX_MODEL_QUESTIONS_PER_FORM ? toAsk.filter((question) => question.required) : toAsk
    if (asking.length) {
      const criteria = fieldCriteria()
      const batch: Record<string, ChoiceQuestion> = {}
      asking.forEach((question, index) => {
        batch[`q${index}`] = {
          type: 'choice',
          instructions: `Which standard job-application field is the question in ${'`'}questions.q${index}${'`'} of the state asking the applicant for? Choose "none" if it is specific to this job or not in the list.`,
          criteria,
        }
      })
      const state = {
        questions: Object.fromEntries(
          asking.map((question, index) => [
            `q${index}`,
            {
              text: question.label,
              ...(question.description ? { help: question.description.slice(0, 400) } : {}),
              control: question.type,
              ...(optionsOf(question).length ? { options: optionsOf(question).slice(0, 15) } : {}),
            },
          ]),
        ),
      }
      const result = await deps.decide(state, batch, decideOptions)
      if (!result.ok) outcome.notes.push(`map:${result.reason}`)
      else {
        const rows: Array<ClassificationCacheKey & CachedClassification & { model: string }> = []
        asking.forEach((question, index) => {
          const answer = result.answers[`q${index}`]
          const field = answer.choice === 'none' ? undefined : fieldByKey(answer.choice)
          const confident = answer.confidence >= DECISION_THRESHOLDS.mapLabel
          rows.push({ ...keyOf(question), canonicalKey: field && confident ? field.key : null, confidence: answer.confidence, model: result.usage.model })
          if (field && confident) {
            classified.set(question.id, forced(field, 'model', answer.confidence))
            outcome.mappings.push({ questionId: question.id, fieldKey: field.key, via: 'model', confidence: answer.confidence })
          }
        })
        await deps.cache.put(rows).catch((error) => outcome.notes.push(`cache_write:${(error as Error).message}`))
      }
    }
  }

  // Re-resolve with the new mappings, and sort what is left by what can be done.
  const optionPicks: Array<{ question: ApplyQuestion; value: string }> = []
  const prose: ApplyQuestion[] = []
  for (const question of work) {
    const classification = classified.get(question.id) ?? null
    const field = classification?.field
    // The applicant's alone, or asked of them by their own choice.
    if (field?.sensitivity === 'eeo' || field?.sensitivity === 'consent') continue
    if (field && effectiveMode(field, ctx.profile.field_modes) !== 'autofill') continue
    if (field?.source === 'ask') continue

    const resolution = resolveForAgent(question, ctx, classification)
    if (resolution.value != null) {
      const fitted = coerce(resolution.value, question, resolution)
      if (fitted != null && fitted !== '') {
        question.answer = fitted
        continue
      }
      // We hold a value; the options just do not spell it the same way.
      if (isChoice(question) && question.type !== 'boolean') {
        optionPicks.push({ question, value: valueText(resolution.value) })
        continue
      }
      continue
    }
    // Nothing stored. A factual or legal question — every mapped field that
    // is not an essay, and every yes/no or multiple-choice question — is
    // asked: the agent never decides such a value. Only open-ended free text
    // (an essay field, or an unrecognised text box) may be drafted.
    if (isChoice(question)) continue
    if (field && !field.draftable) continue
    if (question.type === 'text' || question.type === 'textarea') prose.push(question)
  }

  // ── B. Pick the option that says what we hold ───────────────────────────
  if (optionPicks.length) {
    const batch: Record<string, ChoiceQuestion> = {}
    optionPicks.forEach(({ question }, index) => {
      batch[`q${index}`] = {
        type: 'choice',
        instructions: `For questions.q${index} in the state, which option says the same thing as its "answer"? Choose "none" if no option means the same.`,
        criteria: optionCriteria(choiceOptions(question), { none: 'No option means the same as the answer' }),
      }
    })
    const state = {
      questions: Object.fromEntries(optionPicks.map(({ question, value }, index) => [`q${index}`, { text: question.label, answer: value }])),
    }
    const result = await deps.decide(state, batch, decideOptions)
    if (!result.ok) outcome.notes.push(`option:${result.reason}`)
    else
      optionPicks.forEach(({ question }, index) => {
        const answer = result.answers[`q${index}`]
        if (answer.confidence < DECISION_THRESHOLDS.pickOption) return
        const picked = fromOptionKey(question, answer.choice)
        // A value we already hold, matched to its option: the user's data, not
        // a new claim, so it is filled without going to the review list.
        if (picked != null) question.answer = picked
      })
  }

  const material = applicantMaterial(ctx)
  // ── C. Draft written answers ────────────────────────────────────────────
  if (prose.length && material && ctx.resume) {
    if (!deps.draftEnabled) outcome.notes.push('draft_not_configured')
    else {
      const batch: Record<string, NoulQuestion> = {}
      prose.forEach((question, index) => {
        batch[`q${index}`] = {
          type: 'noul',
          instructions:
            `Answering questions.q${index} well needs a written answer of at least a sentence in the applicant's own words — ` +
            `not a single fact such as a name, number, date, place or link.`,
        }
      })
      const state = { questions: Object.fromEntries(prose.map((question, index) => [`q${index}`, stateFor(question, ctx).question])) }
      const gate = await deps.decide(state, batch, decideOptions)
      if (!gate.ok) outcome.notes.push(`gate:${gate.reason}`)
      else {
        const toDraft = prose.filter((_, index) => gate.answers[`q${index}`].noul >= DECISION_THRESHOLDS.needsProse)
        // One at a time: these are the expensive calls, and a form rarely has more than three.
        for (const question of toDraft) {
          const drafted = await deps.draft({
            question: question.label,
            description: question.description,
            company: ctx.company,
            jobTitle: ctx.jobTitle,
            jobDescription: ctx.jobDescription,
            material,
          })
          if ('rejected' in drafted) {
            outcome.notes.push(`draft:${drafted.rejected}`)
            continue
          }
          outcome.draftCostUsd += draftCostUsd(drafted.usage)
          question.answer = drafted.answer
          outcome.answers.push(agentAnswer(question, drafted.answer, 'draft', null, ctx, classified.get(question.id)?.field))
        }
      }
    }
  }

  return outcome
}

function valueText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

function resolveForAgent(question: ApplyQuestion, ctx: AgentContext, classification?: Classification | null) {
  return resolveQuestion(
    { label: question.label, description: question.description, key: question.id, ats: ctx.ats, kind: question.type, options: optionsOf(question) },
    ctx,
    classification,
  )
}

function agentAnswer(
  question: ApplyQuestion,
  answer: string | string[] | boolean,
  via: AgentVia,
  confidence: number | null,
  ctx: AgentContext,
  field: CanonicalField | undefined,
): AgentAnswer {
  const text = valueText(answer)
  const jobScoped = Boolean(field?.perEmployer) || namesCompany(question.label, ctx.company) || namesCompany(text, ctx.company)
  return {
    questionId: question.id,
    label: question.label,
    fingerprint: fingerprintQuestion(question.label, ctx.company),
    fieldKey: field?.key ?? null,
    answer,
    via,
    confidence,
    jobScoped,
  }
}

/** The production wiring. */
export function defaultAgentDeps(cache: ClassificationCache, meter: DecisionMeter, jevEnabled: boolean, draftEnabled: boolean): AgentDeps {
  return { decide: jevDecide, draft: deepseekDraft, cache, meter, jevEnabled, draftEnabled }
}

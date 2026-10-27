import { countryOption } from '../fields/countries.js'
import { numericOption } from '../fields/computed.js'
import { resolveQuestion, type RawValue, type Resolution, type ResolveContext } from '../fields/resolver.js'
import type { ApplicationProfile, ApplyContext, ApplyQuestion } from '../types.js'

// The wording helpers moved to fields/ with the field registry; re-exported
// so the answer bank, the adapters and their tests keep one import.
export { fingerprintQuestion, namesCompany } from '../fields/text.js'
export { findSimilarAnswer } from '../fields/resolver.js'

/** What fillAnswers can know beyond the profile: the job and its CV. */
export type FillContext = Omit<ResolveContext, 'profile' | 'company'>

/** The fill context an adapter has at prepare time. */
export function fillContext(ctx: Pick<ApplyContext, 'job' | 'resume' | 'overrides'>): FillContext {
  return { job: { id: ctx.job.id, location: ctx.job.location, foundOn: ctx.job.found_on ?? null }, resume: ctx.resume ?? null, overrides: ctx.overrides ?? {} }
}

/**
 * Fill in every question we can answer from stored data, and leave the rest
 * with `answer: null`.
 *
 * Nothing here invents an answer. Each question is matched to a canonical
 * field (fields/registry.ts) and resolved from what the user put on file —
 * their profile, their CV, their answer bank — in the order fields/resolver.ts
 * documents. A question with nothing behind it stays unanswered for the user
 * to complete, or for the agent pass (fields/agent.ts) to draft from the
 * same data.
 */
export function fillAnswers(
  questions: ApplyQuestion[],
  profile: ApplicationProfile,
  company: string,
  context: FillContext = {},
): ApplyQuestion[] {
  return questions.map((question) => {
    if (question.answer != null && question.answer !== '') return question
    // Files are attached by the adapter itself, from the tailored documents.
    if (question.type === 'file') return { ...question, answer: null }
    // A recorded video, say: the applicant's to give.
    if (question.manual) return { ...question, answer: null }
    const resolution = resolveForQuestion(question, profile, company, context)
    return { ...question, answer: resolution.value == null ? null : coerce(resolution.value, question, resolution) }
  })
}

/** The resolver's view of one prepared question. */
export function resolveForQuestion(
  question: ApplyQuestion,
  profile: ApplicationProfile,
  company: string,
  context: FillContext = {},
): Resolution {
  return resolveQuestion(
    {
      label: question.label,
      description: question.description,
      key: question.id,
      kind: question.type,
      options: question.options,
      // Equal-opportunity answers and consents are given per application, by
      // the applicant: the form's own structure says which these are.
      eeo: question.kind === 'eeo',
      consent: question.kind === 'consent',
    },
    { ...context, profile, company },
  )
}

const normalizeOption = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * The option a stored value stands for, or null.
 *
 * Equal text only. Matching on a shared substring picks "I do not wish to
 * answer" for a stored "No", and "Authorized" for "I am not authorized". The
 * one allowance is a plain yes or no against options that spell it out ("Yes,
 * I will require sponsorship"), and only when a single option opens that way.
 * Anything subtler is the agent pass's call (fields/agent.ts), and it only
 * makes it when it is sure.
 */
export function matchOption(options: string[], text: string): string | null {
  const wanted = normalizeOption(text)
  const exact = options.find((option) => normalizeOption(option) === wanted)
  if (exact) return exact
  if (wanted !== 'yes' && wanted !== 'no') return null
  const opening = options.filter((option) => new RegExp(`^${wanted}\\b`).test(normalizeOption(option)))
  return opening.length === 1 ? opening[0] : null
}

/** The option a resolved value stands for: by text, by number range ("6-9
 * years"), or by country. */
export function optionFor(options: string[], value: RawValue, resolution?: Pick<Resolution, 'countryCode'>): string | null {
  if (typeof value === 'number') return numericOption(options, value) ?? matchOption(options, String(value))
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.join(', ') : value
  return matchOption(options, text) ?? (resolution?.countryCode ? countryOption(options, resolution.countryCode) : null)
}

/** Fit a stored value to the question's declared type — including snapping a
 * free-text answer onto one of a select's options, since sending an option the
 * ATS doesn't offer is rejected outright. */
export function coerce(
  value: RawValue,
  question: Pick<ApplyQuestion, 'type' | 'options'>,
  resolution?: Pick<Resolution, 'countryCode'>,
): string | string[] | boolean | null {
  if (question.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return null
    if (Array.isArray(value)) return null
    if (/^(yes|true|y)$/i.test(value)) return true
    if (/^(no|false|n)$/i.test(value)) return false
    return null
  }

  if (question.type === 'select' || question.type === 'multiselect') {
    const options = question.options ?? []
    const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.join(', ') : String(value)
    if (options.length === 0) return text
    const whole = optionFor(options, value, resolution)
    if (whole) return question.type === 'multiselect' ? [whole] : whole
    if (question.type === 'multiselect') {
      // A remembered multi-select is stored joined with commas. Every part
      // has to be an option; one that is not means the lists differ.
      const parts = (Array.isArray(value) ? value : text.split(/,\s*/)).map((part) => matchOption(options, part))
      if (parts.length > 1 && parts.every((part): part is string => part !== null)) return parts
    }
    // No option matches what we have stored — ask rather than guess.
    return null
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** Required questions still without an answer. These block submission. */
export function unansweredRequired(questions: ApplyQuestion[]): ApplyQuestion[] {
  return questions.filter(
    (question) =>
      question.required &&
      question.type !== 'file' &&
      (question.answer == null || question.answer === '' ||
        (Array.isArray(question.answer) && question.answer.length === 0)),
  )
}

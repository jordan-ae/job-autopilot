import { coerce, matchOption, optionFor } from './answers.js'
import type { FieldKind, FormAts, FormField } from 'ats-form-fill'
import type { ApplicationProfile, ApplyContext, ApplyQuestion, ApplyQuestionType, ResumeFacts } from '../types.js'
import { resolveQuestion, type ResolutionLayer } from '../fields/resolver.js'

/**
 * Deciding what goes into each field of a form that is open in a browser.
 *
 * The page says what the form is (`FormField[]`, read by the fill engine); the
 * attempt says what the applicant has answered (`ApplyQuestion[]`); the
 * profile and answer bank cover the rest. This module joins the three and
 * nothing else: it touches no page and no database, so the same decision is
 * made whether a browser extension asked or the agent did.
 *
 * It only ever decides to fill what it can stand behind. Everything else is
 * handed back in `left`, with the reason, for a person.
 *
 * Each field is matched to a canonical field (fields/registry.ts) by its
 * native key, section and wording, and resolved through fields/resolver.ts —
 * the same lookup the write step uses (fields/answerForm.ts), so a question answered
 * through an ATS's API and the same question on the page get the same answer.
 */

export type PlanDocument = 'resume' | 'cover-letter'

/** A value for one field. Documents are named, not inlined: whoever fills the
 * form fetches the bytes when it gets there. */
export type PlanValue = string | boolean | string[] | { file: PlanDocument }

export interface FillStep {
  key: string
  selector: string
  kind: FieldKind
  label: string
  value: PlanValue
  /** Typeaheads only: take the option with this exact text, or the top
   * suggestion for it (a place lookup). */
  pick?: 'exact' | 'first'
  /** `answer`: given for this application. `profile`: the applicant's stored
   * details or answer bank. `document`: the tailored CV or letter. */
  source: 'answer' | 'profile' | 'document'
  /** The canonical field this was matched to, when one was. */
  fieldKey?: string
  /** Which resolver layer the value came from. */
  layer?: ResolutionLayer
  /** `answer` only: the attempt question the value came from, so the
   * executor's source gate can tell the applicant's answers from drafts. */
  questionId?: string
}

export type LeftReason =
  /** Nothing on file answers it. */
  | 'no_answer'
  /** Equal-opportunity and demographic questions are the applicant's to answer. */
  | 'eeo'
  /** So are consents and attestations. */
  | 'consent'
  /** The form says not to touch it. */
  | 'trap'
  /** We hold an answer, but it is not one of the choices offered. */
  | 'no_matching_option'
  /** The applicant set this field to "always ask me". */
  | 'asked'
  /** The applicant set this field to "leave blank", and it is optional. */
  | 'blank'

export interface LeftField {
  key: string
  selector: string
  label: string
  required: boolean
  reason: LeftReason
  /** The canonical field, when the question was recognised. */
  fieldKey?: string
}

export interface FillPlan {
  steps: FillStep[]
  left: LeftField[]
}

export interface PlanInput {
  ats: FormAts
  fields: FormField[]
  /** The attempt's questions, with whatever has been answered so far. */
  questions: ApplyQuestion[]
  profile: ApplicationProfile
  company: string
  /** Whether there is a cover letter to attach or paste. */
  hasCoverLetter: boolean
  coverLetterText: string
  /** The CV the application is built on, for the fields read off it. */
  resume?: ResumeFacts | null
  /** The job, for questions that leave the country to it — and for "how did
   * you hear", which is answered with the board only when there is one. */
  job?: { id?: string; location?: string | null; foundOn?: string | null }
  /** The chosen resume profile's values, by canonical key. */
  overrides?: ApplyContext['overrides']
}

/** Wording that marks a question as a trap for automated applicants. */
const TRAP = /\b(bot[- ]?trap|honeypot|do not (check|tick|select|fill|answer)|leave (this )?(field |box )?(blank|empty|unchecked))\b/i

/** Sections and questions that ask who the applicant is rather than what they
 * can do. Matched on the section heading and the label together. */
const EEO =
  /\b(equal (employment|opportunity)|eeoc?|demographic|self[- ]?identif\w*|voluntary disclosure|gender|sex|race|racial|ethnicit(y|ies)|hispanic|latin[oax]|veteran|disabilit(y|ies)|sexual orientation|transgender|lgbtq\w*|pronouns?)\b/i

/** The form tells automated applicants to leave this one alone. */
export const isTrapField = (field: Pick<FormField, 'label' | 'description'>) => TRAP.test(`${field.label} ${field.description}`)

/** An equal-opportunity or demographic question, by its section and wording. */
export const isEeoField = (field: Pick<FormField, 'section' | 'label'>) => EEO.test(`${field.section} ${field.label}`)

/** A consent or attestation: a lone tick box, or a field the ATS keys as one. */
export const isConsentField = (field: Pick<FormField, 'kind' | 'key'>) => field.kind === 'checkbox' || /^gdpr_|consent/i.test(field.key)

/** A typeahead that searches for a place, where the service's own spelling of
 * the place is the answer and the top suggestion is how a person picks it. */
const PLACE = /^(candidate-location|_systemfield_location|location)$/

function isPlaceLookup(field: FormField): boolean {
  return PLACE.test(field.key) || /^(your )?(current )?(working )?(location|city)\b|\bwhere are you (currently )?(based|located)\b|\bwhat city\b|current (working )?location/i.test(field.label)
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

/** The id the hosted form uses for a prepared question's field. */
function pageKey(questionId: string, ats: FormAts): string {
  // Greenhouse's API calls it `location`; the form's box is `candidate-location`.
  if (ats === 'greenhouse' && questionId === 'location') return 'candidate-location'
  // Lever's API numbers a card's fields 0, 1, …; the form names them field0, field1, ….
  if (ats === 'lever') return questionId.replace(/^(cards\[[^\]]+\])\[(\d+)\]$/, '$1[field$2]')
  return questionId
}

function questionFor(field: FormField, questions: ApplyQuestion[], ats: FormAts): ApplyQuestion | undefined {
  const byKey = questions.find((question) => pageKey(question.id, ats) === field.key)
  if (byKey) return byKey
  // Same wording, and only one question with it: the same question.
  const label = normalize(field.label)
  const sameLabel = questions.filter((question) => normalize(question.label) === label)
  return sameLabel.length === 1 ? sameLabel[0] : undefined
}

const hasAnswer = (question: ApplyQuestion | undefined): question is ApplyQuestion & { answer: string | string[] | boolean } =>
  question?.answer != null && question.answer !== '' && !(Array.isArray(question.answer) && question.answer.length === 0)

function typeFor(kind: FieldKind): ApplyQuestionType {
  switch (kind) {
    case 'textarea':
      return 'textarea'
    case 'select':
    case 'radio':
      return 'select'
    case 'checkboxes':
      return 'multiselect'
    case 'boolean':
    case 'checkbox':
      return 'boolean'
    case 'file':
      return 'file'
    case 'date':
      return 'date'
    default:
      // A typeahead's options are not known until it is open, so its answer
      // travels as text and is matched against the options on the page.
      return 'text'
  }
}

const NO_OPTION = Symbol('no matching option')

/** Fit an answer to the control it is going into. */
function valueFor(
  field: FormField,
  answer: string | string[] | boolean,
): { value: PlanValue; pick?: 'exact' | 'first' } | typeof NO_OPTION {
  const text = typeof answer === 'boolean' ? (answer ? 'Yes' : 'No') : Array.isArray(answer) ? answer.join(', ') : answer

  switch (field.kind) {
    case 'select':
    case 'radio': {
      const option = matchOption(field.options, text)
      return option ? { value: option } : NO_OPTION
    }
    case 'checkboxes': {
      const wanted = Array.isArray(answer) ? answer : text.split(/,\s*/)
      const options = wanted.map((entry) => matchOption(field.options, entry))
      return options.every((option): option is string => option !== null) ? { value: options } : NO_OPTION
    }
    case 'boolean':
    case 'checkbox': {
      if (typeof answer === 'boolean') return { value: answer }
      if (/^(yes|true)$/i.test(text.trim())) return { value: true }
      if (/^(no|false)$/i.test(text.trim())) return { value: false }
      return NO_OPTION
    }
    case 'combobox':
      return { value: text, pick: isPlaceLookup(field) ? 'first' : 'exact' }
    default:
      return { value: text }
  }
}

/** A page field as the resolver reads a question. */
function shapeOf(field: FormField, ats: FormAts, flags: { eeo?: boolean } = {}) {
  return {
    label: field.label,
    description: field.description,
    section: field.section,
    key: field.key,
    ats: ats === 'unknown' ? undefined : ats,
    kind: field.kind,
    options: field.options,
    ...flags,
  }
}

export function planFill(input: PlanInput): FillPlan {
  const steps: FillStep[] = []
  const documents: FillStep[] = []
  const left: LeftField[] = []

  const leave = (field: FormField, reason: LeftReason, fieldKey?: string) =>
    left.push({ key: field.key, selector: field.selector, label: field.label, required: field.required, reason, ...(fieldKey ? { fieldKey } : {}) })
  const fill = (
    field: FormField,
    source: FillStep['source'],
    fitted: { value: PlanValue; pick?: 'exact' | 'first' },
    origin: { fieldKey?: string; layer?: ResolutionLayer; questionId?: string } = {},
  ) =>
    (source === 'document' ? documents : steps).push({
      key: field.key,
      selector: field.selector,
      kind: field.kind,
      label: field.label,
      value: fitted.value,
      ...(fitted.pick ? { pick: fitted.pick } : {}),
      source,
      ...(origin.fieldKey ? { fieldKey: origin.fieldKey } : {}),
      ...(origin.layer ? { layer: origin.layer } : {}),
      ...(origin.questionId ? { questionId: origin.questionId } : {}),
    })
  const context = {
    profile: input.profile,
    company: input.company,
    resume: input.resume ?? null,
    job: input.job ?? null,
    overrides: input.overrides ?? {},
  }

  for (const field of input.fields) {
    if (isTrapField(field)) {
      leave(field, 'trap')
      continue
    }

    if (field.kind === 'file') {
      const text = `${field.key} ${field.label}`
      if (/cover.?letter/i.test(text)) {
        if (input.hasCoverLetter) fill(field, 'document', { value: { file: 'cover-letter' } })
        else leave(field, 'no_answer')
      } else if (/resume|résumé|\bcv\b|curriculum/i.test(text)) {
        fill(field, 'document', { value: { file: 'resume' } })
      } else {
        leave(field, 'no_answer')
      }
      continue
    }

    const question = questionFor(field, input.questions, input.ats)
    const answered = hasAnswer(question)

    // Who the applicant is, and what they agree to, is filled only where they
    // said so — for this application, or (EEO only) in the Field Mapper,
    // where every category is declined until they choose otherwise. Consents
    // never come from anywhere but this application.
    const eeo = question?.kind === 'eeo' || isEeoField(field)
    const consent = question?.kind === 'consent' || isConsentField(field)
    if ((eeo || consent) && !(answered && question.kind)) {
      if (eeo && !consent) {
        const stated = resolveQuestion(shapeOf(field, input.ats, { eeo: true }), context)
        if (stated.value != null) {
          const fitted = valueFor(field, coerce(stated.value, { type: typeFor(field.kind), options: field.options }) ?? '')
          if (fitted !== NO_OPTION && stated.value !== '') {
            fill(field, 'profile', fitted, { fieldKey: stated.classification?.field.key, layer: stated.layer ?? undefined })
            continue
          }
        }
        // Declined with nothing to pick: blank, which an optional survey takes as declined.
        if (stated.decline && !field.required) {
          leave(field, 'blank', stated.classification?.field.key)
          continue
        }
      }
      leave(field, eeo ? 'eeo' : 'consent')
      continue
    }

    if (answered) {
      // A pasted cover letter is the one answer longer than its box may allow;
      // everything else is the applicant's own answer and goes in as given.
      const fitted = valueFor(field, question.answer)
      if (fitted === NO_OPTION) leave(field, 'no_matching_option')
      // An unticked box needs no action, and "No" to a consent is not ticking it.
      else if (!(field.kind === 'checkbox' && fitted.value === false)) fill(field, 'answer', fitted, { questionId: question.id })
      continue
    }

    if (field.kind === 'textarea' && /cover.?letter/i.test(field.label) && input.coverLetterText) {
      fill(field, 'document', { value: input.coverLetterText })
      continue
    }

    // Not asked about at prepare time (the ATS's API did not mention it, or
    // has no API): resolve it from the applicant's data by what the page says.
    const resolution = resolveQuestion(shapeOf(field, input.ats), context)
    const fieldKey = resolution.classification?.field.key
    if (resolution.value == null) {
      if (resolution.reason === 'mode_ask') leave(field, 'asked', fieldKey)
      else if (resolution.reason === 'mode_blank' && !field.required) leave(field, 'blank', fieldKey)
      else leave(field, 'no_answer', fieldKey)
      continue
    }
    const type = typeFor(field.kind)
    const shaped =
      field.options.length && (field.kind === 'select' || field.kind === 'radio' || field.kind === 'checkboxes')
        ? optionFor(field.options, resolution.value, resolution)
        : coerce(resolution.value, { type, options: field.options.length ? field.options : undefined }, resolution)
    if (shaped == null || shaped === '') {
      leave(field, 'no_matching_option', fieldKey)
      continue
    }
    const fitted = valueFor(field, shaped)
    if (fitted === NO_OPTION) leave(field, 'no_matching_option', fieldKey)
    else if (!(field.kind === 'checkbox' && fitted.value === false)) fill(field, 'profile', fitted, { fieldKey, layer: resolution.layer ?? undefined })
  }

  // Documents go last: Greenhouse uploads a file the moment it is attached,
  // so nothing is sent anywhere until the rest of the form has taken.
  return { steps: [...steps, ...documents], left }
}

/** A field nothing is ever put into on the applicant's behalf, even an answer
 * they just gave: a trap, a file, who they are, what they agree to. They fill
 * it on the employer's form themselves. */
export const yoursToAnswer = (field: FormField) =>
  field.kind === 'file' || isTrapField(field) || isEeoField(field) || isConsentField(field)

/**
 * The step that puts an answer the applicant just gave — for a field the plan
 * left to them — into that field, fitted to its control the way their stored
 * answers are. Null when it cannot go in as
 * given: not one of the choices, or a field that is yours to answer.
 */
export function stepForAnswer(field: FormField, answer: string | string[] | boolean): FillStep | null {
  if (yoursToAnswer(field)) return null
  const fitted = valueFor(field, answer)
  if (fitted === NO_OPTION) return null
  return {
    key: field.key,
    selector: field.selector,
    kind: field.kind,
    label: field.label,
    value: fitted.value,
    ...(fitted.pick ? { pick: fitted.pick } : {}),
    source: 'answer',
  }
}

/** A page field as an attempt question, for the answer bank. */
export function questionForField(field: FormField, answer: string | string[] | boolean): ApplyQuestion {
  return {
    id: field.key,
    label: field.label,
    description: field.description,
    type: typeFor(field.kind),
    required: field.required,
    ...(field.options.length ? { options: field.options } : {}),
    answer,
    ...(isEeoField(field) ? { kind: 'eeo' as const } : isConsentField(field) ? { kind: 'consent' as const } : {}),
  }
}

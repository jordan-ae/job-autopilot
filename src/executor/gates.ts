import { squash } from '../text.js'
import { isFormHost } from 'ats-form-fill'
import type { ChallengeSignal, FieldKind, FormField } from 'ats-form-fill'
import type { LeftReason } from '../plan/plan.js'
import type { ApplyQuestion, ApplyQuestionType } from '../types.js'
import type { ChallengeLog, PageRun } from './pageRun.js'

/**
 * Whether a filled form may go on to submit, decided from what the page
 * showed. Pure: no page, no database. Anything not plainly right stops the run
 * and gives the application to a person — the applicant, to answer something
 * or to finish it themselves. A CAPTCHA the browser's solver cleared while the
 * run waited (pageRun.ts) is recorded and passes; one still on screen after
 * the wait, or a check no solver clears (an emailed code, a login), hands the
 * application over.
 */

export type GateName = 'page_open' | 'on_form_host' | 'no_challenge' | 'required_filled' | 'readback' | 'no_validation_error'

export interface GateResult {
  ok: boolean
  /** False when an earlier stop meant this gate was never reached. */
  ran: boolean
  detail: string
  items?: Array<Record<string, string | boolean>>
}

/**
 * - `passed`: every gate held. In a dry run, the run stops here.
 * - `needs_input`: only answers are missing, and the applicant can give them.
 * - `blocked`: a bot check or login wall wants a person.
 * - `hand_back`: anything else that went wrong; the applicant finishes it.
 */
export type GateOutcome = 'passed' | 'needs_input' | 'blocked' | 'hand_back'

export interface GateDecision {
  outcome: GateOutcome
  gates: Record<GateName, GateResult>
  /** One sentence for the applicant. Empty when passed. */
  reason: string
  /**
   * Why a person has to take over, for apply_attempts.blocked_reason: the
   * challenge kind for `blocked`; `off_host`, `closed`, `not_a_form`,
   * `validation`, `readback` or `question` for `hand_back`. The drawer's
   * "Finish this one yourself" copy keys on these. Empty otherwise.
   */
  blockedReason: string
  /** Required fields to ask the applicant about, when `needs_input`. */
  ask: AskField[]
  /** Whether a challenge was seen, and whether it cleared while the run waited. */
  challenge: ChallengeLog
}

export type MissingReason = LeftReason | 'did_not_take'

export interface AskField {
  key: string
  label: string
  reason: MissingReason
}

/** Reasons a person can settle by answering. A trap, or a value the page
 * refused, is not something more answers fix. */
const ASKABLE: ReadonlySet<MissingReason> = new Set(['no_answer', 'no_matching_option', 'eeo', 'consent'])

const CLOSED_STATES = new Set(['closed', 'unknown', 'confirmation'])

const notRun = (detail: string): GateResult => ({ ok: false, ran: false, detail })

export function decideGates(run: PageRun): GateDecision {
  const blocking = [...run.before.challenges, ...run.after.challenges].filter((signal) => signal.state === 'blocking')
  const challenge: GateResult = {
    ok: blocking.length === 0 && run.before.state !== 'challenge' && run.after.state !== 'challenge',
    ran: true,
    detail: blocking.length
      ? `${describeChallenges(blocking)}${run.challenge.waits ? ` (still there after ${run.challenge.waits} wait${run.challenge.waits === 1 ? '' : 's'})` : ''}`
      : run.after.state === 'challenge'
        ? run.after.evidence
        : run.challenge.solved
          ? `${run.challenge.kinds.join(', ')} appeared and cleared after ${Math.round(run.challenge.waitedMs / 1000)}s`
          : 'none on screen',
    ...(blocking.length ? { items: blocking.map((signal) => ({ kind: signal.kind, state: signal.state, evidence: signal.evidence })) } : {}),
  }

  const closedState = CLOSED_STATES.has(run.before.state) ? run.before : CLOSED_STATES.has(run.after.state) ? run.after : null
  const pageOpen: GateResult = {
    ok: closedState === null,
    ran: true,
    detail: closedState ? `${closedState.state}: ${closedState.evidence}` : `${run.before.state} -> ${run.after.state}`,
  }

  const host: GateResult = {
    ok: onFormHost(run.finalUrl, run.hosts),
    ran: true,
    detail: hostOf(run.finalUrl) || 'no address',
  }

  const reached = run.before.state === 'form'
  const gates: Record<GateName, GateResult> = {
    page_open: pageOpen,
    on_form_host: host,
    no_challenge: challenge,
    required_filled: reached ? requiredGate(run) : notRun('the form never opened'),
    readback: reached ? readbackGate(run) : notRun('the form never opened'),
    no_validation_error: validationGate(run),
  }

  const decide = (outcome: GateOutcome, reason: string, extra: Partial<GateDecision> = {}): GateDecision => ({
    outcome,
    gates,
    reason,
    blockedReason: '',
    ask: [],
    challenge: run.challenge,
    ...extra,
  })

  // Most specific first: a bot check explains everything after it.
  if (!challenge.ok) {
    const kind = blocking[0]?.kind ?? 'other-bot-check'
    const reason = run.challenge.waits
      ? `The employer's form showed a ${kind} check that did not clear after waiting. Finish this one yourself.`
      : `The employer's form asked for a person (${kind}). Finish this one yourself.`
    return decide('blocked', reason, {
      blockedReason: kind,
    })
  }
  if (!host.ok) {
    return decide('hand_back', `The form moved to ${host.detail}, which Autopilot does not fill. Finish it yourself.`, { blockedReason: 'off_host' })
  }
  if (!pageOpen.ok) {
    const closed = closedState?.state === 'closed'
    return decide(
      'hand_back',
      closed
        ? 'The employer’s page says this posting is closed. Check it yourself before applying.'
        : 'The employer’s page did not show the application form. Finish it yourself.',
      { blockedReason: closed ? 'closed' : 'not_a_form' },
    )
  }
  if (!gates.no_validation_error.ok) {
    return decide('hand_back', `The form flagged an answer as invalid (${gates.no_validation_error.detail}). Finish it yourself.`, {
      blockedReason: 'validation',
    })
  }
  if (!gates.readback.ok) {
    const count = gates.readback.items?.length ?? 0
    return decide('hand_back', `${count} answer${count === 1 ? '' : 's'} did not stick on the employer's form. Finish it yourself.`, {
      blockedReason: 'readback',
    })
  }
  if (!gates.required_filled.ok) {
    const missing = (gates.required_filled.items ?? []).map((item) => ({
      key: String(item.key),
      label: String(item.label),
      reason: item.reason as MissingReason,
    }))
    if (missing.every((field) => ASKABLE.has(field.reason))) {
      return decide('needs_input', `${missing.length} required question${missing.length === 1 ? '' : 's'} need${missing.length === 1 ? 's' : ''} your answer.`, {
        ask: missing,
      })
    }
    return decide('hand_back', 'Some required questions on the employer’s form can’t be filled automatically. Finish it yourself.', {
      blockedReason: 'question',
    })
  }
  return decide('passed', '')
}

/** No answer flagged invalid, before filling (a form that opens in error) or after. */
function validationGate(run: PageRun): GateResult {
  const flagged = [run.after, run.before].find((page) => page.state === 'validation_error')
  return { ok: !flagged, ran: true, detail: flagged ? flagged.evidence : 'none shown' }
}

/** Every required field must read back non-empty once filling is done. */
function requiredGate(run: PageRun): GateResult {
  const left = new Map(run.left.map((field) => [field.key, field.reason]))
  const tried = new Map(run.filled.map((field) => [field.key, field]))
  const missing = run.readBack
    .filter((field) => field.required && squash(field.observed) === '')
    .map((field) => ({
      key: field.key,
      label: field.label,
      reason: left.get(field.key) ?? (tried.has(field.key) ? 'did_not_take' : 'no_answer'),
    }))
  return {
    ok: missing.length === 0,
    ran: true,
    detail: missing.length ? `${missing.length} required field${missing.length === 1 ? '' : 's'} empty` : `${run.readBack.filter((field) => field.required).length} required, all filled`,
    ...(missing.length ? { items: missing } : {}),
  }
}

/**
 * What we put in is what the page shows. A fill the page refused, or a value
 * the page changed after it took (a framework resetting a controlled input),
 * both fail it.
 */
function readbackGate(run: PageRun): GateResult {
  const final = new Map(run.readBack.map((field) => [field.key, field.observed]))
  const mismatches: Array<Record<string, string | boolean>> = []
  for (const field of run.filled) {
    const now = final.get(field.key) ?? ''
    if (!field.ok) {
      mismatches.push({ key: field.key, label: field.label, required: field.required, why: field.reason || 'not accepted', observed: clip(now) })
      continue
    }
    // Read again once everything is in: a framework that reset a controlled
    // input, or a file chip that disappeared, shows up here.
    if (!sameText(now, field.observed)) {
      mismatches.push({ key: field.key, label: field.label, required: field.required, why: 'changed after filling', observed: clip(now) })
    }
  }
  return {
    ok: mismatches.length === 0,
    ran: true,
    detail: mismatches.length ? `${mismatches.length} of ${run.filled.length} did not stick` : `${run.filled.length} filled, all read back`,
    ...(mismatches.length ? { items: mismatches } : {}),
  }
}

/** The questions to put to the applicant for a `needs_input` outcome, keyed
 * by the page's own field key so planFill matches the answer next run. */
export function askQuestions(ask: AskField[], fields: FormField[], existing: ApplyQuestion[]): ApplyQuestion[] {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const merged = existing.map((question) => ({ ...question }))
  for (const entry of ask) {
    const field = byKey.get(entry.key)
    if (!field) continue
    const question: ApplyQuestion = {
      id: field.key,
      label: field.label,
      type: questionType(field.kind),
      required: true,
      ...(field.options.length ? { options: field.options } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(entry.reason === 'eeo' ? { kind: 'eeo' as const } : entry.reason === 'consent' ? { kind: 'consent' as const } : {}),
      answer: null,
    }
    const index = merged.findIndex((candidate) => candidate.id === field.key)
    if (index >= 0) merged[index] = { ...merged[index], ...question }
    else merged.push(question)
  }
  return merged
}

function questionType(kind: FieldKind): ApplyQuestionType {
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
      return 'text'
  }
}

function describeChallenges(signals: ChallengeSignal[]): string {
  return signals.map((signal) => `${signal.kind}: ${signal.evidence}`).join('; ')
}

function sameText(a: string, b: string): boolean {
  return squash(a).toLowerCase() === squash(b).toLowerCase()
}

/**
 * Is the page where the form should be? One of the fill engine's ATS hosts,
 * or, for an agent-route form (navigator/navigate.ts), the one host
 * navigation found it on: a form that then moves anywhere else is off host.
 */
export function onFormHost(url: string, hosts?: string[]): boolean {
  if (!hosts) return isFormHost(url)
  const host = hostOf(url).toLowerCase()
  return host !== '' && hosts.includes(host)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function clip(text: string, max = 80): string {
  const flat = squash(text)
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

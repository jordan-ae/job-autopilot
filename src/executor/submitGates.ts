import { squash } from '../text.js'
import type { PageClassification } from 'ats-form-fill'
import { fieldByKey } from '../fields/registry.js'
import type { ApplyQuestion } from '../types.js'
import { clip, onFormHost, type GateResult } from './gates.js'
import type { FilledField, PageRun } from './pageRun.js'
import type { SubmitTarget } from './submitControl.js'

/**
 * The pre-submit gates: whether a form that passed the form gates
 * (gates.ts) may have its submit pressed. Pure — every fact is passed
 * in — so each rule is tested on its own and against the captured forms.
 *
 * gates.ts decided "the form is filled and nothing on screen is wrong". These
 * decide "and pressing submit is what the applicant would want": the right
 * values from the right sources, the documents attached, no trap touched,
 * and every limit (caps, budget, eligibility) still allowing it. They are
 * evaluated right before the press, on the page as it is then.
 *
 * Kept in their own file, apart from gates.ts, so changes to the form gates
 * and to these never touch each other.
 */

export type SubmitGateName =
  | 'no_challenge'
  | 'on_form_host'
  | 'job_open'
  | 'no_validation_error'
  | 'required_planned'
  | 'no_trap'
  | 'answer_sources'
  | 'documents_attached'
  | 'submit_control'
  | 'daily_cap'
  | 'company_cap'
  | 'compute_budget'
  | 'eligibility'

/**
 * - `passed`: press it.
 * - `review`: everything is right, but an unreviewed draft is in it; it waits
 *   for the applicant's approval (review first) instead.
 * - `hold`: nothing wrong with the application; a limit says not today
 *   (daily cap). Back in the queue for later.
 * - `needs_input`: only answers are missing.
 * - `blocked`: a bot check wants a person.
 * - `hand_back`: anything else; the applicant finishes it.
 */
export type SubmitGateOutcome = 'passed' | 'review' | 'hold' | 'needs_input' | 'blocked' | 'hand_back'

export interface SubmitGateDecision {
  outcome: SubmitGateOutcome
  gates: Record<SubmitGateName, GateResult>
  reason: string
  /** For apply_attempts.blocked_reason on blocked / hand_back. */
  blockedReason: string
}

export type DraftPolicy = 'review_first' | 'allow' | 'never'

export interface SubmitGateInput {
  run: PageRun
  /** classifyPage once more, right before the press. */
  prePress: PageClassification
  /** The page's address right before the press. */
  prePressUrl: string
  submitTarget: SubmitTarget | null
  questions: ApplyQuestion[]
  /** Question ids the agent answered (payload.fieldMapper.answers). */
  agentQuestionIds: string[]
  /** Of those, the ones the applicant has since approved or corrected. */
  reviewedQuestionIds: string[]
  drafts: {
    policy: DraftPolicy
    /** Drafts the applicant has reviewed so far, across applications. */
    reviewedCount: number
    /** How many to review before unreviewed drafts may go out (review_first). */
    reviewFirst: number
  }
  /** The applicant approved this application (approved_at, or selection's review first). */
  approved: boolean
  documents: { tailoredDocumentId: string | null; resumeFileName: string; coverLetterFileName: string | null; coverLetterText: string }
  job: { active: boolean }
  caps: {
    appliedToday: number
    /** min(daily target, AUTOPILOT_DAILY_CAP). */
    dailyLimit: number
    /** Applications to this company in the window, any origin. */
    companyApplied: number
    companyCap: number
    companyWindowDays: number
  }
  budget: { spentUsd: number; budgetUsd: number; thisRunUsd: number }
  eligibility: {
    matchScore: number | null
    minMatch: number
    /**
     * Selection's verdict, when it wrote one (gate_results.selection.eligibility,
     * or gate_results.eligibility). `unknown` is never hands-free.
     */
    verdict: { eligible: boolean | 'unknown'; reasons?: string[] } | null
  }
}

/**
 * Wording that marks a question as a trap for automated applicants. Wider
 * than plan.ts's (which only decides what to leave alone): any of this on the
 * form puts the whole posting off-limits for Autopilot.
 */
export const TRAP_WORDING =
  /\b(bot[- ]?trap|honey ?pot|do not (check|tick|select|fill|answer)|don['’]t (check|tick|select|fill)|leave (this )?(field |box )?(blank|empty|unchecked)|automatic(ally)? (be )?reject\w*|result in (an )?(automatic )?rejection|warning for humans)\b/i

/** Where a profile-sourced value may come from. `agent` is a draft. */
const STORED_LAYERS = new Set(['job', 'question', 'override', 'identity', 'computed', 'resume', 'answer_bank'])

const BOX_KINDS = new Set(['checkbox', 'checkboxes'])

const ok = (detail: string, items?: GateResult['items']): GateResult => ({ ok: true, ran: true, detail, ...(items ? { items } : {}) })
const bad = (detail: string, items?: GateResult['items']): GateResult => ({ ok: false, ran: true, detail, ...(items ? { items } : {}) })

function sameText(a: string, b: string): boolean {
  return squash(a).toLowerCase() === squash(b).toLowerCase()
}

/** The final read-back says what was planned (actuate.ts matchesIntent's rules). */
export function readsAsPlanned(field: Pick<FilledField, 'kind' | 'planned' | 'pick'>, observed: string): boolean {
  switch (field.kind) {
    case 'checkboxes': {
      const want = field.planned ? field.planned.split(' | ') : []
      const got = observed ? observed.split(' | ') : []
      return want.length === got.length && want.every((text) => got.some((item) => sameText(item, text)))
    }
    case 'combobox':
      return field.pick === 'first' ? squash(observed) !== '' : sameText(observed, field.planned)
    case 'checkbox':
    case 'file':
      return observed === field.planned
    default: {
      if (sameText(observed, field.planned)) return true
      const digits = (text: string) => text.replace(/\D/g, '')
      return digits(field.planned).length >= 7 && digits(observed) === digits(field.planned)
    }
  }
}

function requiredPlannedGate(run: PageRun): GateResult {
  const final = new Map(run.readBack.map((field) => [field.key, field]))
  const items: Array<Record<string, string | boolean>> = []
  for (const field of run.readBack) {
    if (field.required && squash(field.observed) === '') items.push({ key: field.key, label: clip(field.label), why: 'required and empty' })
  }
  for (const field of run.filled) {
    const now = final.get(field.key)?.observed ?? ''
    if (!field.ok || !readsAsPlanned(field, now)) {
      items.push({ key: field.key, label: clip(field.label), why: field.ok ? 'reads back differently from the plan' : 'not accepted', observed: clip(now) })
    }
  }
  return items.length
    ? bad(`${items.length} field${items.length === 1 ? '' : 's'} not as planned`, items)
    : ok(`${run.filled.length} filled as planned, ${run.readBack.filter((field) => field.required).length} required present`)
}

/**
 * No trap touched, and nothing ticked we did not mean to tick. A posting with
 * trap wording anywhere is off-limits. (One captured Ashby form has a box
 * whose help text says ticking it means automatic rejection.)
 */
function trapGate(run: PageRun): GateResult {
  const items: Array<Record<string, string | boolean>> = []
  for (const field of run.fields) {
    const text = `${field.label} ${field.description}`
    if (TRAP_WORDING.test(text)) items.push({ key: field.key, label: clip(field.label), why: 'trap wording', evidence: clip(text.match(TRAP_WORDING)?.[0] ?? '', 60) })
  }
  const planned = new Set(run.filled.map((field) => field.key))
  for (const field of run.readBack) {
    if (!BOX_KINDS.has(field.kind) || planned.has(field.key)) continue
    if (squash(field.observed) !== '') items.push({ key: field.key, label: clip(field.label), why: 'ticked but never planned', observed: clip(field.observed) })
  }
  return items.length ? bad(`${items.length} trap or unplanned box${items.length === 1 ? '' : 'es'}`, items) : ok('no trap wording, no unplanned box ticked')
}

interface SourceCheck {
  gate: GateResult
  /** An unreviewed draft is the only problem: approval settles it. */
  needsReview: boolean
}

/**
 * Every value from an allowed source. The applicant's own answers and stored
 * data always are. A value the agent produced is a draft: a factual or legal
 * field (anything the registry does not mark draftable) must never come from
 * one; an essay may, once reviewed — or unreviewed, if the applicant allows it.
 */
function sourcesGate(input: SubmitGateInput): SourceCheck {
  const agent = new Set(input.agentQuestionIds)
  const reviewed = new Set(input.reviewedQuestionIds)
  const { policy, reviewedCount, reviewFirst } = input.drafts
  const draftsAllowed =
    input.approved || policy === 'allow' || (policy === 'review_first' && reviewedCount >= reviewFirst)

  const forbidden: Array<Record<string, string | boolean>> = []
  const unreviewed: Array<Record<string, string | boolean>> = []
  let drafts = 0
  for (const field of input.run.filled) {
    if (field.source === 'document') continue
    const isDraft = field.source === 'answer' ? Boolean(field.questionId && agent.has(field.questionId)) : field.layer !== undefined && !STORED_LAYERS.has(field.layer)
    if (!isDraft) continue
    drafts++
    const canonical = field.fieldKey ? fieldByKey(field.fieldKey) : undefined
    if (canonical && !canonical.draftable) {
      forbidden.push({ key: field.key, label: clip(field.label), why: `${canonical.key} must come from stored data` })
      continue
    }
    if (field.kind !== 'textarea' && field.kind !== 'text') {
      forbidden.push({ key: field.key, label: clip(field.label), why: 'a choice the agent made' })
      continue
    }
    if (field.questionId && reviewed.has(field.questionId)) continue
    if (policy === 'never' && !input.approved) {
      forbidden.push({ key: field.key, label: clip(field.label), why: 'unreviewed draft; drafts need review' })
      continue
    }
    if (!draftsAllowed) unreviewed.push({ key: field.key, label: clip(field.label), why: 'unreviewed draft' })
  }
  if (forbidden.length) return { gate: bad(`${forbidden.length} value${forbidden.length === 1 ? '' : 's'} from a source not allowed`, [...forbidden, ...unreviewed]), needsReview: false }
  if (unreviewed.length) {
    return {
      gate: bad(`${unreviewed.length} drafted answer${unreviewed.length === 1 ? '' : 's'} not reviewed (${reviewedCount}/${reviewFirst} reviewed so far)`, unreviewed),
      needsReview: true,
    }
  }
  return { gate: ok(drafts ? `stored data and answers; ${drafts} reviewed or allowed draft${drafts === 1 ? '' : 's'}` : 'stored data and the applicant’s answers only'), needsReview: false }
}

const RESUME = /resume|résumé|\bcv\b|curriculum/i
const LETTER = /cover.?letter/i

function documentsGate(input: SubmitGateInput): GateResult {
  const { run, documents } = input
  if (!documents.tailoredDocumentId) return bad('no tailored CV on this application')
  const final = new Map(run.readBack.map((field) => [field.key, field.observed]))
  const files = run.fields.filter((field) => field.kind === 'file')
  const items: Array<Record<string, string | boolean>> = []

  const resumeFields = files.filter((field) => RESUME.test(`${field.key} ${field.label}`) && !LETTER.test(`${field.key} ${field.label}`))
  for (const field of resumeFields) {
    if (final.get(field.key) !== documents.resumeFileName) items.push({ key: field.key, label: clip(field.label), why: 'tailored CV not attached', observed: clip(final.get(field.key) ?? '') })
  }
  const letterFields = files.filter((field) => LETTER.test(`${field.key} ${field.label}`))
  if (documents.coverLetterFileName) {
    for (const field of letterFields) {
      if (final.get(field.key) !== documents.coverLetterFileName) items.push({ key: field.key, label: clip(field.label), why: 'letter not attached', observed: clip(final.get(field.key) ?? '') })
    }
  }
  const pasted = run.fields.filter((field) => field.kind === 'textarea' && LETTER.test(field.label))
  if (documents.coverLetterText.trim() && letterFields.length === 0) {
    for (const field of pasted) {
      if (squash(final.get(field.key) ?? '') === '') items.push({ key: field.key, label: clip(field.label), why: 'letter not pasted' })
    }
  }
  if (items.length) return bad(`${items.length} document${items.length === 1 ? '' : 's'} missing`, items)
  if (resumeFields.length === 0) return ok('the form takes no CV upload; the tailored CV is on file')
  return ok(`CV attached${documents.coverLetterFileName && letterFields.length ? ', letter attached' : ''}`)
}

function capsGate(input: SubmitGateInput): { daily: GateResult; company: GateResult } {
  const { caps } = input
  const daily =
    caps.appliedToday < caps.dailyLimit
      ? ok(`${caps.appliedToday} of ${caps.dailyLimit} today`)
      : bad(`${caps.appliedToday} of ${caps.dailyLimit} sent today`)
  const company =
    caps.companyApplied < caps.companyCap
      ? ok(`${caps.companyApplied} of ${caps.companyCap} to this company in ${caps.companyWindowDays} days`)
      : bad(`already ${caps.companyApplied} application${caps.companyApplied === 1 ? '' : 's'} to this company in ${caps.companyWindowDays} days (cap ${caps.companyCap})`)
  return { daily, company }
}

function budgetGate(input: SubmitGateInput): GateResult {
  const { spentUsd, budgetUsd, thisRunUsd } = input.budget
  const total = spentUsd + thisRunUsd
  if (budgetUsd <= 0) return bad('the monthly compute budget is switched off')
  return total <= budgetUsd
    ? ok(`$${total.toFixed(3)} of $${budgetUsd.toFixed(2)} this month`)
    : bad(`$${total.toFixed(3)} would pass this month’s $${budgetUsd.toFixed(2)}`)
}

/** Selection's verdict and match score, when the attempt has them (absent = pass). */
function eligibilityGate(input: SubmitGateInput): GateResult {
  const { matchScore, minMatch, verdict } = input.eligibility
  if (verdict?.eligible === 'unknown' && !input.approved) return bad('eligibility unknown: needs your approval')
  if (verdict && verdict.eligible === false) return bad(`not eligible: ${(verdict.reasons ?? []).join('; ') || 'selection said no'}`)
  if (matchScore !== null && matchScore < minMatch) return bad(`match ${matchScore.toFixed(2)} is under the ${minMatch.toFixed(2)} minimum`)
  if (matchScore === null && !verdict) return ok('no selection data on this attempt')
  return ok(`${verdict ? 'eligible' : 'no eligibility verdict'}${matchScore !== null ? `, match ${matchScore.toFixed(2)}` : ''}`)
}

function submitControlGate(target: SubmitTarget | null): GateResult {
  if (!target) return bad('no submit button found')
  if (target.disabled) return bad(`the submit button is disabled ("${target.text}")`)
  if (target.count > 1) return bad(`${target.count} submit buttons; not sure which one`)
  return ok(`"${target.text}"`)
}

export function decideSubmitGates(input: SubmitGateInput): SubmitGateDecision {
  const blocking = input.prePress.challenges.filter((signal) => signal.state === 'blocking')
  const challenge = blocking.length || input.prePress.state === 'challenge'
    ? bad(blocking.map((signal) => `${signal.kind}: ${signal.evidence}`).join('; ') || input.prePress.evidence)
    : ok('none on screen')
  const host = onFormHost(input.prePressUrl, input.run.hosts) ? ok(hostOf(input.prePressUrl)) : bad(hostOf(input.prePressUrl) || 'no address')
  const closed = input.prePress.state === 'closed' || !input.job.active
  const jobOpen = closed ? bad(input.job.active ? `the page says closed: ${input.prePress.evidence}` : 'the posting is marked closed') : ok('still open')
  const validation = input.prePress.state === 'validation_error' || input.run.after.state === 'validation_error'
    ? bad(input.prePress.state === 'validation_error' ? input.prePress.evidence : input.run.after.evidence)
    : ok('none shown')
  const sources = sourcesGate(input)
  const caps = capsGate(input)

  const gates: Record<SubmitGateName, GateResult> = {
    no_challenge: challenge,
    on_form_host: host,
    job_open: jobOpen,
    no_validation_error: validation,
    required_planned: requiredPlannedGate(input.run),
    no_trap: trapGate(input.run),
    answer_sources: sources.gate,
    documents_attached: documentsGate(input),
    submit_control: submitControlGate(input.submitTarget),
    daily_cap: caps.daily,
    company_cap: caps.company,
    compute_budget: budgetGate(input),
    eligibility: eligibilityGate(input),
  }

  const decide = (outcome: SubmitGateOutcome, reason: string, blockedReason = ''): SubmitGateDecision => ({ outcome, gates, reason, blockedReason })

  // Most specific first, as in gates.ts. A trap goes before everything the
  // page could explain, because it makes the whole posting off-limits.
  if (!gates.no_challenge.ok) {
    const kind = blocking[0]?.kind ?? 'other-bot-check'
    return decide('blocked', `The employer's form asked for a person (${kind}) before submit. Finish this one yourself.`, kind)
  }
  if (!gates.no_trap.ok) {
    return decide('hand_back', 'This form has a question meant to catch automated applications, so Autopilot will not submit it. Finish it yourself.', 'trap')
  }
  if (!gates.on_form_host.ok) return decide('hand_back', `The form moved to ${gates.on_form_host.detail}, which Autopilot does not submit on. Finish it yourself.`, 'off_host')
  if (!gates.job_open.ok) return decide('hand_back', 'This posting looks closed now. Check it yourself before applying.', 'closed')
  if (!gates.no_validation_error.ok) return decide('hand_back', `The form flagged an answer as invalid (${gates.no_validation_error.detail}). Finish it yourself.`, 'validation')
  if (!gates.required_planned.ok) return decide('hand_back', 'Some answers on the form are not what Autopilot planned to send. Finish it yourself.', 'readback')
  if (!gates.answer_sources.ok && !sources.needsReview) {
    return decide('hand_back', 'An answer would have come from somewhere other than your saved details. Finish it yourself.', 'source')
  }
  if (!gates.documents_attached.ok) return decide('hand_back', 'Your tailored CV or letter did not attach. Finish it yourself.', 'documents')
  if (!gates.submit_control.ok) return decide('hand_back', `Autopilot could not find the form's submit button (${gates.submit_control.detail}). Finish it yourself.`, 'no_submit')
  const eligibilityUnknown = input.eligibility.verdict?.eligible === 'unknown'
  if (!gates.eligibility.ok && !eligibilityUnknown) {
    return decide('hand_back', `This job no longer fits what you asked Autopilot for (${gates.eligibility.detail}).`, 'not_eligible')
  }
  if (!gates.company_cap.ok) return decide('hand_back', `You've applied to this company recently (${gates.company_cap.detail}). Autopilot sends one at a time; apply yourself if you want to.`, 'company_cap')
  if (!gates.compute_budget.ok) return decide('hand_back', "This month's Autopilot compute budget is used up. Finish this one yourself.", 'budget')
  if (!gates.daily_cap.ok) return decide('hold', `Today's limit is reached (${gates.daily_cap.detail}). It goes out on the next active day.`)
  if (sources.needsReview) return decide('review', 'Autopilot drafted an answer you have not reviewed. Approve the application to send it.')
  if (!gates.eligibility.ok) return decide('review', "Autopilot couldn't tell whether this employer can hire from where you are. Approve it to send it anyway.")
  return decide('passed', '')
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/**
 * An employer's own cap stated on the page ("Candidates may not apply more
 * than 3 times in any 60 days", "five applications per candidate per 180
 * days"), so the company gate can use the stricter of it and ours. The
 * same-role re-apply rule ("re-apply to the same role within 180 days") is
 * already covered: Autopilot applies to a job once.
 */
export function statedCompanyCap(text: string): { cap: number; days: number } | null {
  const rx =
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:times|applications?)(?:\s+per\s+candidate)?\s+(?:per|every|in|within|over)\s+(?:a\s+|any\s+)?(?:period\s+of\s+)?(\d{1,3})[-\s]days?\b/gi
  let best: { cap: number; days: number } | null = null
  for (const match of text.matchAll(rx)) {
    const before = text.slice(Math.max(0, match.index - 60), match.index)
    if (/re-?apply/i.test(before)) continue
    const raw = match[1].toLowerCase()
    const cap = NUMBER_WORDS[raw] ?? Number(raw)
    const days = Number(match[2])
    if (!(cap > 0 && days > 0)) continue
    if (!best || cap / days < best.cap / best.days) best = { cap, days }
  }
  return best
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

import type { FileValue, FillValue } from 'ats-form-fill'
import type { ChallengeKind, FieldKind, FormAts, FormField, PageClassification } from 'ats-form-fill'
import { planFill, type FillStep, type LeftField, type PlanInput } from '../plan/plan.js'
import type { ApplicationProfile, ApplyQuestion } from '../types.js'
import type { FormDriver } from './driver.js'

/**
 * One pass over an open application form: look, fill, read everything back,
 * look again. Never presses submit: there is no call here that could (the
 * one press is submit.ts's). What to make of the result is gates.ts's job.
 *
 * A challenge on screen is waited out only when the browser session clears
 * them by itself (BrowserSession.solvesCaptchas): the page is left alone — no
 * clicks, no reload — for about ten seconds, then looked at again, twice at
 * most. What happened is kept in `challenge` for the gate results.
 */

/** The job, CV and profile overrides ride along: the page asks things the
 * prepare step never saw, and they are answered from the same data. */
export interface PageRunInput extends Pick<PlanInput, 'job' | 'resume' | 'overrides'> {
  ats: FormAts
  questions: ApplyQuestion[]
  profile: ApplicationProfile
  company: string
  coverLetterText: string
  documents: { resume: FileValue; coverLetter: FileValue | null }
  /** How to wait for the browser's CAPTCHA solver. No waits when it has none. */
  challengeWait?: { waits: number; ms: number }
  /** The agent route's form: the one host it may be on (gates.ts onFormHost). */
  hosts?: string[]
}

/** What the run saw of challenges that a person would otherwise have to clear. */
export interface ChallengeLog {
  seen: boolean
  /** Seen, and gone after waiting. */
  solved: boolean
  kinds: ChallengeKind[]
  waits: number
  waitedMs: number
}

export interface FilledField {
  key: string
  label: string
  kind: FieldKind
  required: boolean
  source: FillStep['source']
  ok: boolean
  /** What the control showed straight after it was filled. */
  observed: string
  reason: string
  /** What was meant to go in, as the control would show it ('checked' for a
   * ticked box, the file's name for a document). The submit gates compare the
   * final read-back with this. */
  planned: string
  /** Typeaheads only, from the plan. */
  pick?: FillStep['pick']
  /** Where the value came from, for the submit gates' source check. */
  questionId?: string
  fieldKey?: string
  layer?: FillStep['layer']
}

export interface ReadBack {
  key: string
  label: string
  kind: FieldKind
  required: boolean
  /** What the control shows once everything is in. */
  observed: string
}

export interface PageRun {
  before: PageClassification
  /** Empty when the page was not a form to begin with. */
  fields: FormField[]
  filled: FilledField[]
  left: LeftField[]
  readBack: ReadBack[]
  after: PageClassification
  /** The page's address at the end, for the host guard. */
  finalUrl: string
  fillMs: number
  challenge: ChallengeLog
  /** From the input: set for an agent-route form, whose host is not one of FORM_HOSTS. */
  hosts?: string[]
}

/** Checks the solver can clear. A code sent by email, or a login, is not one of them. */
const SOLVABLE: ReadonlySet<ChallengeKind> = new Set([
  'recaptcha-enterprise',
  'recaptcha-v3',
  'recaptcha-v2',
  'hcaptcha',
  'turnstile',
  'cloudflare-interstitial',
  'other-bot-check',
])

const blockingKinds = (page: PageClassification): ChallengeKind[] =>
  page.challenges.filter((signal) => signal.state === 'blocking').map((signal) => signal.kind)

/**
 * Leave a page showing a solvable challenge alone while the solver works, and
 * look again. Returns the page as it is afterwards.
 */
async function waitOutChallenge(
  driver: FormDriver,
  page: PageClassification,
  wait: PageRunInput['challengeWait'],
  log: ChallengeLog,
  now: () => number,
): Promise<PageClassification> {
  let kinds = blockingKinds(page)
  if (kinds.length === 0) return page
  log.seen = true
  for (const kind of kinds) if (!log.kinds.includes(kind)) log.kinds.push(kind)
  if (!wait || wait.waits <= 0 || !kinds.every((kind) => SOLVABLE.has(kind))) return page

  let current = page
  for (let attempt = 0; attempt < wait.waits && kinds.length > 0; attempt++) {
    const started = now()
    await driver.settle(wait.ms)
    log.waits++
    log.waitedMs += now() - started
    current = await driver.classifyPage()
    kinds = blockingKinds(current)
  }
  if (kinds.length === 0) log.solved = true
  return current
}

/** How long the page gets to commit the last value before it is read back. */
const SETTLE_MS = 800

export async function runPage(driver: FormDriver, input: PageRunInput, now: () => number = Date.now): Promise<PageRun> {
  const challenge: ChallengeLog = { seen: false, solved: false, kinds: [], waits: 0, waitedMs: 0 }
  const before = await waitOutChallenge(driver, await driver.classifyPage(), input.challengeWait, challenge, now)
  // A wall, a closed posting or an error page: nothing is typed into it.
  if (before.state !== 'form') {
    return { before, fields: [], filled: [], left: [], readBack: [], after: before, finalUrl: driver.url(), fillMs: 0, challenge, ...(input.hosts ? { hosts: input.hosts } : {}) }
  }

  const fields = await driver.extractFormFields()
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const plan = planFill({
    ats: input.ats,
    fields,
    questions: input.questions,
    profile: input.profile,
    company: input.company,
    hasCoverLetter: input.documents.coverLetter !== null,
    coverLetterText: input.coverLetterText,
    job: input.job,
    resume: input.resume,
    overrides: input.overrides,
  })

  const started = now()
  const filled: FilledField[] = []
  for (const step of plan.steps) {
    const value = resolveValue(step, input.documents)
    if (value === null) continue
    const result = await driver.fillField(step, value, step.pick ? { pick: step.pick } : {})
    filled.push({
      key: step.key,
      label: step.label,
      kind: step.kind,
      required: byKey.get(step.key)?.required ?? false,
      source: step.source,
      ok: result.ok,
      observed: result.observed,
      reason: result.reason,
      planned: plannedText(step, value),
      ...(step.pick ? { pick: step.pick } : {}),
      ...(step.questionId ? { questionId: step.questionId } : {}),
      ...(step.fieldKey ? { fieldKey: step.fieldKey } : {}),
      ...(step.layer ? { layer: step.layer } : {}),
    })
  }
  const fillMs = now() - started

  await driver.settle(SETTLE_MS)
  const readAll = async () => {
    const values: ReadBack[] = []
    for (const field of fields) {
      values.push({ key: field.key, label: field.label, kind: field.kind, required: field.required, observed: await driver.readField(field) })
    }
    return values
  }
  let readBack = await readAll()
  const shown = await driver.classifyPage()
  const after = await waitOutChallenge(driver, shown, input.challengeWait, challenge, now)
  // The page changed under the solver; read again what it shows now.
  if (after !== shown) readBack = await readAll()
  return { before, fields, filled, left: plan.left, readBack, after, finalUrl: driver.url(), fillMs, challenge, ...(input.hosts ? { hosts: input.hosts } : {}) }
}

function resolveValue(step: FillStep, documents: PageRunInput['documents']): FillValue | null {
  if (typeof step.value === 'object' && !Array.isArray(step.value)) {
    return step.value.file === 'resume' ? documents.resume : documents.coverLetter
  }
  return step.value
}

/** A planned value as readField would show it once it took. */
export function plannedText(step: Pick<FillStep, 'kind'>, value: FillValue): string {
  if (typeof value === 'object' && !Array.isArray(value)) return value.fileName
  if (Array.isArray(value)) return value.join(' | ')
  if (typeof value === 'boolean') {
    if (step.kind === 'checkbox') return value ? 'checked' : ''
    return value ? 'Yes' : 'No'
  }
  return value
}

import type { Attempt } from '../attempt.js'
import type { AgentRunRecord } from '../fields/agentRun.js'
import type { BrowserSession, OpenBrowserOptions } from '../browser/provider.js'
import { formUrl, type FileValue, type FormAts, type FormField, type PostingRef } from 'ats-form-fill'
import type { NavOutcome } from '../navigator/navigate.js'
import { unansweredRequired } from '../plan/answers.js'
import type { WriteResult } from '../store/types.js'
import type { ApplyContext, ApplyExecutor, ApplyQuestion, AttemptStatus } from '../types.js'
import { runCost } from './cost.js'
import type { FormDriver } from './driver.js'
import { askQuestions, clip, decideGates, type GateDecision } from './gates.js'
import { runPage, type PageRun } from './pageRun.js'
import { KEEP_REPORTS, type ExecutionReport } from './report.js'
import { finishWithoutHold, runSubmitPhase, type SubmitFinish, type SubmitRunDeps } from './submitRun.js'

/**
 * Carry one claimed attempt through a browser: find the form (the navigator,
 * when the posting is not on a form the fill engine knows), write what the
 * stored data does not answer (the agent pass, `deps.answer`), fill the form
 * from the attempt's answers and documents, read every field back and run the
 * form gates (gates.ts). What happens after that is submitRun.ts's: stop (a
 * dry run), wait for approval, or — with every switch on and every pre-submit
 * gate passed — press submit once and read what the page says. Without
 * `deps.submit` a run is always a dry run.
 *
 * One browser session per application, released on every way out of this
 * function, including the ones that throw. The result is written under the
 * worker's lease, with what the run cost added to `cost_usd`.
 */

export interface PreparedRun {
  /** The fill-engine form. Null on the agent route until navigation finds one. */
  ref: PostingRef | null
  /** The agent route (src/navigator/): where navigation starts. */
  agent?: { startUrl: string }
  ctx: ApplyContext
  documents: { resume: FileValue; coverLetter: FileValue | null }
}

export type PrepareResult =
  | { ok: true; run: PreparedRun }
  | { ok: false; kind: 'unsupported' | 'retry'; reason: string }
  /** The posting's link is an account or login wall: the applicant files it. */
  | { ok: false; kind: 'walled'; reason: string; code: string }

/** What the write step produced for one form. */
export interface WrittenAnswers {
  /** The attempt's questions, with the agent's answers in them. */
  questions: ApplyQuestion[]
  /** What the agent pass did, kept on the attempt (payload.fieldMapper). Its drafts are what the source gate checks. */
  record: AgentRunRecord | null
  /** Model spend, added to the run's cost. */
  costUsd: number
}

export interface ExecutorDeps {
  /** This worker's lease_owner. */
  owner: string
  leaseSeconds: number
  /** Runs an attempt may have (counting this one) before it goes to the user. */
  maxRuns: number
  now(): number
  /** May this applicant's attempts run at all? */
  allowed(userId: string): Promise<boolean>
  prepare(attempt: Attempt): Promise<PrepareResult>
  openSession(options: OpenBrowserOptions): Promise<BrowserSession>
  openForm(session: BrowserSession, url: string, ats: PostingRef['ats']): Promise<FormDriver>
  /** The agent route: from the posting's page to its form (navigator/navigate.ts). */
  navigate(session: BrowserSession, startUrl: string): Promise<NavOutcome>
  /**
   * The write step: the form's fields that stored data does not answer, put
   * to the agent pass (fields/agent.ts). Absent: the form is filled from
   * stored data and the attempt's answers only.
   */
  answer?(input: { attempt: Attempt; fields: FormField[]; ats: FormAts; prepared: PreparedRun }): Promise<WrittenAnswers>
  /** May a form on a host with no fill-engine driver be submitted? Off unless asked for. */
  agentSubmit: boolean
  /** Give back what was held for an attempt that leaves the agent's hands unsent (store/types.ts BillingHooks). */
  settle(attemptId: string, why: string): Promise<void>
  write(attemptId: string, owner: string, patch: Partial<Attempt>): Promise<WriteResult>
  /** Pressing submit. Absent: every run is a dry run. */
  submit?: SubmitRunDeps
}

export const MAX_EXECUTOR_RUNS = 3
/** How long a held attempt (paused, off, breaker open) waits before it is looked at again. */
export const HOLD_BACKOFF_MS = 15 * 60_000
/** How long a failed run waits before the next, times the runs so far. */
export const RETRY_BACKOFF_MS = 2 * 60_000
/** Waiting on a browser that clears CAPTCHAs itself: about ten seconds, then once more. */
export const CHALLENGE_WAIT = { waits: 2, ms: 10_000 }

class Deadline extends Error {}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline(`run took longer than ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Where an outcome sends the attempt, and whether its credit goes back. */
export interface Finish {
  outcome: ExecutionReport['outcome']
  status: AttemptStatus
  reason: string
  error: string
  /** Set when the attempt changes hands. */
  executor?: ApplyExecutor
  blockedReason?: string
  questions?: ApplyQuestion[]
  release: boolean
  /** The application was filed, so what was held for it is spent. */
  charge?: boolean
  /** The status the write is guarded on: `submitting` once submit was pressed. */
  from?: 'preparing' | 'submitting'
  /** Back in the queue no earlier than this (ms). Default: the retry backoff. */
  readyAt?: number
  /** The claim's run does not count against the attempt (a hold). */
  uncount?: boolean
  /** Further columns to write (submitted_at, confirmation, application_id). */
  columns?: Record<string, unknown>
}

/**
 * "Finish this one yourself": `blocked`, with a code in blocked_reason saying
 * why. The applicant carries it from here, so anything held for it goes back.
 */
export const handBack = (outcome: Finish['outcome'], reason: string, code: string): Finish => ({
  outcome,
  status: 'blocked',
  executor: 'assisted',
  blockedReason: code,
  reason,
  error: reason,
  release: true,
})

function finishFor(decision: GateDecision, run: PageRun, attempt: Attempt): Finish {
  switch (decision.outcome) {
    case 'passed':
      // A dry run stops here: everything was filled and checked, nothing was
      // sent. Nothing went wrong either, so it is not a hand-off: it waits
      // for the applicant, to file on the employer's site.
      return {
        outcome: 'passed',
        status: 'awaiting_approval',
        executor: 'assisted',
        reason: 'Dry run: Autopilot filled and checked every field, then stopped before submit.',
        error: '',
        release: true,
      }
    case 'needs_input':
      return {
        outcome: 'needs_input',
        status: 'needs_input',
        reason: decision.reason,
        error: '',
        questions: askQuestions(decision.ask, run.fields, attempt.payload?.questions ?? []),
        release: false,
      }
    case 'blocked':
      return handBack('blocked', decision.reason, decision.blockedReason)
    case 'hand_back':
      return handBack('hand_back', decision.reason, decision.blockedReason)
  }
}

export async function runClaimedAttempt(claimed: Attempt, deps: ExecutorDeps): Promise<ExecutionReport> {
  // Replaced once the write step has answered the form, so the gates and the
  // stored result see the agent's answers.
  let attempt = claimed
  const started = deps.now()
  let modelUsd = 0
  const report: ExecutionReport = {
    version: 1,
    mode: 'dry_run',
    worker: deps.owner,
    run: attempt.attempts,
    provider: '',
    sessionId: '',
    formUrl: '',
    finalUrl: '',
    startedAt: new Date(started).toISOString(),
    finishedAt: '',
    durationMs: 0,
    timings: { documentsMs: 0, browserOpenMs: 0, navigateMs: 0, fillMs: 0, checkMs: 0 },
    browserMs: 0,
    cost: runCost({ provider: '', browserMs: 0 }),
    outcome: 'retry',
    status: 'ready',
    reason: '',
    error: '',
    page: null,
    challenges: [],
    challenge: null,
    counts: { fields: 0, required: 0, filled: 0, failed: 0, left: 0 },
    filled: [],
    left: [],
    gates: null,
  }

  let session: BrowserSession | null = null
  let browserStarted = 0
  let reportedUsd: number | null = null
  const release = async () => {
    if (!session) return
    const open = session
    session = null
    const closed = await open.close().catch((error: Error) => {
      console.warn(`[executor] closing the browser failed: ${error.message}`)
      return null
    })
    reportedUsd = closed?.costUsd ?? null
    report.browserMs = deps.now() - browserStarted
  }

  let finish: Finish
  // Set once submit_clicked_at is written, before the press. From
  // then on no failure of ours may put the attempt back in the queue.
  const pressed = { value: false, clickedAt: '' }
  const submitted: { value: SubmitFinish | null } = { value: null }
  try {
    finish = await (async (): Promise<Finish> => {
      if (!(await deps.allowed(attempt.client_key))) {
        return handBack('not_allowed', 'Autopilot is not open to this account. Finish this one yourself.', 'not_allowed')
      }
      // The claim never hands one out; this is the last line behind it.
      if (attempt.submit_clicked_at) {
        return { outcome: 'unconfirmed', status: 'unconfirmed', reason: 'Submit was already pressed on this one.', error: '', release: false }
      }

      let context = deps.submit ? await deps.submit.context(attempt) : null
      report.mode = context?.policy.mode ?? 'dry_run'
      // Paused, off, or the breaker is open: back to the queue without opening
      // a browser, and without using up one of the attempt's runs.
      if (context?.policy.mode === 'hold') {
        return { outcome: 'hold', status: 'ready', reason: context.policy.reason, error: '', release: false, readyAt: deps.now() + HOLD_BACKOFF_MS, uncount: true }
      }
      // A run that may press submit needs a live credit hold. Checked here
      // first, so an attempt whose credit is gone and can't be taken again
      // costs no browser; checked again right before the press (submitRun.ts).
      if (context?.policy.mode === 'submit' && deps.submit) {
        const withoutHold = finishWithoutHold(await deps.submit.holdCredit(attempt))
        if (withoutHold) return withoutHold
      }

      const prepared = await deps.prepare(attempt)
      report.timings.documentsMs = deps.now() - started
      if (!prepared.ok) {
        if (prepared.kind === 'unsupported') return handBack('unsupported', prepared.reason, 'unsupported')
        if (prepared.kind === 'walled') return handBack('hand_back', prepared.reason, prepared.code)
        throw new Error(prepared.reason)
      }
      const { ctx, documents } = prepared.run
      report.formUrl = prepared.run.ref ? formUrl(prepared.run.ref) : (prepared.run.agent?.startUrl ?? '')

      // The browser is told to stop a minute before the lease runs out, and
      // the work below gives up a little before that, so a run never outlives
      // the claim that lets it write.
      browserStarted = deps.now()
      session = await deps.openSession({ timeoutSeconds: deps.leaseSeconds - 60, record: false })
      report.provider = session.provider
      report.sessionId = session.sessionId
      report.timings.browserOpenMs = deps.now() - browserStarted

      try {
        const budgetMs = (deps.leaseSeconds - 75) * 1000 - (deps.now() - browserStarted)
        const navigated = deps.now()
        let ats: FormAts | null = null
        let driver: FormDriver | null = null
        // Set on the agent route's own forms: the only host the gates accept.
        let hosts: string[] | undefined
        let ref = prepared.run.ref
        if (!ref && prepared.run.agent) {
          const nav = await withDeadline(deps.navigate(session, prepared.run.agent.startUrl), budgetMs)
          report.navigation = { outcome: nav.kind, url: nav.kind === 'ref' ? '' : nav.url, hops: nav.hops }
          if (nav.kind === 'wall') {
            return handBack(
              'hand_back',
              nav.wall.code === 'account_required'
                ? "The employer's site wants you to create an account before applying, so Autopilot left it for you."
                : 'The site wants you signed in before applying, so Autopilot left it for you.',
              nav.wall.code,
            )
          }
          if (nav.kind === 'lost') return handBack('hand_back', `Autopilot could not find the application form (${nav.detail}). Finish it yourself.`, 'not_a_form')
          if (nav.kind === 'ref') ref = nav.ref
          // Several pages, each sent to the employer on Next: not filled.
          // Handed back before anything is typed or asked.
          else if (nav.multiStep) {
            return handBack('hand_back', "This employer's form runs over several pages, which Autopilot does not fill yet. Finish it yourself.", 'multi_step')
          } else {
            ats = 'unknown'
            driver = nav.driver
            hosts = [nav.host]
            report.finalUrl = nav.url
          }
        }
        if (ref) {
          report.formUrl = formUrl(ref)
          ats = ref.ats
          driver = await withDeadline(deps.openForm(session, report.formUrl, ref.ats), budgetMs)
        }
        if (!driver || !ats) throw new Error('prepared run has neither a form nor a start page')
        // Rehearse, not press, on a form whose host has no fill-engine driver,
        // unless agent submit is switched on as well.
        if (hosts && context?.policy.mode === 'submit' && !deps.agentSubmit) {
          context = { ...context, policy: { mode: 'rehearse', reason: 'Agent-route form: every gate and the screenshot, then stop (agent submit is off).' } }
          report.mode = 'rehearse'
        }
        report.timings.navigateMs = deps.now() - navigated

        // The write step: what the page asks that nothing stored answers goes
        // to the agent pass, before anything is typed. Its drafts ride on the
        // attempt as answers, marked as the agent's, for the source gate.
        if (deps.answer) {
          const form = driver
          const formAts = ats
          const answered = await withDeadline(
            (async () => deps.answer!({ attempt, fields: await form.extractFormFields(), ats: formAts, prepared: prepared.run }))(),
            Math.max(1000, budgetMs - report.timings.navigateMs),
          )
          modelUsd += answered.costUsd
          attempt = {
            ...attempt,
            payload: { ...attempt.payload, questions: answered.questions, ...(answered.record ? { fieldMapper: answered.record } : {}) },
          }
        }
        const checked = deps.now()
        const run: PageRun = await withDeadline(
          runPage(driver, {
            ats,
            ...(hosts ? { hosts } : {}),
            questions: attempt.payload?.questions ?? [],
            profile: ctx.profile,
            company: ctx.job.company,
            coverLetterText: ctx.coverLetterText,
            documents,
            job: { id: ctx.job.id, location: ctx.job.location, foundOn: ctx.job.found_on ?? null },
            resume: ctx.resume ?? null,
            overrides: ctx.overrides ?? {},
            challengeWait: session.solvesCaptchas ? CHALLENGE_WAIT : { waits: 0, ms: 0 },
          }, deps.now),
          Math.max(1000, budgetMs - report.timings.navigateMs),
        )
        report.timings.fillMs = run.fillMs
        report.timings.checkMs = deps.now() - checked - run.fillMs

        describeRun(report, run)
        const decision = decideGates(run)
        report.gates = decision.gates
        // Anything but a clean pass, or a run not allowed to go further,
        // ends here exactly as a dry run does.
        if (decision.outcome !== 'passed' || !context || !deps.submit || context.policy.mode === 'dry_run') {
          return finishFor(decision, run, attempt)
        }
        const phase = await runSubmitPhase({
          attempt,
          deps,
          sub: deps.submit,
          context,
          driver,
          ats,
          run,
          prepared: prepared.run,
          report,
          browserStarted,
          pressed,
        })
        submitted.value = phase
        return phase.finish
      } finally {
        await release()
      }
    })()
  } catch (error) {
    const message = (error as Error).message || String(error)
    report.error = clip(message, 300)
    finish = pressed.value
      ? // Pressed, then we failed: it may have been filed. A person decides;
        // nothing presses it again.
        {
          outcome: 'unconfirmed',
          status: 'unconfirmed',
          reason: 'Autopilot pressed submit, then lost track of the page before it confirmed.',
          error: "Submit was pressed but the run stopped before the page confirmed it. Check your email or the employer's site before applying again.",
          release: false,
          from: 'submitting',
        }
      : attempt.attempts < deps.maxRuns
        ? { outcome: 'retry', status: 'ready', reason: 'Our run failed; it will be tried again.', error: '', release: false }
        : handBack('retry', 'Autopilot could not get through this form. Finish it yourself.', 'executor_failed')
  } finally {
    await release()
  }

  report.outcome = finish.outcome
  report.status = finish.status
  report.reason = finish.reason
  report.finishedAt = new Date(deps.now()).toISOString()
  report.durationMs = deps.now() - started
  report.cost = runCost({ provider: report.provider, browserMs: report.browserMs, reportedUsd, modelUsd })

  const priorRuns = Array.isArray(attempt.payload?.executorRuns) ? attempt.payload.executorRuns : []
  const questions = finish.questions ?? attempt.payload?.questions ?? []
  const readyAt = finish.readyAt ?? deps.now() + RETRY_BACKOFF_MS * attempt.attempts
  const patch: Partial<Attempt> = {
    status: finish.status,
    lease_owner: '',
    // A run we failed waits before the next claim (which skips a lease still
    // in the future), so a browser outage does not use up every run at once.
    lease_expires_at: finish.status === 'ready' ? new Date(readyAt).toISOString() : null,
    error: finish.error || (finish.outcome === 'retry' ? report.error : ''),
    cost_usd: (Number(attempt.cost_usd) || 0) + report.cost.totalUsd,
    gate_results: {
      ...(attempt.gate_results ?? {}),
      executor: {
        outcome: finish.outcome,
        passed: finish.outcome === 'passed' || finish.outcome === 'submitted' || finish.outcome === 'rehearsed' || finish.outcome === 'review',
        dry_run: report.mode !== 'submit',
        at: report.finishedAt,
        ...(report.gates ? { gates: report.gates } : {}),
        ...(report.challenge ? { challenge: report.challenge } : {}),
      },
      ...(report.submit
        ? {
            submit: {
              mode: report.submit.mode,
              outcome: finish.outcome,
              result: report.submit.result,
              at: report.finishedAt,
              clicked_at: report.submit.clickedAt || null,
              waited_ms: report.submit.waitedMs,
              challenges_at_press: report.submit.challengesAtPress,
              challenge_after_press: report.submit.challengeAfterPress || null,
              screenshot: report.submit.screenshot,
              ...(report.submit.gates ? { gates: report.submit.gates } : {}),
            },
          }
        : {}),
    },
    payload: {
      ...attempt.payload,
      questions,
      executorRuns: [...priorRuns.slice(-(KEEP_REPORTS - 1)), report],
    },
    ...(finish.executor ? { executor: finish.executor } : {}),
    // Cleared on every other outcome, so a re-run does not keep an old reason.
    blocked_reason: finish.blockedReason ?? '',
    ...(finish.questions ? { pending_questions: unansweredRequired(questions) } : {}),
    ...(finish.uncount ? { attempts: Math.max(0, attempt.attempts - 1) } : {}),
    ...(finish.columns ?? {}),
  }

  let written: Awaited<ReturnType<ExecutorDeps['write']>>
  if (finish.from === 'submitting' && deps.submit) {
    written = await deps.submit.writeAfterPress(attempt.id, deps.owner, patch)
    // The lease ran out while the page was answering, and recovery already
    // called it unconfirmed. Still our press: the page's word settles it.
    if (written === 'lease_lost' && finish.status === 'submitted' && pressed.clickedAt) {
      // The lease is someone else's business now: leave it out.
      const late = { ...patch }
      delete late.lease_owner
      delete late.lease_expires_at
      written = await deps.submit.writeLate(attempt.id, pressed.clickedAt, late)
    }
  } else {
    written = await deps.write(attempt.id, deps.owner, patch)
  }
  if (written === 'written') {
    // Filed: the credit is spent. Not filed: it goes back whenever the
    // attempt leaves Autopilot's hands. Unconfirmed: held until a person says.
    if (attempt.origin === 'autopilot') {
      if (finish.charge && deps.submit) await deps.submit.charge(attempt.id, `submitted: ${finish.reason}`.slice(0, 200))
      else if (finish.release) await deps.settle(attempt.id, `${finish.outcome}: ${finish.reason || finish.error}`)
    }
  } else if (written === 'lease_lost') {
    console.warn(`[executor] ${attempt.id}: lease lost before the result was written; leaving it to its new holder`)
  } else {
    console.error(`[executor] ${attempt.id}: could not write the result: ${written.error}`)
  }
  if (deps.submit && (report.submit || pressed.value)) {
    await deps.submit.afterRun({ attempt, report, finish, written, receipt: submitted.value?.receipt ?? null, pressed: pressed.value })
  }
  return report
}

function describeRun(report: ExecutionReport, run: PageRun): void {
  report.finalUrl = run.finalUrl
  report.page = {
    before: { state: run.before.state, evidence: clip(run.before.evidence, 160) },
    after: { state: run.after.state, evidence: clip(run.after.evidence, 160) },
  }
  const seen = new Map<string, string>()
  for (const signal of [...run.before.challenges, ...run.after.challenges]) {
    if (seen.get(signal.kind) !== 'blocking') seen.set(signal.kind, signal.state)
  }
  report.challenges = [...seen].map(([kind, state]) => ({ kind, state }))
  report.challenge = run.challenge
  report.filled = run.filled.map((field) => ({
    key: field.key,
    label: clip(field.label),
    kind: field.kind,
    source: field.source,
    ok: field.ok,
    observed: field.kind === 'textarea' ? `${field.observed.length} characters` : clip(field.observed),
    reason: clip(field.reason, 120),
  }))
  report.left = run.left.map((field) => ({ key: field.key, label: clip(field.label), required: field.required, reason: field.reason }))
  report.counts = {
    fields: run.fields.length,
    required: run.fields.filter((field) => field.required).length,
    filled: run.filled.filter((field) => field.ok).length,
    failed: run.filled.filter((field) => !field.ok).length,
    left: run.left.length,
  }
}

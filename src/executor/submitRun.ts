import type { AutopilotReceipt } from './receipt.js'
import { buildReceipt } from './receipt.js'
import type { AutopilotSettings } from '../settings.js'
import type { Attempt } from '../attempt.js'
import type { FormAts } from 'ats-form-fill'
import type { HoldResult, MarkResult, WriteResult } from '../store/types.js'
import type { ApplyContext } from '../types.js'
import { runCost } from './cost.js'
import type { FormDriver } from './driver.js'
import { clip } from './gates.js'
import type { PageRun } from './pageRun.js'
import type { ExecutionReport, SubmitReport } from './report.js'
import type { ExecutorDeps, Finish, PreparedRun } from './run.js'
import { handBack } from './run.js'
import { pressAndConfirm, type SubmitOutcome } from './submit.js'
import { decideSubmitGates, statedCompanyCap, type DraftPolicy, type SubmitGateInput } from './submitGates.js'
import { approvedByUser, type SubmitPolicy } from './submitPolicy.js'

/**
 * The second half of a run: everything after the form gates (gates.ts)
 * passed, with the browser still open. Gather what the pre-submit gates need, decide, take the
 * screenshot, and — only in `submit` mode with every gate passed — press
 * submit once (submit.ts) and turn what the page said into the attempt's next
 * state.
 *
 * | Outcome                          | Attempt goes to                  | Credit   |
 * |----------------------------------|----------------------------------|----------|
 * | confirmation                     | submitted (+ tracker, receipt)   | charged  |
 * | validation error after the press | blocked / validation, assisted   | released |
 * | bot check after the press        | blocked / <kind>, assisted       | released |
 * | no answer in time                | unconfirmed (+ receipt)          | held     |
 * | our failure after the press      | unconfirmed (run.ts catch)       | held     |
 * | review first, not approved       | awaiting_approval, browser       | held     |
 * | rehearsal                        | awaiting_approval, assisted      | released |
 * | daily cap                        | ready again on the next day      | held     |
 * | any other gate                   | blocked / <code>, assisted       | released |
 * | hold gone, no credit to re-hold  | awaiting_approval, browser,      | none     |
 * |                                  | blocked_reason credits_exhausted |          |
 *
 * No press without a live hold: right before submit_clicked_at is written,
 * `holdCredit` confirms the attempt's hold is unsettled, or takes one again
 * if it was released. With none to take, nothing is pressed; the attempt
 * waits, filled, for the applicant. (BillingHooks; the default holds
 * nothing and always says yes.)
 */

export interface SubmitContext {
  policy: SubmitPolicy
  settings: AutopilotSettings
}

/** What the pre-submit gates need that is not on the page. */
export interface SubmitFacts {
  jobActive: boolean
  appliedToday: number
  dailyLimit: number
  /** Applications to this company in `companyWindowDays`, any origin. */
  companyApplied: number
  companyCap: number
  companyWindowDays: number
  spentUsd: number
  budgetUsd: number
  reviewedDrafts: number
  reviewedQuestionIds: string[]
  eligibility: { eligible: boolean | 'unknown'; reasons?: string[] } | null
  /** When a daily-cap hold may try again (ms). */
  nextWindowAt: number
  /** The resume profile's name, for the receipt. */
  profileName: string | null
}

export interface AfterRun {
  attempt: Attempt
  report: ExecutionReport
  finish: Finish
  written: Awaited<ReturnType<ExecutorDeps['write']>>
  receipt: AutopilotReceipt | null
  pressed: boolean
}

export interface SubmitRunDeps {
  /** The mode this run may work in, and the owner's settings. */
  context(attempt: Attempt): Promise<SubmitContext>
  facts(attempt: Attempt, ctx: ApplyContext, stated: { cap: number; days: number } | null, settings: AutopilotSettings): Promise<SubmitFacts>
  /** The double-press guard (Store.markSubmitClicked). Only `marked` lets the press happen. */
  markClicked(attemptId: string, owner: string, at: string): Promise<MarkResult>
  writeAfterPress(attemptId: string, owner: string, patch: Partial<Attempt>): Promise<WriteResult>
  writeLate(attemptId: string, clickedAt: string, patch: Partial<Attempt>): Promise<WriteResult>
  charge(attemptId: string, why: string): Promise<void>
  /** The attempt's live hold, taken again if it was released (store/types.ts BillingHooks). */
  holdCredit(attempt: Attempt): Promise<HoldResult>
  /** The tracker entry for a confirmed application. Returns its id. */
  recordApplication(attempt: Attempt, ctx: ApplyContext): Promise<string | null>
  uploadScreenshot(userId: string, attemptId: string, png: Buffer): Promise<{ path: string; expiresAt: string } | null>
  /** Keep the receipt and tell whoever is listening. Never throws. */
  afterRun(input: AfterRun): Promise<void>
  /** A person reads what will be sent and says yes ("type the company name"): false stops before the press. */
  confirmPress?(summary: PressSummary): Promise<boolean>
  confirmTimeoutMs: number
  sleep(ms: number): Promise<void>
}

/** What a person sees before confirming the press. */
export interface PressSummary {
  company: string
  role: string
  formUrl: string
  button: string
  screenshot: string
  fields: Array<{ label: string; value: string; source: string; draft: boolean }>
}

export interface SubmitFinish {
  finish: Finish
  receipt: AutopilotReceipt | null
}

interface PhaseInput {
  attempt: Attempt
  deps: ExecutorDeps
  sub: SubmitRunDeps
  context: SubmitContext
  driver: FormDriver
  /** The form's ATS; 'unknown' for an agent-route form. */
  ats: FormAts
  run: PageRun
  prepared: PreparedRun
  report: ExecutionReport
  browserStarted: number
  /** Shared with run.ts: set the moment submit_clicked_at is written. */
  pressed: { value: boolean; clickedAt: string }
}

/** Lease to leave after the page's answer, for the write. */
const WRITE_MARGIN_MS = 5_000
const MIN_WAIT_MS = 5_000

export const CREDITS_EXHAUSTED_REASON = "Nothing was left to hold for this application, so it wasn't sent. It's filled and ready."

/**
 * Where an attempt goes when it can't hold a credit for the press; null when
 * it holds one and may go on. None left: parked, still the agent's (approve
 * sends it back). Already charged: it was submitted, so nothing presses it
 * again. Billing unreadable: our failure, retried later.
 */
export function finishWithoutHold(hold: HoldResult): Finish | null {
  if (hold.ok) return null
  if (hold.reason === 'credits_exhausted') {
    return {
      outcome: 'credits',
      status: 'awaiting_approval',
      reason: CREDITS_EXHAUSTED_REASON,
      error: '',
      blockedReason: 'credits_exhausted',
      release: false,
    }
  }
  if (hold.reason === 'already_charged') {
    return {
      ...handBack('blocked', 'This application was already charged as sent, so Autopilot will not send it again.', 'already_charged'),
      release: false,
    }
  }
  throw new Error('billing is unavailable right now; did not press')
}

function agentQuestionIds(attempt: Attempt): string[] {
  const answers = attempt.payload?.fieldMapper?.answers ?? []
  return answers.map((answer) => answer.questionId)
}

export async function runSubmitPhase(input: PhaseInput): Promise<SubmitFinish> {
  const { attempt, deps, sub, context, driver, run, prepared, report } = input
  const { ctx, documents } = prepared
  const { policy, settings } = context

  const submit: SubmitReport = {
    mode: policy.mode,
    policyReason: policy.reason,
    gates: null,
    target: '',
    clickedAt: '',
    result: '',
    evidence: '',
    resultUrl: '',
    waitedMs: 0,
    pressError: '',
    challengesAtPress: [],
    challengeAfterPress: '',
    screenshot: '',
  }
  report.submit = submit

  // The page as it is right before the press: everything below decides on this.
  const prePress = await driver.classifyPage()
  const prePressUrl = driver.url()
  const target = await driver.findSubmit(input.ats)
  const text = await driver.pageText().catch(() => '')
  submit.target = target?.text ?? ''
  submit.challengesAtPress = prePress.challenges.map((signal) => ({ kind: signal.kind, state: signal.state }))

  const stated = statedCompanyCap(text)
  const facts = await sub.facts(attempt, ctx, stated, settings)
  const gateInput: SubmitGateInput = {
    run,
    prePress,
    prePressUrl,
    submitTarget: target,
    questions: attempt.payload?.questions ?? [],
    agentQuestionIds: agentQuestionIds(attempt),
    reviewedQuestionIds: facts.reviewedQuestionIds,
    drafts: { policy: settings.draftPolicy as DraftPolicy, reviewedCount: facts.reviewedDrafts, reviewFirst: settings.draftReviewCount },
    approved: approvedByUser(attempt),
    documents: {
      tailoredDocumentId: attempt.tailored_document_id,
      resumeFileName: documents.resume.fileName,
      coverLetterFileName: documents.coverLetter?.fileName ?? null,
      coverLetterText: ctx.coverLetterText,
    },
    job: { active: facts.jobActive },
    caps: {
      appliedToday: facts.appliedToday,
      dailyLimit: facts.dailyLimit,
      companyApplied: facts.companyApplied,
      companyCap: facts.companyCap,
      companyWindowDays: facts.companyWindowDays,
    },
    budget: {
      spentUsd: facts.spentUsd,
      budgetUsd: facts.budgetUsd,
      thisRunUsd: runCost({ provider: report.provider, browserMs: deps.now() - input.browserStarted }).totalUsd,
    },
    eligibility: {
      matchScore: attempt.match_score == null || attempt.match_score === '' ? null : Number(attempt.match_score),
      minMatch: settings.minMatch,
      verdict: facts.eligibility,
    },
  }
  const decision = decideSubmitGates(gateInput)
  submit.gates = decision.gates

  let shot: { path: string; expiresAt: string } | null = null
  const receiptFor = (status: AutopilotReceipt['status'], outcome?: Exclude<SubmitOutcome, { kind: 'not_pressed' }>): AutopilotReceipt =>
    buildReceipt({
      attemptId: attempt.id,
      userId: attempt.client_key,
      jobId: attempt.job_id,
      company: ctx.job.company,
      role: ctx.job.role,
      profile: attempt.profile_id ? { id: attempt.profile_id, name: facts.profileName ?? '' } : null,
      status,
      formUrl: report.formUrl,
      finalUrl: outcome?.url ?? prePressUrl,
      filled: run.filled,
      readBack: run.readBack,
      documents: { tailoredDocumentId: attempt.tailored_document_id, resume: documents.resume, coverLetter: documents.coverLetter, coverLetterText: ctx.coverLetterText },
      confirmation: outcome?.kind === 'confirmed' ? { text: outcome.evidence, url: outcome.url } : null,
      timings: {
        startedAt: report.startedAt,
        clickedAt: submit.clickedAt,
        answeredAt: outcome && outcome.kind !== 'timeout' ? new Date(deps.now()).toISOString() : null,
        waitMs: outcome?.waitedMs ?? 0,
        runMs: deps.now() - Date.parse(report.startedAt),
        fillMs: report.timings.fillMs,
      },
      challenge: { beforePress: submit.challengesAtPress, afterPress: outcome?.kind === 'challenge' ? outcome.challenge : null },
      cost: {
        run: runCost({ provider: report.provider, browserMs: deps.now() - input.browserStarted }),
        attemptUsd: (Number(attempt.cost_usd) || 0) + runCost({ provider: report.provider, browserMs: deps.now() - input.browserStarted }).totalUsd,
      },
      screenshot: shot,
    })

  // One picture of the filled form, right before the press — or, for review
  // and a rehearsal, of what would have been sent.
  if (decision.outcome === 'passed' || decision.outcome === 'review') {
    const png = await driver.screenshot().catch(() => null)
    shot = png ? await sub.uploadScreenshot(attempt.client_key, attempt.id, png) : null
    submit.screenshot = shot?.path ?? ''
  }

  switch (decision.outcome) {
    case 'blocked':
      return { finish: handBack('blocked', decision.reason, decision.blockedReason), receipt: null }
    case 'hand_back':
    case 'needs_input':
      return { finish: handBack('hand_back', decision.reason, decision.blockedReason || 'question'), receipt: null }
    case 'hold':
      return {
        finish: { outcome: 'hold', status: 'ready', reason: decision.reason, error: '', release: false, readyAt: Math.max(deps.now() + 60_000, facts.nextWindowAt), uncount: true },
        receipt: null,
      }
    case 'review':
    case 'passed':
      break
  }

  if (policy.mode === 'rehearse') {
    return {
      finish: {
        outcome: 'rehearsed',
        status: 'awaiting_approval',
        executor: 'assisted',
        reason:
          decision.outcome === 'review'
            ? `Rehearsal: every gate passed except review (${decision.reason}). Stopped before submit.`
            : 'Rehearsal: every gate passed. Stopped before submit.',
        error: '',
        release: true,
      },
      receipt: receiptFor('preview'),
    }
  }

  if (policy.mode === 'review' || decision.outcome === 'review') {
    // Waits for the applicant's yes; the agent keeps it, so approving sends it
    // back to the queue to be submitted.
    return {
      finish: {
        outcome: 'review',
        status: 'awaiting_approval',
        reason: decision.outcome === 'review' ? decision.reason : 'Filled and checked. Approve it to send.',
        error: '',
        release: false,
      },
      receipt: receiptFor('preview'),
    }
  }

  // ── The press ───────────────────────────────────────────────────────────
  const agent = new Set(agentQuestionIds(attempt))
  const summary: PressSummary = {
    company: ctx.job.company,
    role: ctx.job.role,
    formUrl: prePressUrl,
    button: target?.text ?? '',
    screenshot: shot?.path ?? '',
    fields: run.filled.map((field) => ({
      label: field.label,
      value: field.kind === 'textarea' ? clip(field.observed, 160) : clip(field.observed, 80),
      source: field.source,
      draft: Boolean(field.questionId && agent.has(field.questionId)) || field.layer === 'agent',
    })),
  }
  if (sub.confirmPress && !(await sub.confirmPress(summary))) {
    return {
      finish: { outcome: 'rehearsed', status: 'awaiting_approval', executor: 'assisted', reason: 'Not confirmed; stopped before submit.', error: '', release: true },
      receipt: receiptFor('preview'),
    }
  }
  const left = (deps.leaseSeconds - 75) * 1000 - (deps.now() - input.browserStarted) - WRITE_MARGIN_MS
  const timeoutMs = Math.min(sub.confirmTimeoutMs, left)
  // Not enough lease left to see the page's answer: pressing now could only
  // end unconfirmed. Nothing was pressed, so it is simply run again.
  if (timeoutMs < MIN_WAIT_MS) throw new Error('not enough lease left to wait for a confirmation; did not press')

  // No press without a live credit hold. Idempotent: the check before the
  // browser opened (run.ts) already took it, and a retried or recovered run
  // finds the same hold.
  const withoutHold = finishWithoutHold(await sub.holdCredit(attempt))
  if (withoutHold) return { finish: withoutHold, receipt: receiptFor('preview') }

  const clickedAt = new Date(deps.now()).toISOString()
  const outcome = await pressAndConfirm(driver, target!, {
    markClicked: async () => {
      const marked = await sub.markClicked(attempt.id, deps.owner, clickedAt)
      if (marked === 'marked') {
        input.pressed.value = true
        input.pressed.clickedAt = clickedAt
        submit.clickedAt = clickedAt
      }
      return marked
    },
    now: deps.now,
    sleep: sub.sleep,
    timeoutMs,
  })
  submit.result = outcome.kind
  if (outcome.kind === 'not_pressed') {
    submit.evidence = outcome.reason
    // Never pressed, so nothing reached the employer. A lost lease belongs to
    // its new holder; the write that follows will find that out.
    throw new Error(`submit not pressed: ${outcome.reason}`)
  }
  submit.evidence = outcome.evidence
  submit.resultUrl = outcome.url
  submit.waitedMs = outcome.waitedMs
  submit.pressError = outcome.pressError
  if (outcome.kind === 'challenge') submit.challengeAfterPress = outcome.challenge

  switch (outcome.kind) {
    case 'confirmed': {
      const applicationId = await sub.recordApplication(attempt, ctx)
      return {
        finish: {
          outcome: 'submitted',
          status: 'submitted',
          reason: 'Submitted, and the employer’s page confirmed it.',
          error: '',
          release: false,
          charge: true,
          from: 'submitting',
          blockedReason: '',
          columns: {
            submitted_at: new Date(deps.now()).toISOString(),
            confirmation: clip(`${outcome.evidence}${outcome.url ? ` — ${outcome.url}` : ''}`, 2000),
            ...(applicationId ? { application_id: applicationId } : {}),
          },
        },
        receipt: receiptFor('submitted', outcome),
      }
    }
    case 'validation_error':
      return {
        finish: {
          ...handBack('hand_back', `The employer's form rejected an answer when Autopilot pressed submit (${outcome.evidence}). Nothing was filed. Finish it yourself.`, 'validation'),
          from: 'submitting',
        },
        receipt: null,
      }
    case 'challenge':
      return {
        finish: {
          ...handBack('blocked', `A check appeared when Autopilot pressed submit (${outcome.challenge}), so it was not filed. Finish this one yourself.`, outcome.challenge),
          from: 'submitting',
        },
        receipt: null,
      }
    case 'timeout':
      return {
        finish: {
          outcome: 'unconfirmed',
          status: 'unconfirmed',
          reason: "Autopilot pressed submit but the employer's page never confirmed it.",
          error: "Submit was pressed but the page never confirmed it. Check your email or the employer's site before applying again.",
          release: false,
          from: 'submitting',
        },
        receipt: receiptFor('unconfirmed', outcome),
      }
  }
}

import { applyContext, type Applicant } from '../applicant.js'
import type { Attempt } from '../attempt.js'
import { openBrowserSession } from '../browser/provider.js'
import { buildFillBundle } from '../browser/fillBundle.js'
import { env } from '../config.js'
import type { AgentDeps } from '../fields/agent.js'
import { agentAnswerRecords } from '../fields/agentRun.js'
import { answerForm } from '../fields/answerForm.js'
import { navigateToForm, playwrightNavPage } from '../navigator/navigate.js'
import { agentStartFrom } from '../navigator/start.js'
import { postingRef } from '../posting.js'
import { effectiveMode, nextRunWindow, startOfLocalDay, type AutopilotSettings } from '../settings.js'
import { NO_BILLING, type BillingHooks, type Store } from '../store/types.js'
import type { ApplyContext } from '../types.js'
import { openFormPage } from './browserForm.js'
import { coverLetterFile, resumeFile } from './documents.js'
import type { AutopilotReceipt } from './receipt.js'
import { MAX_EXECUTOR_RUNS, type ExecutorDeps, type PreparedRun, type PrepareResult } from './run.js'
import { approvedByUser, decideSubmitMode } from './submitPolicy.js'
import type { AfterRun, PressSummary, SubmitContext, SubmitFacts, SubmitRunDeps } from './submitRun.js'

/**
 * The executor wired to a Store, an applicant and a browser. In Arkoo this
 * side was Postgres reads, a credit ledger and allowlists; here every fact
 * the gates need comes from the store, money goes through BillingHooks (none
 * by default), and who may submit is an explicit option on the run.
 *
 * Every read fails toward not submitting: an unreadable count reads as the
 * cap reached.
 */

export interface RunOptions {
  store: Store
  applicant: Applicant
  /** This process's name on the lease. */
  owner?: string
  leaseSeconds?: number
  billing?: BillingHooks
  /** Local browser: show the window. */
  headed?: boolean
  provider?: 'local' | 'browseruse' | 'browserbase'
  /** Follow a posting's Apply links when it is not on a form the fill engine knows. Default: on. */
  navigate?: boolean
  /** Put what stored data does not answer to the agent pass. On by default; it does nothing without TYPESAFE_API_KEY. */
  agentPass?: boolean | Partial<AgentDeps>
  /**
   * What the run may do after the form gates pass:
   * - `dry_run` (default): fill, check, stop.
   * - `rehearse`: also every pre-submit gate and the screenshot, then stop.
   * - `submit`: press submit once, if every gate passes and `confirmPress` says yes.
   */
  mode?: 'dry_run' | 'rehearse' | 'submit'
  /** Required as well as `mode: 'submit'` on a form the navigator found. */
  agentSubmit?: boolean
  /** Shown everything that will be sent; false stops before the press. Required with `mode: 'submit'`. */
  confirmPress?: (summary: PressSummary) => Promise<boolean>
  /** Called once per receipt (submitted, unconfirmed, or a preview). */
  onReceipt?: (receipt: AutopilotReceipt) => void | Promise<void>
  now?: () => number
}

/** Attempts submitted by the agent since `since` (all of them when null). */
async function countSubmitted(store: Store, userId: string, since: Date | null): Promise<number> {
  const attempts = await store.listAttempts(userId)
  return attempts.filter(
    (attempt) =>
      attempt.origin === 'autopilot' &&
      attempt.status === 'submitted' &&
      (!since || (attempt.submitted_at !== null && Date.parse(attempt.submitted_at) >= since.getTime())),
  ).length
}

/** What this month's attempts cost: browser time plus model calls. */
export async function monthlyComputeSpend(store: Store, userId: string, now = new Date()): Promise<number> {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const attempts = await store.listAttempts(userId)
  return attempts.filter((attempt) => Date.parse(attempt.created_at) >= monthStart).reduce((sum, attempt) => sum + (Number(attempt.cost_usd) || 0), 0)
}

export async function submitContext(attempt: Attempt, options: Pick<RunOptions, 'store' | 'applicant' | 'mode'>): Promise<SubmitContext> {
  const settings = options.applicant.settings
  // Unknown sent count: treat as none sent, so review first stays in force.
  const sent = await countSubmitted(options.store, attempt.client_key, null).catch(() => 0)
  const policy = decideSubmitMode({
    submitOpen: options.mode === 'submit',
    dryRun: attempt.dry_run !== false,
    rehearse: options.mode === 'rehearse',
    // A person confirms each press by hand (confirmPress), as in Arkoo's owner pilot.
    pilot: options.mode === 'submit',
    settings: { enabled: true, pausedReason: settings.pausedReason },
    mode: effectiveMode(settings, sent).mode,
    approved: approvedByUser(attempt),
    breaker: { open: false, detail: '' },
  })
  return { policy, settings }
}

export async function submitFacts(
  store: Store,
  attempt: Attempt,
  ctx: ApplyContext,
  stated: { cap: number; days: number } | null,
  settings: AutopilotSettings,
  profileName: string | null,
  now = new Date(),
): Promise<SubmitFacts> {
  const companyCap = Math.min(env.autopilotCompanyCap, stated?.cap ?? Infinity)
  const companyWindowDays = Math.max(env.autopilotCompanyWindowDays, stated?.days ?? 0)
  const companySince = new Date(now.getTime() - companyWindowDays * 86_400_000)
  const agentLabels = new Map((attempt.payload?.fieldMapper?.answers ?? []).map((answer) => [answer.label, answer.questionId]))

  const [posting, today, company, spentUsd, answers] = await Promise.all([
    store.getPosting(attempt.job_id).catch(() => null),
    countSubmitted(store, attempt.client_key, startOfLocalDay(now, settings.timezone)).catch(() => null),
    store.countApplications(attempt.client_key, { company: ctx.job.company, since: companySince }).catch(() => null),
    monthlyComputeSpend(store, attempt.client_key, now).catch(() => Number.MAX_SAFE_INTEGER),
    store.listAgentAnswers(attempt.client_key).catch(() => []),
  ])
  const reviewed = answers.filter((row) => row.reviewState === 'approved' || row.reviewState === 'corrected')

  const tomorrow = new Date(startOfLocalDay(now, settings.timezone).getTime() + 26 * 3600_000)
  const next = nextRunWindow(settings, startOfLocalDay(tomorrow, settings.timezone))
  // Selection writes gate_results.selection.eligibility ('eligible' | 'unknown');
  // a richer gate_results.eligibility { eligible, reasons } wins if present.
  const selection = (attempt.gate_results?.selection ?? null) as { eligibility?: unknown } | null
  const explicit = (attempt.gate_results?.eligibility ?? null) as { eligible?: unknown; reasons?: unknown } | null
  const verdict =
    explicit && typeof explicit.eligible === 'boolean'
      ? explicit
      : selection?.eligibility === 'eligible'
        ? { eligible: true, reasons: [] }
        : selection?.eligibility === 'unknown'
          ? { eligible: 'unknown' as const, reasons: ['eligibility unknown'] }
          : null
  return {
    jobActive: posting ? posting.active : false,
    // Unreadable counts read as "limit reached".
    appliedToday: today ?? Number.MAX_SAFE_INTEGER,
    dailyLimit: Math.max(0, Math.min(settings.dailyTarget, env.autopilotDailyCap)),
    companyApplied: company ?? Number.MAX_SAFE_INTEGER,
    companyCap: Number.isFinite(companyCap) ? companyCap : env.autopilotCompanyCap,
    companyWindowDays,
    spentUsd,
    budgetUsd: env.autopilotMonthlyBudgetUsd,
    reviewedDrafts: reviewed.length,
    reviewedQuestionIds: reviewed
      .filter((row) => row.attemptId === attempt.id)
      .map((row) => agentLabels.get(row.label))
      .filter((id): id is string => Boolean(id)),
    eligibility:
      verdict && (typeof verdict.eligible === 'boolean' || verdict.eligible === 'unknown')
        ? { eligible: verdict.eligible as boolean | 'unknown', reasons: Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : [] }
        : null,
    nextWindowAt: next ? Date.parse(next.startsAt) : tomorrow.getTime(),
    profileName,
  }
}

/**
 * The receipt as the attempt will stand: a confirmation whose write did not
 * land is `unconfirmed` (recovery calls the attempt that), until a person
 * settles it.
 */
export function finalReceipt(receipt: AutopilotReceipt | null, written: AfterRun['written']): AutopilotReceipt | null {
  if (receipt && receipt.status === 'submitted' && written !== 'written') return { ...receipt, status: 'unconfirmed' }
  return receipt
}

export function submitRunDeps(options: RunOptions): SubmitRunDeps {
  const { store, applicant } = options
  const billing = options.billing ?? NO_BILLING
  return {
    context: (attempt) => submitContext(attempt, options),
    facts: (attempt, ctx, stated, settings) => submitFacts(store, attempt, ctx, stated, settings, applicant.profileName),
    markClicked: (attemptId, owner, at) => store.markSubmitClicked(attemptId, owner, at),
    writeAfterPress: (attemptId, owner, patch) => store.writeUnderLease(attemptId, owner, patch, 'submitting'),
    writeLate: (attemptId, clickedAt, patch) => store.writeLateConfirmation(attemptId, clickedAt, patch),
    charge: (attemptId, why) => billing.charge(attemptId, why),
    holdCredit: (attempt) => billing.holdCredit(attempt),
    recordApplication: async (attempt, ctx) =>
      store.recordApplication({
        userId: attempt.client_key,
        jobId: attempt.job_id,
        attemptId: attempt.id,
        company: ctx.job.company,
        role: ctx.job.role,
        url: ctx.job.apply_url,
        source: 'autopilot',
      }),
    uploadScreenshot: (userId, attemptId, png) => store.saveScreenshot(userId, attemptId, png),
    afterRun: async ({ attempt, written, receipt }) => {
      // Contained: a receipt that cannot be kept never undoes the run.
      try {
        const final = finalReceipt(receipt, written)
        if (!final) return
        await store.saveReceipt(final)
        await options.onReceipt?.(final)
      } catch (error) {
        console.error(`[executor] after-run for ${attempt.id} failed: ${(error as Error).message}`)
      }
    },
    // No confirmation, no press.
    confirmPress: options.confirmPress ?? (async () => false),
    confirmTimeoutMs: env.autopilotSubmitConfirmSeconds * 1000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/** The posting's form, and the documents and answers that go into it. */
export async function prepareRun(attempt: Attempt, options: Pick<RunOptions, 'store' | 'applicant' | 'navigate'>): Promise<PrepareResult> {
  const posting = await options.store.getPosting(attempt.job_id)
  if (!posting) return { ok: false, kind: 'unsupported', reason: 'The posting is not in the store.' }
  let ref = postingRef(posting)
  let agent: PreparedRun['agent']
  if (!ref) {
    if (options.navigate === false || !env.autopilotAgentEnabled) {
      return { ok: false, kind: 'unsupported', reason: 'This posting is not on a form Autopilot can fill.' }
    }
    const start = agentStartFrom(posting.apply_url, posting.description)
    if (start.kind === 'walled') return { ok: false, kind: 'walled', reason: start.reason, code: start.code }
    if (start.target.kind === 'fill') ref = start.target.ref
    else agent = { startUrl: start.url }
  }
  const reviewed = (await options.store.listAgentAnswers(attempt.client_key)).filter((row) => row.reviewState !== 'pending')
  const ctx = applyContext(options.applicant, posting, reviewed)
  return {
    ok: true,
    run: { ref, ...(agent ? { agent } : {}), ctx, documents: { resume: resumeFile(ctx), coverLetter: await coverLetterFile(ctx) } },
  }
}

export function executorDeps(options: RunOptions): ExecutorDeps {
  const { store, applicant } = options
  const billing = options.billing ?? NO_BILLING
  const agentPass = options.agentPass ?? true
  if (options.mode === 'submit' && !options.confirmPress) throw new Error('submit mode needs a confirmPress callback: nothing is pressed without one')
  return {
    owner: options.owner ?? `job-autopilot:${process.pid}`,
    leaseSeconds: options.leaseSeconds ?? env.leaseSeconds,
    maxRuns: MAX_EXECUTOR_RUNS,
    now: options.now ?? Date.now,
    allowed: async (userId) => userId === applicant.userId,
    prepare: (attempt) => prepareRun(attempt, options),
    openSession: (open) => openBrowserSession({ provider: options.provider ?? env.executorBrowserProvider, ...open, ...(options.headed ? { headed: true } : {}) }),
    openForm: async (session, url, ats) => openFormPage(session, url, ats, await buildFillBundle()),
    navigate: async (session, startUrl) => navigateToForm(await playwrightNavPage(session, await buildFillBundle()), startUrl),
    ...(agentPass
      ? {
          answer: async ({ attempt, fields, ats, prepared }) => {
            const posting = await store.getPosting(attempt.job_id)
            const written = await answerForm(fields, {
              ctx: prepared.ctx,
              ats,
              existing: attempt.payload?.questions ?? [],
              previous: attempt.payload?.fieldMapper ?? null,
              cache: store.classificationCache,
              jobDescription: posting?.description ?? '',
              ...(typeof agentPass === 'object' ? { deps: agentPass } : {}),
            })
            if (written.agentAnswers.length) {
              await store.saveAgentAnswers(agentAnswerRecords(attempt.client_key, written.agentAnswers, { jobId: attempt.job_id, attemptId: attempt.id }))
            }
            return { questions: written.questions, record: written.record, costUsd: written.costUsd }
          },
        }
      : {}),
    agentSubmit: options.agentSubmit === true,
    settle: (attemptId, why) => billing.release(attemptId, why),
    write: (attemptId, owner, patch) => store.writeUnderLease(attemptId, owner, patch),
    submit: submitRunDeps(options),
  }
}

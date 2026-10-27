import type { BrowserProviderName } from '../browser/provider.js'
import type { PageState } from 'ats-form-fill'
import type { AttemptStatus } from '../types.js'
import type { RunCost } from './cost.js'
import type { GateName, GateOutcome, GateResult } from './gates.js'
import type { SubmitGateName } from './submitGates.js'
import type { SubmitMode } from './submitPolicy.js'
import type { ChallengeLog } from './pageRun.js'
import type { NavHop, NavOutcome } from '../navigator/navigate.js'

/**
 * What one executor run did, stored on the attempt (`payload.executorRuns`,
 * last five kept) and printed by the CLI. Values the
 * applicant gave are clipped: the report is evidence of what the page took,
 * not a second copy of their application.
 */
export interface ExecutionReport {
  version: 1
  /** What the run was allowed to do (submitPolicy.ts). `dry_run` stops before submit. */
  mode: SubmitMode
  worker: string
  /** Which run of this attempt this was (apply_attempts.attempts after the claim). */
  run: number
  provider: BrowserProviderName | ''
  sessionId: string
  formUrl: string
  finalUrl: string
  startedAt: string
  finishedAt: string
  durationMs: number
  timings: {
    documentsMs: number
    browserOpenMs: number
    navigateMs: number
    fillMs: number
    checkMs: number
  }
  browserMs: number
  cost: RunCost
  /**
   * The gate outcome, or why no gates were reached: `retry` (our failure,
   * queued again), `not_allowed` (not this applicant's to run), `unsupported`
   * (not a form the fill engine opens).
   */
  outcome: GateOutcome | 'retry' | 'not_allowed' | 'unsupported' | SubmitReportOutcome
  /** Where the attempt went. */
  status: AttemptStatus
  reason: string
  error: string
  page: { before: { state: PageState; evidence: string }; after: { state: PageState; evidence: string } } | null
  challenges: Array<{ kind: string; state: string }>
  /** Whether a challenge needing a person was seen, and whether the solver cleared it. Null before the page opened. */
  challenge: ChallengeLog | null
  counts: { fields: number; required: number; filled: number; failed: number; left: number }
  filled: Array<{ key: string; label: string; kind: string; source: string; ok: boolean; observed: string; reason: string }>
  left: Array<{ key: string; label: string; required: boolean; reason: string }>
  gates: Record<GateName, GateResult> | null
  /** The submit part: pre-submit gates, and the press when there was one. */
  submit?: SubmitReport
  /** The agent route: how navigation got from the posting's page to its form, or why it stopped. */
  navigation?: { outcome: NavOutcome['kind']; url: string; hops: NavHop[] }
}

/**
 * - `submitted` / `unconfirmed`: pressed; confirmed, or no word in time.
 * - `review`: waiting for the applicant's approval (review first).
 * - `hold`: back in the queue for later (paused, breaker, daily cap).
 * - `rehearsed`: a rehearsal passed every gate and stopped.
 * - `credits`: about to press, and the billing hook would not hold it;
 *   parked until the applicant sends it again.
 */
export type SubmitReportOutcome = 'submitted' | 'unconfirmed' | 'review' | 'hold' | 'rehearsed' | 'credits'

export interface SubmitReport {
  mode: SubmitMode
  policyReason: string
  gates: Record<SubmitGateName, GateResult> | null
  /** The submit button the finder marked. */
  target: string
  /** submit_clicked_at, when pressed. */
  clickedAt: string
  /** What the page did after the press. */
  result: '' | 'confirmed' | 'validation_error' | 'challenge' | 'timeout' | 'not_pressed'
  evidence: string
  resultUrl: string
  waitedMs: number
  pressError: string
  /** Bot checks on the page right before the press. */
  challengesAtPress: Array<{ kind: string; state: string }>
  /** The bot check that appeared after the press, if one did. */
  challengeAfterPress: string
  screenshot: string
}

/** How many reports an attempt keeps. */
export const KEEP_REPORTS = 5

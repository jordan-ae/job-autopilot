import type { Attempt } from '../attempt.js'
import type { AutopilotReceipt } from '../executor/receipt.js'
import type { ClassificationCache } from '../fields/agent.js'
import type { JobRow } from '../types.js'

/**
 * Where the agent keeps what it does. In Arkoo this was Postgres: an attempts
 * table whose claim, lease and double-press guard were SQL compare-and-sets,
 * a tracker, an answer bank and a receipts table. Here it is one interface
 * with two implementations, memory (tests) and a JSON file (the CLI), that
 * keep the same rules:
 *
 * - `claimAttempt` hands a `ready` attempt to exactly one worker, under a
 *   lease, and never one whose submit was ever pressed.
 * - every write a worker makes afterwards is guarded by its lease and the
 *   state the claim put the attempt in (`writeUnderLease`), so a run that
 *   outlived its lease cannot overwrite whoever holds the attempt now.
 * - `markSubmitClicked` is the compare-and-set written immediately before
 *   the one press: only the caller that gets `marked` may press.
 * - `recoverStale` puts back attempts whose worker died, and turns one that
 *   died after the press into `unconfirmed`, so nothing presses twice.
 *
 * A database-backed store only has to keep those four promises.
 */

export type WriteResult = 'written' | 'lease_lost' | { error: string }
export type MarkResult = 'marked' | 'lost' | { error: string }

/** A posting as the agent knows it. */
export interface Posting extends JobRow {
  /** The posting's text: where the navigator looks for a direct form link, and the drafter's job context. */
  description: string
  /** False once the posting is known to be closed. The `job_open` gate reads it. */
  active: boolean
}

/** One application the employer has (the tracker). The company cap counts these. */
export interface ApplicationRecord {
  id: string
  userId: string
  jobId: string
  attemptId: string | null
  company: string
  role: string
  url: string
  source: string
  createdAt: string
}

/**
 * An answer the agent drafted, kept for the applicant to review. Their
 * approval or correction is what lets later drafts go out under the
 * `review_first` draft policy, and the corrected text is what is used next
 * time.
 */
export interface AgentAnswerRecord {
  userId: string
  /** The question's fingerprint (fields/text.ts), job-scoped when it names the employer. */
  fingerprint: string
  label: string
  answer: string
  fieldKey: string | null
  jobId: string | null
  attemptId: string
  via: string
  confidence: number | null
  reviewState: 'pending' | 'approved' | 'corrected'
  createdAt: string
}

export interface RecoveredAttempt {
  attemptId: string
  userId: string
  outcome: 'requeued' | 'handed_back' | 'unconfirmed'
}

export interface Store {
  createAttempt(attempt: Attempt): Promise<void>
  getAttempt(id: string): Promise<Attempt | null>
  listAttempts(userId: string): Promise<Attempt[]>
  /** `ready` → `preparing` under `owner`'s lease, one more run counted. Null if it is not claimable. */
  claimAttempt(id: string, owner: string, leaseSeconds: number, now?: Date): Promise<Attempt | null>
  /** Update only while `owner` holds the lease and the attempt is still in `from`. */
  writeUnderLease(id: string, owner: string, patch: Partial<Attempt>, from?: 'preparing' | 'submitting'): Promise<WriteResult>
  /** `preparing` → `submitting` with submit_clicked_at, under the lease, never twice. */
  markSubmitClicked(id: string, owner: string, at: string, patch?: Partial<Attempt>): Promise<MarkResult>
  /** A confirmation that arrived after recovery called the attempt unconfirmed: matched on the same press. */
  writeLateConfirmation(id: string, clickedAt: string, patch: Partial<Attempt>): Promise<WriteResult>
  /**
   * The applicant's yes to an application waiting for it: `awaiting_approval`
   * (still the agent's) → `ready`, with approved_at. False when it is not
   * waiting, so two approvals cannot both queue it.
   */
  approveAttempt(id: string, now?: Date): Promise<boolean>
  /** Expired leases: back to `ready`, to the applicant after `maxRuns`, or `unconfirmed` once pressed. */
  recoverStale(maxRuns: number, now?: Date): Promise<RecoveredAttempt[]>

  savePosting(posting: Posting): Promise<void>
  getPosting(id: string): Promise<Posting | null>

  recordApplication(application: Omit<ApplicationRecord, 'id' | 'createdAt'> & { createdAt?: string }): Promise<string>
  /** Applications to `company` (case-insensitive) since `since`, any origin. */
  countApplications(userId: string, filter: { company?: string; since: Date }): Promise<number>

  /** Never overwrites an answer the applicant already reviewed or corrected. */
  saveAgentAnswers(rows: AgentAnswerRecord[]): Promise<void>
  listAgentAnswers(userId: string): Promise<AgentAnswerRecord[]>
  /** The applicant's verdict on a drafted answer: `corrected` with their text, or `approved`. */
  reviewAgentAnswer(userId: string, fingerprint: string, verdict: { approved: true } | { corrected: string }): Promise<boolean>

  /** Which canonical field an ATS question is, shared across applications (fields/agent.ts). */
  classificationCache: ClassificationCache

  saveReceipt(receipt: AutopilotReceipt): Promise<void>
  getReceipt(attemptId: string): Promise<AutopilotReceipt | null>
  /** Keep the one screenshot of the filled form. Null when it could not be kept. */
  saveScreenshot(userId: string, attemptId: string, png: Buffer): Promise<{ path: string; expiresAt: string } | null>
}

/**
 * Whether a run may press submit as far as money goes. Arkoo held one credit
 * per application and charged it only on a confirmed submit; a caller with
 * its own billing implements these. The default bills nothing.
 */
export type HoldResult =
  | { ok: true; renewed: boolean }
  | { ok: false; reason: 'credits_exhausted' | 'already_charged' | 'unavailable' }

export interface BillingHooks {
  /** The attempt's live hold, taken again if it was released. Checked before the browser opens and right before the press. */
  holdCredit(attempt: Attempt): Promise<HoldResult>
  /** The employer confirmed it: the application is paid for. */
  charge(attemptId: string, why: string): Promise<void>
  /** It left the agent's hands unsent: give the hold back. */
  release(attemptId: string, why: string): Promise<void>
}

export const NO_BILLING: BillingHooks = {
  holdCredit: async () => ({ ok: true, renewed: false }),
  charge: async () => {},
  release: async () => {},
}

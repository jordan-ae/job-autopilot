import type { AgentRunRecord } from './fields/agentRun.js'
import type { ApplyExecutor, ApplyQuestion, AttemptStatus } from './types.js'

/**
 * One application, from the moment it is planned to the receipt.
 *
 * The record keeps the column names of the table it came from in Arkoo
 * (snake_case), so a store backed by a database can map it one to one. In
 * this package it lives in a Store (src/store/): memory for tests, a JSON
 * file for the CLI.
 */
export interface Attempt {
  id: string
  /** Whose application. The CLI uses one id for the person running it. */
  client_key: string
  job_id: string
  /** The tracker entry written when the employer confirmed it. */
  application_id: string | null
  /**
   * The CV and letter the application is built on. The `documents_attached`
   * gate refuses to press submit without one.
   */
  tailored_document_id: string | null
  executor?: ApplyExecutor | ''
  /** `autopilot`: the agent carries it. `user`: the applicant does. */
  origin?: 'user' | 'autopilot'
  /** Why a run stopped for a person: a gate's code (`trap`, `readback`, `off_host`…). */
  blocked_reason?: string
  /** What each phase decided: `executor` (the form gates), `submit` (the pre-submit gates), `selection`. */
  gate_results?: Record<string, unknown> | null
  status: AttemptStatus
  /** Required questions still waiting on the applicant. */
  pending_questions: ApplyQuestion[]
  payload: {
    questions?: ApplyQuestion[]
    /** What the agent pass did: its cost, the fields it mapped, what it drafted. */
    fieldMapper?: AgentRunRecord
    /** The executor's reports, newest last (executor/report.ts). */
    executorRuns?: unknown[]
  }
  /** What every run so far cost: browser time plus model calls. */
  cost_usd?: number | string
  /** The resume profile it was made under, when selection picked one. */
  profile_id?: string | null
  /** True: never press submit, whatever else allows it. */
  dry_run?: boolean
  /** The match score that got the posting selected (src/selection/). */
  match_score?: number | string | null
  /** The worker holding the attempt, and until when (store.claim). */
  lease_owner?: string
  lease_expires_at?: string | null
  /** Written immediately before the one press of submit. Never cleared. */
  submit_clicked_at?: string | null
  target_url: string
  confirmation: string
  error: string
  /** Runs so far, counting the current one. */
  attempts: number
  approved_at: string | null
  submitted_at: string | null
  created_at: string
}

/** A fresh attempt, ready for the executor. Dry run unless told otherwise. */
export function newAttempt(input: {
  id: string
  userId: string
  jobId: string
  targetUrl: string
  tailoredDocumentId: string | null
  questions?: ApplyQuestion[]
  dryRun?: boolean
  profileId?: string | null
  matchScore?: number | null
  gateResults?: Record<string, unknown>
  approvedAt?: string | null
  now?: Date
}): Attempt {
  return {
    id: input.id,
    client_key: input.userId,
    job_id: input.jobId,
    application_id: null,
    tailored_document_id: input.tailoredDocumentId,
    executor: 'browser',
    origin: 'autopilot',
    blocked_reason: '',
    gate_results: input.gateResults ?? {},
    status: 'ready',
    pending_questions: [],
    payload: { questions: input.questions ?? [] },
    cost_usd: 0,
    profile_id: input.profileId ?? null,
    dry_run: input.dryRun ?? true,
    match_score: input.matchScore ?? null,
    lease_owner: '',
    lease_expires_at: null,
    submit_clicked_at: null,
    target_url: input.targetUrl,
    confirmation: '',
    error: '',
    attempts: 0,
    approved_at: input.approvedAt ?? null,
    submitted_at: null,
    created_at: (input.now ?? new Date()).toISOString(),
  }
}

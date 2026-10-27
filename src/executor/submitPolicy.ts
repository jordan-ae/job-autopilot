import type { AutopilotMode, PauseReason } from '../settings.js'
import type { Attempt } from '../attempt.js'

/**
 * What one executor run is allowed to do with a form it filled. Pure; the
 * caller gathers the facts (deps.ts submitContext).
 *
 *   dry_run   Fill, check, stop, and hand the filled application to the
 *             applicant to file. Submitting not asked for, or the attempt
 *             itself marked dry_run.
 *   rehearse  Everything a submit does — every gate, the screenshot — except
 *             the press.
 *   review    Review first and not approved yet: fill and check, then wait in
 *             `awaiting_approval` for the applicant's yes. Approving sends it
 *             back to the queue to be submitted.
 *   hold      Not now, and nothing is wrong with the application: Autopilot
 *             is paused or off for this applicant, or a circuit breaker is
 *             open. Back to `ready` with a backoff; no browser is opened.
 *   submit    Press it, once every pre-submit gate passes.
 */
export type SubmitMode = 'dry_run' | 'rehearse' | 'review' | 'hold' | 'submit'

/** Paused reasons that stop submits. Credits are not one: the press itself
 * checks that the attempt still holds one (submitRun.ts finishWithoutHold). */
const STOPPING_PAUSES: ReadonlySet<string> = new Set(['user', 'budget', 'anomaly'])

export interface SubmitPolicyInput {
  /** The run was asked to submit (the CLI's --submit). */
  submitOpen: boolean
  dryRun: boolean
  /** The run was asked to rehearse. */
  rehearse: boolean
  /** A person confirms this press by hand before it happens. */
  pilot: boolean
  settings: { enabled: boolean; pausedReason: PauseReason | null }
  /** effectiveMode() with the user's sent count. */
  mode: AutopilotMode
  approved: boolean
  breaker: { open: boolean; detail: string }
}

export interface SubmitPolicy {
  mode: SubmitMode
  reason: string
}

export function decideSubmitMode(input: SubmitPolicyInput): SubmitPolicy {
  if (input.rehearse) return { mode: 'rehearse', reason: 'Rehearsal: every gate, then stop before submit.' }
  if (!input.submitOpen) return { mode: 'dry_run', reason: 'Submitting is switched off for this account.' }
  if (input.dryRun) return { mode: 'dry_run', reason: 'This attempt is a dry run.' }
  if (input.breaker.open) return { mode: 'hold', reason: `Autopilot has stopped submitting for now (${input.breaker.detail}).` }
  if (input.settings.pausedReason && STOPPING_PAUSES.has(input.settings.pausedReason)) {
    return { mode: 'hold', reason: `Autopilot is paused (${input.settings.pausedReason}).` }
  }
  if (input.pilot) return { mode: 'submit', reason: 'Submit, confirmed by hand before the press.' }
  if (!input.settings.enabled) return { mode: 'hold', reason: 'Autopilot is off.' }
  if (input.mode === 'review_first' && !input.approved) return { mode: 'review', reason: 'Review first: waiting for your approval.' }
  return { mode: 'submit', reason: input.approved ? 'Approved by you.' : 'Hands-free.' }
}

/**
 * Did the applicant approve this attempt? approved_at, or — selection's
 * review first — an attempt made for review (gate_results.selection.mode
 * 'review_first') that has reached the executor's queue, which only the
 * applicant's approval does.
 */
export function approvedByUser(attempt: Pick<Attempt, 'approved_at' | 'gate_results'>): boolean {
  if (attempt.approved_at) return true
  const selection = (attempt.gate_results?.selection ?? null) as { mode?: string } | null
  return selection?.mode === 'review_first'
}

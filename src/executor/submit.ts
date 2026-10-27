import type { PageClassification } from 'ats-form-fill'
import type { FormDriver } from './driver.js'
import { clip } from './gates.js'
import type { SubmitTarget } from './submitControl.js'

/**
 * The one press of submit, and what the page said afterwards.
 *
 * The only caller of `driver.pressSubmit` anywhere. The order is fixed:
 *
 *   1. `markClicked()` — the compare-and-set that writes submit_clicked_at and
 *      moves the attempt to `submitting` under this worker's lease. Anything
 *      but `marked` means someone else holds the attempt, or it was pressed
 *      before: nothing is pressed.
 *   2. press, once. A press that throws is not retried — the click may have
 *      landed — and is waited out like any other.
 *   3. watch the page until it shows a confirmation, a validation error or a
 *      bot check, or the timeout passes.
 *
 * Nothing here decides credits or statuses; run.ts maps the outcome.
 */

export type SubmitOutcome =
  /** The page confirmed: the employer has it. */
  | { kind: 'confirmed'; evidence: string; url: string; waitedMs: number; pressError: string }
  /** The form refused it and is still on screen: nothing was filed. */
  | { kind: 'validation_error'; evidence: string; url: string; waitedMs: number; pressError: string }
  /** A bot check, emailed code or login wall appeared after the press. */
  | { kind: 'challenge'; challenge: string; evidence: string; url: string; waitedMs: number; pressError: string }
  /** No word either way in time. It may or may not have been filed. */
  | { kind: 'timeout'; evidence: string; url: string; waitedMs: number; pressError: string }
  /** Never pressed: the compare-and-set failed. */
  | { kind: 'not_pressed'; reason: string }

export interface SubmitDeps {
  /** Writes submit_clicked_at; only `marked` lets the press happen. */
  markClicked(): Promise<'marked' | 'lost' | { error: string }>
  now(): number
  sleep(ms: number): Promise<void>
  /** How long to wait for the page's answer. */
  timeoutMs: number
  pollMs?: number
}

/** A validation error has to be on screen this many polls in a row: a form
 * can flash aria-invalid while it serialises. */
const STABLE_POLLS = 2

export async function pressAndConfirm(driver: FormDriver, target: SubmitTarget, deps: SubmitDeps): Promise<SubmitOutcome> {
  const marked = await deps.markClicked()
  if (marked !== 'marked') {
    return { kind: 'not_pressed', reason: marked === 'lost' ? 'lease_lost' : `mark failed: ${marked.error}` }
  }

  const pressedAt = deps.now()
  let pressError = ''
  try {
    await driver.pressSubmit(target)
  } catch (error) {
    // Not retried: a click that timed out on our side may have gone through.
    pressError = clip((error as Error).message || String(error), 200)
  }

  const poll = deps.pollMs ?? 1000
  let invalidRun = 0
  let last: PageClassification | null = null
  for (;;) {
    const waitedMs = deps.now() - pressedAt
    if (waitedMs >= deps.timeoutMs) break
    await deps.sleep(poll)
    let page: PageClassification
    try {
      page = await driver.classifyPage()
    } catch {
      // Mid-navigation: the old page is gone and the new one is not ready.
      continue
    }
    last = page
    const at = { url: driver.url(), waitedMs: deps.now() - pressedAt, pressError }
    if (page.state === 'confirmation') return { kind: 'confirmed', evidence: clip(page.evidence, 300), ...at }
    if (page.state === 'challenge') {
      const blocking = page.challenges.find((signal) => signal.state === 'blocking')
      return { kind: 'challenge', challenge: blocking?.kind ?? 'other-bot-check', evidence: clip(page.evidence, 300), ...at }
    }
    if (page.state === 'validation_error') {
      invalidRun++
      if (invalidRun >= STABLE_POLLS) return { kind: 'validation_error', evidence: clip(page.evidence, 300), ...at }
    } else {
      invalidRun = 0
    }
  }
  return {
    kind: 'timeout',
    evidence: last ? clip(`${last.state}: ${last.evidence}`, 300) : 'the page never answered',
    url: driver.url(),
    waitedMs: deps.now() - pressedAt,
    pressError,
  }
}

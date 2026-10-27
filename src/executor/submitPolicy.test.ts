import { describe, expect, it } from 'vitest'
import { applicantFrom } from '../applicant.js'
import { newAttempt } from '../attempt.js'
import { MemoryStore } from '../store/memory.js'
import { executorDeps, submitContext } from './deps.js'
import { approvedByUser, decideSubmitMode, type SubmitPolicyInput } from './submitPolicy.js'

/**
 * The switches: every one of them has to say yes before Autopilot may press
 * submit, and any one saying no keeps the dry run.
 */

const base: SubmitPolicyInput = {
  submitOpen: true,
  dryRun: false,
  rehearse: false,
  pilot: false,
  settings: { enabled: true, pausedReason: null },
  mode: 'hands_free',
  approved: false,
  breaker: { open: false, detail: '' },
}

describe('decideSubmitMode', () => {
  it('submits only when every switch says yes', () => {
    expect(decideSubmitMode(base)).toMatchObject({ mode: 'submit', reason: 'Hands-free.' })
  })

  it('keeps the dry run when submitting is off for the account, or the attempt is a dry run', () => {
    expect(decideSubmitMode({ ...base, submitOpen: false }).mode).toBe('dry_run')
    expect(decideSubmitMode({ ...base, dryRun: true }).mode).toBe('dry_run')
    // Not even approval or a confirmed press gets past them.
    expect(decideSubmitMode({ ...base, submitOpen: false, approved: true, pilot: true }).mode).toBe('dry_run')
  })

  it('waits for approval under review first, and submits once approved', () => {
    expect(decideSubmitMode({ ...base, mode: 'review_first' }).mode).toBe('review')
    expect(decideSubmitMode({ ...base, mode: 'review_first', approved: true })).toMatchObject({ mode: 'submit', reason: 'Approved by you.' })
  })

  it('holds while the breaker is open, Autopilot is paused or off', () => {
    expect(decideSubmitMode({ ...base, breaker: { open: true, detail: '4 of 6 failed' } })).toMatchObject({ mode: 'hold', reason: expect.stringContaining('4 of 6') })
    for (const pausedReason of ['user', 'budget', 'anomaly'] as const) {
      expect(decideSubmitMode({ ...base, settings: { enabled: true, pausedReason } }).mode, pausedReason).toBe('hold')
    }
    expect(decideSubmitMode({ ...base, settings: { enabled: false, pausedReason: null } }).mode).toBe('hold')
    // An approval does not override a pause or the breaker.
    expect(decideSubmitMode({ ...base, approved: true, breaker: { open: true, detail: '' } }).mode).toBe('hold')
  })

  it("doesn't hold for credits: the attempt's credit is already reserved", () => {
    expect(decideSubmitMode({ ...base, settings: { enabled: true, pausedReason: 'credits' } }).mode).toBe('submit')
  })

  it('a confirmed press: rehearse always stops before it; --submit skips review and the on/off switch but not the breaker', () => {
    expect(decideSubmitMode({ ...base, rehearse: true, submitOpen: false }).mode).toBe('rehearse')
    expect(decideSubmitMode({ ...base, pilot: true, mode: 'review_first', settings: { enabled: false, pausedReason: null } }).mode).toBe('submit')
    expect(decideSubmitMode({ ...base, pilot: true, breaker: { open: true, detail: '' } }).mode).toBe('hold')
    expect(decideSubmitMode({ ...base, pilot: true, settings: { enabled: false, pausedReason: 'anomaly' } }).mode).toBe('hold')
  })
})

describe('approvedByUser', () => {
  it("reads approved_at, or selection's review-first attempt that reached the queue", () => {
    expect(approvedByUser({ approved_at: '2026-10-20T12:00:00Z', gate_results: {} })).toBe(true)
    expect(approvedByUser({ approved_at: null, gate_results: { selection: { mode: 'review_first' } } })).toBe(true)
    expect(approvedByUser({ approved_at: null, gate_results: { selection: { mode: 'hands_free' } } })).toBe(false)
    expect(approvedByUser({ approved_at: null, gate_results: null })).toBe(false)
  })
})

describe('who decides, in this package (deps.ts submitContext)', () => {
  const applicant = applicantFrom(
    { id: 'user-1', profile: { full_name: 'Ada Lovelace', email: 'ada@example.com' } },
    { bytes: Buffer.from('%PDF-1.4'), fileName: 'cv.pdf' },
  )
  const ready = (overrides: Partial<Parameters<typeof newAttempt>[0]> = {}) =>
    newAttempt({ id: 'a1', userId: 'user-1', jobId: 'job-1', targetUrl: '', tailoredDocumentId: 'doc-1', ...overrides })

  it('is a dry run unless the run asks for more', async () => {
    const store = new MemoryStore()
    expect((await submitContext(ready(), { store, applicant })).policy.mode).toBe('dry_run')
    expect((await submitContext(ready({ dryRun: false }), { store, applicant })).policy.mode).toBe('dry_run')
  })

  it('rehearses on request, whatever the attempt says', async () => {
    const store = new MemoryStore()
    expect((await submitContext(ready(), { store, applicant, mode: 'rehearse' })).policy.mode).toBe('rehearse')
  })

  it('submits only with the explicit option and an attempt that is not a dry run', async () => {
    const store = new MemoryStore()
    expect((await submitContext(ready(), { store, applicant, mode: 'submit' })).policy.mode).toBe('dry_run')
    expect((await submitContext(ready({ dryRun: false }), { store, applicant, mode: 'submit' })).policy).toMatchObject({ mode: 'submit' })
  })

  it('holds a paused applicant even with the option', async () => {
    const store = new MemoryStore()
    const paused = { ...applicant, settings: { ...applicant.settings, pausedReason: 'user' as const } }
    expect((await submitContext(ready({ dryRun: false }), { store, applicant: paused, mode: 'submit' })).policy.mode).toBe('hold')
  })

  it('refuses to wire submit without someone to confirm the press', () => {
    expect(() => executorDeps({ store: new MemoryStore(), applicant, mode: 'submit' })).toThrow(/confirmPress/)
  })
})

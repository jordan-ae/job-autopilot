import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newAttempt, type Attempt } from '../attempt.js'
import { FileStore } from './file.js'
import { MemoryStore } from './memory.js'
import type { AgentAnswerRecord, Store } from './types.js'

/**
 * The rules Arkoo kept in SQL (the claim, the lease-guarded writes, the
 * double-press guard, recovery), held by both stores.
 */

const NOW = new Date('2026-10-20T12:00:00Z')
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000)

const ready = (overrides: Partial<Attempt> = {}): Attempt => ({
  ...newAttempt({ id: 'a1', userId: 'user-1', jobId: 'job-1', targetUrl: 'https://example.com', tailoredDocumentId: 'doc-1', now: NOW }),
  ...overrides,
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const stores: Array<[string, () => Store]> = [
  ['memory', () => new MemoryStore()],
  [
    'file',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'job-autopilot-'))
      dirs.push(dir)
      return new FileStore(dir)
    },
  ],
]

describe.each(stores)('%s store', (_name, make) => {
  describe('claim', () => {
    it('hands a ready attempt to exactly one worker, under a lease, and counts the run', async () => {
      const store = make()
      await store.createAttempt(ready())
      const claimed = await store.claimAttempt('a1', 'worker-a', 300, NOW)
      expect(claimed).toMatchObject({ status: 'preparing', lease_owner: 'worker-a', attempts: 1, lease_expires_at: later(300).toISOString() })
      expect(await store.claimAttempt('a1', 'worker-b', 300, NOW)).toBeNull()
    })

    it('never hands out one whose submit was pressed, or one still waiting out a backoff', async () => {
      const store = make()
      await store.createAttempt(ready({ submit_clicked_at: NOW.toISOString() }))
      expect(await store.claimAttempt('a1', 'worker-a', 300, NOW)).toBeNull()

      const other = make()
      await other.createAttempt(ready({ lease_expires_at: later(120).toISOString() }))
      expect(await other.claimAttempt('a1', 'worker-a', 300, NOW)).toBeNull()
      expect(await other.claimAttempt('a1', 'worker-a', 300, later(121))).not.toBeNull()
    })

    it('refuses an attempt that is not the agent’s', async () => {
      const store = make()
      await store.createAttempt(ready({ executor: 'assisted' }))
      expect(await store.claimAttempt('a1', 'worker-a', 300, NOW)).toBeNull()
    })
  })

  describe('writes under the lease', () => {
    it('lands only for the lease holder, in the state the claim left', async () => {
      const store = make()
      await store.createAttempt(ready())
      await store.claimAttempt('a1', 'worker-a', 300, NOW)
      expect(await store.writeUnderLease('a1', 'worker-b', { error: 'mine' })).toBe('lease_lost')
      expect(await store.writeUnderLease('a1', 'worker-a', { status: 'awaiting_approval', lease_owner: '' })).toBe('written')
      // Done: the old holder cannot write again.
      expect(await store.writeUnderLease('a1', 'worker-a', { error: 'again' })).toBe('lease_lost')
      expect((await store.getAttempt('a1'))?.status).toBe('awaiting_approval')
    })
  })

  describe('the double-press guard', () => {
    it('marks once, for the lease holder, and only from preparing', async () => {
      const store = make()
      await store.createAttempt(ready())
      await store.claimAttempt('a1', 'worker-a', 300, NOW)
      expect(await store.markSubmitClicked('a1', 'worker-b', NOW.toISOString())).toBe('lost')
      expect(await store.markSubmitClicked('a1', 'worker-a', NOW.toISOString())).toBe('marked')
      expect(await store.markSubmitClicked('a1', 'worker-a', NOW.toISOString())).toBe('lost')
      expect(await store.getAttempt('a1')).toMatchObject({ status: 'submitting', submit_clicked_at: NOW.toISOString() })
      // After the press, writes are guarded on `submitting`.
      expect(await store.writeUnderLease('a1', 'worker-a', { status: 'submitted' })).toBe('lease_lost')
      expect(await store.writeUnderLease('a1', 'worker-a', { status: 'submitted' }, 'submitting')).toBe('written')
    })
  })

  it('approves an application waiting for the applicant once, and nothing else', async () => {
    const store = make()
    await store.createAttempt(ready({ id: 'waiting', status: 'awaiting_approval' }))
    await store.createAttempt(ready({ id: 'handed', status: 'awaiting_approval', executor: 'assisted' }))
    expect(await store.approveAttempt('waiting', NOW)).toBe(true)
    expect(await store.approveAttempt('waiting', NOW)).toBe(false)
    expect(await store.getAttempt('waiting')).toMatchObject({ status: 'ready', approved_at: NOW.toISOString() })
    expect(await store.approveAttempt('handed', NOW)).toBe(false)
  })

  describe('recovery', () => {
    it('puts a dead run back, hands it to the applicant after the last run, and never re-queues a pressed one', async () => {
      const store = make()
      await store.createAttempt(ready({ id: 'retry' }))
      await store.createAttempt(ready({ id: 'spent', attempts: 2 }))
      await store.createAttempt(ready({ id: 'pressed' }))
      for (const id of ['retry', 'spent', 'pressed']) await store.claimAttempt(id, 'worker-a', 300, NOW)
      await store.markSubmitClicked('pressed', 'worker-a', NOW.toISOString())

      expect(await store.recoverStale(3, later(100))).toEqual([])
      const recovered = await store.recoverStale(3, later(301))
      expect(Object.fromEntries(recovered.map((row) => [row.attemptId, row.outcome]))).toEqual({ retry: 'requeued', spent: 'handed_back', pressed: 'unconfirmed' })
      expect(await store.getAttempt('spent')).toMatchObject({ status: 'blocked', executor: 'assisted', blocked_reason: 'executor_failed' })
      expect(await store.getAttempt('pressed')).toMatchObject({ status: 'unconfirmed', lease_owner: '' })
      // Nothing presses it again.
      expect(await store.claimAttempt('pressed', 'worker-b', 300, later(400))).toBeNull()
    })

    it('lets a late confirmation settle the same press, and nothing else', async () => {
      const store = make()
      await store.createAttempt(ready())
      await store.claimAttempt('a1', 'worker-a', 300, NOW)
      await store.markSubmitClicked('a1', 'worker-a', NOW.toISOString())
      await store.recoverStale(3, later(301))
      expect(await store.writeLateConfirmation('a1', later(5).toISOString(), { status: 'submitted' })).toBe('lease_lost')
      expect(await store.writeLateConfirmation('a1', NOW.toISOString(), { status: 'submitted' })).toBe('written')
    })
  })

  it('counts applications to a company in a window, any case', async () => {
    const store = make()
    const base = { userId: 'user-1', jobId: 'j', attemptId: null, role: 'Engineer', url: '', source: 'manual' }
    await store.recordApplication({ ...base, company: 'Acme', createdAt: later(-10 * 86_400).toISOString() })
    await store.recordApplication({ ...base, company: 'ACME', createdAt: later(-40 * 86_400).toISOString() })
    await store.recordApplication({ ...base, company: 'Beta', createdAt: NOW.toISOString() })
    expect(await store.countApplications('user-1', { company: 'acme', since: later(-30 * 86_400) })).toBe(1)
    expect(await store.countApplications('user-1', { since: later(-90 * 86_400) })).toBe(3)
  })

  it('never lets a drafted answer overwrite one the applicant reviewed', async () => {
    const store = make()
    const draft: AgentAnswerRecord = {
      userId: 'user-1',
      fingerprint: 'why this role',
      label: 'Why this role?',
      answer: 'First draft.',
      fieldKey: null,
      jobId: null,
      attemptId: 'a1',
      via: 'draft',
      confidence: null,
      reviewState: 'pending',
      createdAt: NOW.toISOString(),
    }
    await store.saveAgentAnswers([draft])
    expect(await store.reviewAgentAnswer('user-1', 'why this role', { corrected: 'My own words.' })).toBe(true)
    await store.saveAgentAnswers([{ ...draft, answer: 'Second draft.' }])
    expect(await store.listAgentAnswers('user-1')).toEqual([expect.objectContaining({ answer: 'My own words.', reviewState: 'corrected' })])
  })
})

describe('FileStore', () => {
  it('keeps everything across processes, and a receipt a person can read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-autopilot-'))
    dirs.push(dir)
    const first = new FileStore(dir)
    await first.createAttempt(ready())
    await first.claimAttempt('a1', 'worker-a', 300, NOW)
    await first.classificationCache.put([{ ats: 'greenhouse', nativeKey: 'q1', fingerprint: 'notice period', canonicalKey: 'notice_period', confidence: 0.95, model: 'jev' }])
    const shot = await first.saveScreenshot('user-1', 'a1', Buffer.from('PNG'))
    expect(readFileSync(shot!.path, 'utf8')).toBe('PNG')

    const second = new FileStore(dir)
    expect(await second.getAttempt('a1')).toMatchObject({ status: 'preparing', lease_owner: 'worker-a' })
    const cached = await second.classificationCache.get([{ ats: 'greenhouse', nativeKey: 'q1', fingerprint: 'notice period' }])
    expect([...cached.values()]).toEqual([{ canonicalKey: 'notice_period', confidence: 0.95 }])
  })
})

import { randomUUID } from 'node:crypto'
import type { Attempt } from '../attempt.js'
import type { AutopilotReceipt } from '../executor/receipt.js'
import { screenshotExpiry, screenshotPath } from '../executor/receipt.js'
import { cacheId, type CachedClassification, type ClassificationCache } from '../fields/agent.js'
import type { AgentAnswerRecord, ApplicationRecord, MarkResult, Posting, RecoveredAttempt, Store, WriteResult } from './types.js'

/**
 * The Store in memory. Every compare-and-set is one synchronous step, so in
 * one process it is as atomic as the SQL it replaces: two runs of the same
 * attempt cannot both claim it, both write, or both press.
 *
 * The rules are the ones Arkoo's migrations enforced
 * (`apply_claim_attempt`, `apply_recover_attempts`, the lease-guarded
 * updates); store.test.ts pins them.
 */
export class MemoryStore implements Store {
  protected attempts = new Map<string, Attempt>()
  protected postings = new Map<string, Posting>()
  protected applications: ApplicationRecord[] = []
  protected agentAnswers: AgentAnswerRecord[] = []
  protected classifications = new Map<string, CachedClassification>()
  protected receipts = new Map<string, AutopilotReceipt>()
  protected screenshots = new Map<string, Buffer>()

  /** Called after every change; the file store persists here. */
  protected async changed(): Promise<void> {}

  private copy(attempt: Attempt): Attempt {
    return structuredClone(attempt)
  }

  async createAttempt(attempt: Attempt): Promise<void> {
    if (this.attempts.has(attempt.id)) throw new Error(`attempt ${attempt.id} already exists`)
    this.attempts.set(attempt.id, this.copy(attempt))
    await this.changed()
  }

  async getAttempt(id: string): Promise<Attempt | null> {
    const attempt = this.attempts.get(id)
    return attempt ? this.copy(attempt) : null
  }

  async listAttempts(userId: string): Promise<Attempt[]> {
    return [...this.attempts.values()].filter((attempt) => attempt.client_key === userId).map((attempt) => this.copy(attempt))
  }

  async claimAttempt(id: string, owner: string, leaseSeconds: number, now = new Date()): Promise<Attempt | null> {
    if (!owner) throw new Error('claimAttempt: owner is required')
    if (leaseSeconds < 30) throw new Error('claimAttempt: lease must be at least 30 seconds')
    const attempt = this.attempts.get(id)
    if (!attempt) return null
    const claimable =
      attempt.status === 'ready' &&
      attempt.origin === 'autopilot' &&
      attempt.executor === 'browser' &&
      !attempt.submit_clicked_at &&
      // A run that failed on our side waits out its backoff, written as a lease in the future.
      (!attempt.lease_expires_at || Date.parse(attempt.lease_expires_at) < now.getTime())
    if (!claimable) return null
    attempt.status = 'preparing'
    attempt.lease_owner = owner
    attempt.lease_expires_at = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
    attempt.attempts += 1
    await this.changed()
    return this.copy(attempt)
  }

  async writeUnderLease(id: string, owner: string, patch: Partial<Attempt>, from: 'preparing' | 'submitting' = 'preparing'): Promise<WriteResult> {
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.lease_owner !== owner || attempt.status !== from) return 'lease_lost'
    Object.assign(attempt, structuredClone(patch))
    await this.changed()
    return 'written'
  }

  async markSubmitClicked(id: string, owner: string, at: string, patch: Partial<Attempt> = {}): Promise<MarkResult> {
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.lease_owner !== owner || attempt.status !== 'preparing' || attempt.submit_clicked_at) return 'lost'
    Object.assign(attempt, structuredClone(patch), { status: 'submitting', submit_clicked_at: at })
    await this.changed()
    return 'marked'
  }

  async writeLateConfirmation(id: string, clickedAt: string, patch: Partial<Attempt>): Promise<WriteResult> {
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.status !== 'unconfirmed' || attempt.submit_clicked_at !== clickedAt) return 'lease_lost'
    Object.assign(attempt, structuredClone(patch))
    await this.changed()
    return 'written'
  }

  async approveAttempt(id: string, now = new Date()): Promise<boolean> {
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.status !== 'awaiting_approval' || attempt.executor !== 'browser' || attempt.submit_clicked_at) return false
    attempt.status = 'ready'
    attempt.approved_at = now.toISOString()
    attempt.blocked_reason = ''
    attempt.lease_owner = ''
    attempt.lease_expires_at = null
    await this.changed()
    return true
  }

  async recoverStale(maxRuns: number, now = new Date()): Promise<RecoveredAttempt[]> {
    const out: RecoveredAttempt[] = []
    for (const attempt of this.attempts.values()) {
      if (attempt.executor !== 'browser') continue
      if (attempt.status !== 'preparing' && attempt.status !== 'submitting') continue
      if (!attempt.lease_expires_at || Date.parse(attempt.lease_expires_at) >= now.getTime()) continue
      if (attempt.submit_clicked_at) {
        attempt.status = 'unconfirmed'
        attempt.error = "Submit was pressed but the run stopped before the page confirmed it. Check your email or the employer's site before applying again."
      } else if (attempt.attempts >= maxRuns) {
        attempt.status = 'blocked'
        attempt.executor = 'assisted'
        attempt.blocked_reason = 'executor_failed'
        attempt.error = 'Autopilot could not finish filling this form. Finish it yourself.'
      } else {
        attempt.status = 'ready'
      }
      attempt.lease_owner = ''
      attempt.lease_expires_at = null
      out.push({
        attemptId: attempt.id,
        userId: attempt.client_key,
        outcome: attempt.status === 'ready' ? 'requeued' : attempt.status === 'unconfirmed' ? 'unconfirmed' : 'handed_back',
      })
    }
    if (out.length) await this.changed()
    return out
  }

  async savePosting(posting: Posting): Promise<void> {
    this.postings.set(posting.id, structuredClone(posting))
    await this.changed()
  }

  async getPosting(id: string): Promise<Posting | null> {
    const posting = this.postings.get(id)
    return posting ? structuredClone(posting) : null
  }

  async recordApplication(application: Omit<ApplicationRecord, 'id' | 'createdAt'> & { createdAt?: string }): Promise<string> {
    const id = randomUUID()
    this.applications.push({ ...application, id, createdAt: application.createdAt ?? new Date().toISOString() })
    await this.changed()
    return id
  }

  async countApplications(userId: string, filter: { company?: string; since: Date }): Promise<number> {
    const company = filter.company?.trim().toLowerCase()
    return this.applications.filter(
      (row) =>
        row.userId === userId &&
        Date.parse(row.createdAt) >= filter.since.getTime() &&
        (company === undefined || row.company.trim().toLowerCase() === company),
    ).length
  }

  async saveAgentAnswers(rows: AgentAnswerRecord[]): Promise<void> {
    for (const row of rows) {
      const existing = this.agentAnswers.find((entry) => entry.userId === row.userId && entry.fingerprint === row.fingerprint)
      // Never overwrite: a reviewed answer is the applicant's word now.
      if (existing) continue
      this.agentAnswers.push(structuredClone(row))
    }
    await this.changed()
  }

  async listAgentAnswers(userId: string): Promise<AgentAnswerRecord[]> {
    return this.agentAnswers.filter((row) => row.userId === userId).map((row) => structuredClone(row))
  }

  async reviewAgentAnswer(userId: string, fingerprint: string, verdict: { approved: true } | { corrected: string }): Promise<boolean> {
    const row = this.agentAnswers.find((entry) => entry.userId === userId && entry.fingerprint === fingerprint)
    if (!row) return false
    if ('corrected' in verdict) {
      row.answer = verdict.corrected
      row.reviewState = 'corrected'
    } else {
      row.reviewState = 'approved'
    }
    await this.changed()
    return true
  }

  classificationCache: ClassificationCache = {
    get: async (keys) => {
      const out = new Map<string, CachedClassification>()
      for (const key of keys) {
        const hit = this.classifications.get(cacheId(key))
        if (hit) out.set(cacheId(key), { ...hit })
      }
      return out
    },
    put: async (rows) => {
      for (const row of rows) this.classifications.set(cacheId(row), { canonicalKey: row.canonicalKey, confidence: row.confidence })
      await this.changed()
    },
  }

  async saveReceipt(receipt: AutopilotReceipt): Promise<void> {
    this.receipts.set(receipt.attemptId, structuredClone(receipt))
    await this.changed()
  }

  async getReceipt(attemptId: string): Promise<AutopilotReceipt | null> {
    const receipt = this.receipts.get(attemptId)
    return receipt ? structuredClone(receipt) : null
  }

  async saveScreenshot(userId: string, attemptId: string, png: Buffer): Promise<{ path: string; expiresAt: string } | null> {
    const path = screenshotPath(userId, attemptId)
    this.screenshots.set(path, png)
    return { path, expiresAt: screenshotExpiry(new Date()) }
  }
}

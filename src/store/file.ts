import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AutopilotReceipt } from '../executor/receipt.js'
import { screenshotExpiry, screenshotPath } from '../executor/receipt.js'
import { MemoryStore } from './memory.js'

/**
 * The memory store, kept in a folder between runs: `state.json` for the
 * records, `receipts/<attempt>.json` for each receipt as a person would read
 * it, and `screenshots/<user>/<attempt>.png`.
 *
 * One process at a time. The compare-and-sets are atomic inside the process
 * that holds the folder; two CLIs sharing one folder would each trust their
 * own copy. Anything multi-process wants a database behind the Store
 * interface instead.
 */
export class FileStore extends MemoryStore {
  private readonly file: string

  constructor(readonly dir: string) {
    super()
    this.file = join(dir, 'state.json')
    if (!existsSync(this.file)) return
    const state = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Record<string, unknown>>
    for (const attempt of (state.attempts as never[]) ?? []) this.attempts.set((attempt as { id: string }).id, attempt)
    for (const posting of (state.postings as never[]) ?? []) this.postings.set((posting as { id: string }).id, posting)
    this.applications = (state.applications as never[]) ?? []
    this.agentAnswers = (state.agentAnswers as never[]) ?? []
    for (const [id, hit] of Object.entries((state.classifications as Record<string, never>) ?? {})) this.classifications.set(id, hit)
    for (const receipt of (state.receipts as AutopilotReceipt[]) ?? []) this.receipts.set(receipt.attemptId, receipt)
  }

  protected override async changed(): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    const state = {
      version: 1,
      attempts: [...this.attempts.values()],
      postings: [...this.postings.values()],
      applications: this.applications,
      agentAnswers: this.agentAnswers,
      classifications: Object.fromEntries(this.classifications),
      receipts: [...this.receipts.values()],
    }
    // Written whole and renamed into place, so a crash never leaves half a file.
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2))
    renameSync(temp, this.file)
  }

  override async saveReceipt(receipt: AutopilotReceipt): Promise<void> {
    await super.saveReceipt(receipt)
    const path = join(this.dir, 'receipts', `${receipt.attemptId}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(receipt, null, 2))
  }

  override async saveScreenshot(userId: string, attemptId: string, png: Buffer): Promise<{ path: string; expiresAt: string } | null> {
    const relative = screenshotPath(userId, attemptId)
    const path = join(this.dir, 'screenshots', relative)
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, png)
    } catch (error) {
      console.warn(`[store] screenshot not kept: ${(error as Error).message}`)
      return null
    }
    return { path, expiresAt: screenshotExpiry(new Date()) }
  }
}

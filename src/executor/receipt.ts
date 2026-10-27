import { createHash } from 'node:crypto'
import type { FileValue } from 'ats-form-fill'
import { squash } from '../text.js'
import type { FilledField, ReadBack } from './pageRun.js'
import type { RunCost } from './cost.js'

/**
 * The receipt for an application the agent pressed submit on: what was
 * sent, where, with which documents, what the page said, how long it took and
 * what it cost. One per attempt, written when the outcome is known —
 * `submitted`, or `unconfirmed` when the page never said.
 *
 * The values are the applicant's own, kept in full for them. File bytes are
 * never stored, only the file's name, size and hash, and a field that asks
 * for a secret or a government identifier is masked. Where it is kept is the
 * store's business (src/store/): the file store writes it next to the one
 * screenshot of the filled form.
 */

/**
 * `preview`: filled and checked but not pressed — review first, waiting for
 * approval, or a rehearsal. Same shape, so the applicant reviews
 * exactly what would go out, and its screenshot is purged like any other.
 */
export type ReceiptStatus = 'preview' | 'submitted' | 'unconfirmed' | 'not_sent'

export interface ReceiptField {
  key: string
  label: string
  kind: string
  /** What the form held when submit was pressed. */
  value: string
  /** `answer` | `profile` | `document` (ours), or `page` (already on the form). */
  source: string
  /** Set when the value is not stored as typed. */
  redacted?: 'masked' | 'file'
}

export interface ReceiptDocument {
  fileName: string
  bytes: number
  sha256: string
}

export interface AutopilotReceipt {
  version: 1
  attemptId: string
  userId: string
  jobId: string
  company: string
  role: string
  profile: { id: string; name: string } | null
  status: ReceiptStatus
  formUrl: string
  finalUrl: string
  fields: ReceiptField[]
  documents: {
    tailoredDocumentId: string | null
    resume: ReceiptDocument | null
    coverLetter: ReceiptDocument | null
    /** The letter went into a text box rather than as a file. */
    letterPasted: boolean
  }
  confirmation: { text: string; url: string } | null
  timings: {
    startedAt: string
    /** Empty on a preview. */
    clickedAt: string
    answeredAt: string | null
    /** From the press to the page's answer, or to the timeout. */
    waitMs: number
    runMs: number
    fillMs: number
  }
  /** Bot checks on the page at the press and after it: the unmeasured risk. */
  challenge: { beforePress: Array<{ kind: string; state: string }>; afterPress: string | null }
  cost: { runUsd: number; attemptUsd: number; browserMinutes: number }
  screenshot: { path: string; expiresAt: string } | null
}

/** Fields whose answers are secrets or government identifiers. */
const MASK =
  /\b(password|passcode|pass ?phrase|pin|social security|ssn|sin number|national (id|identity|insurance)|passport|tax (id|number)|tin\b|bank|iban|routing|account number|credit card|card number|cvv|driver'?s? licen[cs]e)/i

export function maskValue(value: string): string {
  const flat = squash(value)
  if (!flat) return ''
  return flat.length <= 4 ? '••••' : `••••${flat.slice(-2)}`
}

export function describeFile(file: FileValue | null): ReceiptDocument | null {
  if (!file) return null
  const bytes = Buffer.from(file.base64, 'base64')
  return { fileName: file.fileName, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export interface ReceiptInput {
  attemptId: string
  userId: string
  jobId: string
  company: string
  role: string
  profile: { id: string; name: string } | null
  status: ReceiptStatus
  formUrl: string
  finalUrl: string
  filled: FilledField[]
  readBack: ReadBack[]
  documents: { tailoredDocumentId: string | null; resume: FileValue; coverLetter: FileValue | null; coverLetterText: string }
  confirmation: { text: string; url: string } | null
  timings: AutopilotReceipt['timings']
  challenge: AutopilotReceipt['challenge']
  cost: { run: RunCost; attemptUsd: number }
  screenshot: { path: string; expiresAt: string } | null
}

/** Pure: the receipt for one press, from what the run saw. */
export function buildReceipt(input: ReceiptInput): AutopilotReceipt {
  const ours = new Map(input.filled.map((field) => [field.key, field]))
  const fields: ReceiptField[] = []
  for (const field of input.readBack) {
    const filled = ours.get(field.key)
    const observed = field.observed ?? ''
    if (!filled && squash(observed) === '') continue
    const entry: ReceiptField = {
      key: field.key,
      label: squash(field.label).slice(0, 300),
      kind: field.kind,
      value: observed,
      source: filled?.source ?? 'page',
    }
    if (field.kind === 'file') {
      entry.redacted = 'file'
    } else if (MASK.test(field.label)) {
      entry.value = maskValue(observed)
      entry.redacted = 'masked'
    }
    fields.push(entry)
  }
  const pasted = input.filled.some((field) => field.source === 'document' && field.kind === 'textarea')
  return {
    version: 1,
    attemptId: input.attemptId,
    userId: input.userId,
    jobId: input.jobId,
    company: input.company,
    role: input.role,
    profile: input.profile,
    status: input.status,
    formUrl: input.formUrl,
    finalUrl: input.finalUrl,
    fields,
    documents: {
      tailoredDocumentId: input.documents.tailoredDocumentId,
      resume: describeFile(input.documents.resume),
      coverLetter: describeFile(input.documents.coverLetter),
      letterPasted: pasted && Boolean(input.documents.coverLetterText.trim()),
    },
    confirmation: input.confirmation,
    timings: input.timings,
    challenge: input.challenge,
    cost: { runUsd: input.cost.run.totalUsd, attemptUsd: input.cost.attemptUsd, browserMinutes: input.cost.run.browserMinutes },
    screenshot: input.screenshot,
  }
}

/** `<user>/<attempt>.png`: one screenshot per attempt, under its owner. */
export function screenshotPath(userId: string, attemptId: string): string {
  return `${userId}/${attemptId}.png`
}

/** When a screenshot taken now should be deleted. */
export function screenshotExpiry(now: Date, days = 90): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}

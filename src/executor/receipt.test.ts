import { describe, expect, it } from 'vitest'
import { finalReceipt } from './deps.js'
import type { FilledField, ReadBack } from './pageRun.js'
import { runCost } from './cost.js'
import { buildReceipt, maskValue, screenshotExpiry, screenshotPath, type ReceiptInput } from './receipt.js'

/** What a receipt keeps, and what it never does. */

const PDF_BASE64 = Buffer.from('%PDF-1.4 a real CV with a phone number +1 202 555 0143').toString('base64')

const filled: FilledField[] = [
  { key: 'first_name', label: 'First Name', kind: 'text', required: true, source: 'profile', ok: true, observed: 'Ada', reason: '', planned: 'Ada' },
  { key: 'ssn', label: 'Social Security Number (last 4)', kind: 'text', required: false, source: 'answer', ok: true, observed: '123-45-6789', reason: '', planned: '123-45-6789' },
  { key: 'why', label: 'Why us?', kind: 'textarea', required: true, source: 'answer', ok: true, observed: 'Because the work matters to me, at length.', reason: '', planned: '' },
  { key: 'resume', label: 'Resume/CV', kind: 'file', required: true, source: 'document', ok: true, observed: 'Ada-Lovelace.pdf', reason: '', planned: 'Ada-Lovelace.pdf' },
]

const readBack: ReadBack[] = [
  ...filled.map((field) => ({ key: field.key, label: field.label, kind: field.kind, required: field.required, observed: field.observed })),
  // Prefilled by the page itself: still part of what was sent.
  { key: 'country', label: 'Country', kind: 'select', required: false, observed: 'Germany' },
  // Empty and not ours: not part of the receipt.
  { key: 'website', label: 'Website', kind: 'text', required: false, observed: '' },
]

function input(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    attemptId: 'attempt-1',
    userId: 'user-1',
    jobId: 'job-1',
    company: 'Maven Clinic',
    role: 'Engineer',
    profile: { id: 'p1', name: 'Backend' },
    status: 'submitted',
    formUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=maven&token=1',
    finalUrl: 'https://job-boards.greenhouse.io/embed/job_app/confirmation',
    filled,
    readBack,
    documents: {
      tailoredDocumentId: 'doc-1',
      resume: { fileName: 'Ada-Lovelace.pdf', mimeType: 'application/pdf', base64: PDF_BASE64 },
      coverLetter: null,
      coverLetterText: '',
    },
    confirmation: { text: 'text: Thank you for applying', url: 'https://job-boards.greenhouse.io/embed/job_app/confirmation' },
    timings: { startedAt: '2026-10-20T12:00:00Z', clickedAt: '2026-10-20T12:00:40Z', answeredAt: '2026-10-20T12:00:43Z', waitMs: 3000, runMs: 43_000, fillMs: 9000 },
    challenge: { beforePress: [{ kind: 'recaptcha-enterprise', state: 'present' }], afterPress: null },
    cost: { run: runCost({ provider: 'browserbase', browserMs: 43_000, usdPerMinute: 0.002 }), attemptUsd: 0.012 },
    screenshot: { path: 'user-1/attempt-1.png', expiresAt: '2027-01-18T12:00:00Z' },
    ...overrides,
  }
}

describe('buildReceipt', () => {
  const receipt = buildReceipt(input())

  it('keeps every field label → value the form held at the press, ours and the page’s', () => {
    expect(receipt.fields.map((field) => [field.label, field.source])).toEqual([
      ['First Name', 'profile'],
      ['Social Security Number (last 4)', 'answer'],
      ['Why us?', 'answer'],
      ['Resume/CV', 'document'],
      ['Country', 'page'],
    ])
    expect(receipt.fields.find((field) => field.key === 'why')!.value).toBe('Because the work matters to me, at length.')
  })

  it('never stores file bytes, only the name, size and a hash', () => {
    const json = JSON.stringify(receipt)
    expect(json).not.toContain(PDF_BASE64)
    expect(json).not.toContain('202 555 0143')
    expect(receipt.documents.resume).toEqual({ fileName: 'Ada-Lovelace.pdf', bytes: Buffer.from(PDF_BASE64, 'base64').length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(receipt.fields.find((field) => field.key === 'resume')).toMatchObject({ value: 'Ada-Lovelace.pdf', redacted: 'file' })
  })

  it('masks secrets and government ids', () => {
    expect(receipt.fields.find((field) => field.key === 'ssn')).toMatchObject({ value: '••••89', redacted: 'masked' })
    expect(JSON.stringify(receipt)).not.toContain('123-45-6789')
    expect(maskValue('1234')).toBe('••••')
    expect(maskValue('')).toBe('')
  })

  it('carries the confirmation, timings, the bot-check outcome, cost and the screenshot', () => {
    expect(receipt).toMatchObject({
      status: 'submitted',
      company: 'Maven Clinic',
      profile: { id: 'p1', name: 'Backend' },
      confirmation: { text: 'text: Thank you for applying' },
      timings: { clickedAt: '2026-10-20T12:00:40Z', waitMs: 3000 },
      challenge: { beforePress: [{ kind: 'recaptcha-enterprise', state: 'present' }], afterPress: null },
      cost: { runUsd: 0.002, attemptUsd: 0.012, browserMinutes: 1 },
      screenshot: { path: 'user-1/attempt-1.png' },
    })
  })

  it('reads as unconfirmed when the confirmation never landed on the attempt', () => {
    expect(finalReceipt(receipt, 'lease_lost')!.status).toBe('unconfirmed')
    expect(finalReceipt(receipt, { error: 'reset' })!.status).toBe('unconfirmed')
    expect(finalReceipt(receipt, 'written')!.status).toBe('submitted')
    expect(finalReceipt(null, 'written')).toBeNull()
  })
})

describe('screenshots', () => {
  it('live under the owner’s folder', () => {
    expect(screenshotPath('user-1', 'attempt-1')).toBe('user-1/attempt-1.png')
  })
  it('expire after the retention period', () => {
    expect(screenshotExpiry(new Date('2026-10-20T00:00:00Z'), 90)).toBe('2027-01-18T00:00:00.000Z')
  })
})

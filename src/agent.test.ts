// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { ChoiceAnswer, JevQuestion, NoulAnswer } from './ai/decide.js'
import { applicantFrom } from './applicant.js'
import { newAttempt } from './attempt.js'
import type { BrowserSession } from './browser/provider.js'
import { executorDeps, type RunOptions } from './executor/deps.js'
import { domDriver } from './executor/driver.js'
import { runClaimedAttempt } from './executor/run.js'
import type { DraftArgs } from './fields/draft.js'
import { checkDraft } from './fields/draft.js'
import { postingFromUrl } from './posting.js'
import { MemoryStore } from './store/memory.js'

/**
 * The whole agent as this package wires it — store, applicant, navigator
 * outcome, the write step, the fill, every gate, the receipt — offline. The
 * "browser" is happy-dom serving an employer's own application form, and Jev
 * and the drafter are fakes that answer the way the real ones were measured
 * to (fields/thresholds.ts).
 */

const FORM_URL = 'https://careers.example.com/jobs/42/apply'

const FORM = `<!doctype html><html><head><title>Apply: Platform Engineer</title></head><body>
<h1>Platform Engineer at Example</h1>
<form id="application">
  <label for="first_name">First name</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name</label><input id="last_name" name="last_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="resume">Resume</label><input id="resume" name="resume" type="file" required>
  <label for="why">Why do you want to work on developer tooling?</label><textarea id="why" name="why" required></textarea>
  <label for="ts_years">How many years of experience do you have using Rust?</label><input id="ts_years" name="ts_years">
  <button type="submit">Submit application</button>
</form></body></html>`

const applicant = applicantFrom(
  {
    id: 'ada',
    profile: { full_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', location: 'London, UK', country: 'GB' },
    resume: {
      summary: 'Engineer who builds developer tools.',
      skills: 'TypeScript, Node.js, Playwright',
      languages: ['English'],
      experience: [{ company: 'Analytical Engines', jobTitle: 'Staff Engineer', startDate: 'Jan 2019', endDate: 'Present', bullets: ['Built the build system used by 40 engineers.'] }],
      education: [],
    },
  },
  { bytes: Buffer.from('%PDF-1.4 placeholder'), fileName: 'Ada-Lovelace.pdf' },
)

/** Jev as measured: maps nothing it is unsure of, says essays want prose and facts do not. */
async function fakeJev(state: unknown, questions: Record<string, JevQuestion>) {
  const asked = (state as { questions: Record<string, { text: string }> }).questions
  const answers: Record<string, ChoiceAnswer | NoulAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: /\bwhy\b|tell us|describe/i.test(asked[id].text) ? 0.93 : 0.2 }
    else answers[id] = { type: 'choice', choice: 'none', confidence: 0.97, probabilities: {} }
  }
  return { ok: true as const, answers, usage: { inputTokens: 1000, outputTokens: 0, costUsd: 0.00042, latencyMs: 200, model: 'jev-test' } }
}

function harness(options: Partial<RunOptions> = {}) {
  const store = new MemoryStore()
  const drafts: DraftArgs[] = []
  const deps = executorDeps({
    store,
    applicant,
    owner: 'worker-a',
    agentPass: {
      jevEnabled: true,
      draftEnabled: true,
      decide: fakeJev as never,
      draft: async (args) => {
        drafts.push(args)
        // Through the real guard: a figure the CV does not hold is refused.
        return checkDraft({ grounded: true, answer: 'I have spent my career building developer tools, most recently the build system used by 40 engineers at Analytical Engines.' }, args)
      },
    },
    ...options,
  })
  deps.openSession = async () => ({
    provider: 'local',
    sessionId: '',
    inspectUrl: '',
    solvesCaptchas: false,
    context: {} as BrowserSession['context'],
    close: async () => ({ costUsd: null }),
  })
  deps.navigate = async () => {
    const doc = new DOMParser().parseFromString(FORM, 'text/html')
    const driver = domDriver(doc, FORM_URL)
    return { kind: 'form', driver: { ...driver, settle: async () => {} }, url: FORM_URL, host: 'careers.example.com', multiStep: false, hops: [] }
  }
  return { store, deps, drafts }
}

async function queue(store: MemoryStore, overrides: { dryRun?: boolean } = {}) {
  const posting = postingFromUrl('https://careers.example.com/jobs/42', { company: 'Example', role: 'Platform Engineer' })
  await store.savePosting(posting)
  await store.createAttempt(newAttempt({ id: 'attempt-1', userId: 'ada', jobId: posting.id, targetUrl: posting.apply_url, tailoredDocumentId: applicant.documentId, ...overrides }))
}

describe('the agent, end to end', () => {
  it('plans, writes, fills and checks, and stops before submit by default', async () => {
    const { store, deps } = harness()
    await queue(store)
    const claimed = await store.claimAttempt('attempt-1', 'worker-a', 300)
    const report = await runClaimedAttempt(claimed!, deps)

    expect(report).toMatchObject({ mode: 'dry_run', outcome: 'passed', status: 'awaiting_approval' })
    expect(report.submit).toBeUndefined()
    const filled = Object.fromEntries(report.filled.map((field) => [field.key, field.source]))
    expect(filled).toMatchObject({ first_name: 'profile', email: 'profile', why: 'answer', resume: 'document' })
    const attempt = await store.getAttempt('attempt-1')
    expect(attempt).toMatchObject({ status: 'awaiting_approval', lease_owner: '' })
    expect(attempt?.payload.fieldMapper?.answers).toEqual([expect.objectContaining({ questionId: 'why', via: 'draft' })])
  })

  it('never lets the agent answer a factual question, even one nothing on file answers', async () => {
    const { store, deps, drafts } = harness()
    await queue(store)
    const report = await runClaimedAttempt((await store.claimAttempt('attempt-1', 'worker-a', 300))!, deps)
    expect(drafts.map((args) => args.question)).toEqual(['Why do you want to work on developer tooling?'])
    expect(report.filled.map((field) => field.key)).not.toContain('ts_years')
    expect(report.left).toContainEqual(expect.objectContaining({ key: 'ts_years', reason: 'no_answer' }))
  })

  it('refuses a draft that states a number the CV does not hold', async () => {
    const guarded = checkDraft({ grounded: true, answer: 'I led a team of 12 engineers.' }, { material: 'Built the build system used by 40 engineers.', company: 'Example' })
    expect(guarded).toEqual({ rejected: 'new_numbers', usage: expect.anything() })
  })

  it('keeps every draft for review, and holds the application until it is reviewed', async () => {
    const { store, deps } = harness({ mode: 'submit', agentSubmit: true, confirmPress: async () => true })
    await queue(store, { dryRun: false })
    const report = await runClaimedAttempt((await store.claimAttempt('attempt-1', 'worker-a', 300))!, deps)

    expect(report.submit?.gates?.answer_sources).toMatchObject({ ok: false, detail: expect.stringMatching(/not reviewed/) })
    expect(report).toMatchObject({ mode: 'submit', outcome: 'review', status: 'awaiting_approval' })
    expect(await store.listAgentAnswers('ada')).toEqual([expect.objectContaining({ label: 'Why do you want to work on developer tooling?', reviewState: 'pending' })])
    // A preview receipt of exactly what would have gone out.
    expect(await store.getReceipt('attempt-1')).toMatchObject({ status: 'preview', company: 'Example' })
  })

  it('rehearses every pre-submit gate on a form the navigator found, then stops', async () => {
    const { store, deps } = harness({ mode: 'rehearse' })
    await queue(store)
    const report = await runClaimedAttempt((await store.claimAttempt('attempt-1', 'worker-a', 300))!, deps)
    expect(report.outcome).toBe('rehearsed')
    expect(Object.keys(report.submit!.gates!)).toHaveLength(13)
    expect(report.submit!.gates!.on_form_host).toMatchObject({ ok: true, detail: 'careers.example.com' })
    expect(report.submit!.gates!.submit_control).toMatchObject({ ok: true, detail: '"Submit application"' })
    expect(report.submit!.gates!.documents_attached).toMatchObject({ ok: true })
  })

  it('reuses the reviewed draft on the next run instead of writing a new one', async () => {
    const { store, deps, drafts } = harness({ mode: 'rehearse' })
    await queue(store)
    await runClaimedAttempt((await store.claimAttempt('attempt-1', 'worker-a', 300))!, deps)
    const [draft] = await store.listAgentAnswers('ada')
    await store.reviewAgentAnswer('ada', draft.fingerprint, { corrected: 'Developer tools are where I do my best work.' })

    const posting = postingFromUrl('https://careers.example.com/jobs/43', { company: 'Example', role: 'Platform Engineer II' })
    await store.savePosting(posting)
    await store.createAttempt(newAttempt({ id: 'attempt-2', userId: 'ada', jobId: posting.id, targetUrl: posting.apply_url, tailoredDocumentId: applicant.documentId }))
    const report = await runClaimedAttempt((await store.claimAttempt('attempt-2', 'worker-a', 300))!, deps)

    expect(drafts).toHaveLength(1)
    expect(report.filled.find((field) => field.key === 'why')).toMatchObject({ source: 'profile', observed: '44 characters' })
    expect(report.submit!.gates!.answer_sources.ok).toBe(true)
  })
})

// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { FillResult } from 'ats-form-fill'
import type { FormAts } from 'ats-form-fill'
import type { ApplicationProfile } from '../types.js'
import { domDriver, type FormDriver } from './driver.js'
import { decideGates } from './gates.js'
import { runPage } from './pageRun.js'
import { findSubmitControl, SUBMIT_MARK } from './submitControl.js'
import { decideSubmitGates, statedCompanyCap, type SubmitGateInput } from './submitGates.js'

/**
 * The pre-submit gates on the 25 captured forms (test/fixtures/forms),
 * filled by the real fill engine in happy-dom. Typeaheads and Ashby's Yes/No
 * buttons are stood in for, as in gates.fixtures.test.ts. Nothing here ever
 * presses a submit button: the finder only marks it.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/forms')

interface Fixture {
  ats: Exclude<FormAts, 'unknown'>
  slug: string
  html: string
  url: string
  company: string
}

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = []
  for (const ats of ['greenhouse', 'ashby', 'lever'] as const) {
    for (const file of readdirSync(join(FIXTURES, ats)).filter((name) => name.endsWith('.html')).sort()) {
      const slug = file.replace(/\.html$/, '')
      const meta = JSON.parse(readFileSync(join(FIXTURES, ats, `${slug}.meta.json`), 'utf8')) as { url: string; company: string }
      fixtures.push({ ats, slug, html: readFileSync(join(FIXTURES, ats, file), 'utf8'), url: meta.url, company: meta.company })
    }
  }
  return fixtures
}

const PROFILE: ApplicationProfile = {
  client_key: 'user-1',
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 202 555 0143',
  location: 'Berlin, Germany',
  linkedin_url: 'https://www.linkedin.com/in/ada',
  portfolio_url: 'https://ada.dev',
  github_url: 'https://github.com/ada',
  work_authorization: 'Authorized to work in the EU',
  requires_sponsorship: false,
  notice_period_days: 30,
  desired_salary: 90000,
  desired_salary_currency: 'EUR',
  earliest_start_date: '2026-11-15',
  custom_answers: {},
  eeo: {},
}

const PDF = { mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' }
const RESUME = { fileName: 'ada-lovelace.pdf', ...PDF }

function liveWidgets(driver: FormDriver): FormDriver {
  const chosen = new Map<string, string>()
  return {
    ...driver,
    async fillField(field, value, options) {
      if (field.kind !== 'combobox' && field.kind !== 'boolean') return driver.fillField(field, value, options)
      const shown = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)
      chosen.set(field.key, shown)
      return { key: field.key, ok: true, observed: shown, reason: '' } satisfies FillResult
    },
    readField: async (field) => chosen.get(field.key) ?? driver.readField(field),
    settle: async () => {},
  }
}

function watchSubmits(doc: Document): { count: number } {
  const seen = { count: 0 }
  doc.addEventListener('submit', () => seen.count++, true)
  doc.addEventListener('click', () => seen.count++, true)
  return seen
}

async function gated(fixture: Fixture, edit?: (doc: Document) => void) {
  const doc = new DOMParser().parseFromString(fixture.html, 'text/html')
  edit?.(doc)
  const submits = watchSubmits(doc)
  const driver = liveWidgets(domDriver(doc, fixture.url))
  const run = await runPage(driver, {
    ats: fixture.ats,
    questions: [],
    profile: PROFILE,
    company: fixture.company,
    coverLetterText: '',
    documents: { resume: RESUME, coverLetter: null },
  })
  const phase4 = decideGates(run)
  const input: SubmitGateInput = {
    run,
    prePress: await driver.classifyPage(),
    prePressUrl: driver.url(),
    submitTarget: await driver.findSubmit(fixture.ats),
    questions: [],
    agentQuestionIds: [],
    reviewedQuestionIds: [],
    drafts: { policy: 'review_first', reviewedCount: 0, reviewFirst: 5 },
    approved: false,
    documents: { tailoredDocumentId: 'doc-1', resumeFileName: RESUME.fileName, coverLetterFileName: null, coverLetterText: '' },
    job: { active: true },
    caps: { appliedToday: 0, dailyLimit: 5, companyApplied: 0, companyCap: 1, companyWindowDays: 30 },
    budget: { spentUsd: 0, budgetUsd: 4, thisRunUsd: 0.002 },
    eligibility: { matchScore: null, minMatch: 0.6, verdict: null },
  }
  return { doc, submits, run, phase4, decision: decideSubmitGates(input), text: await driver.pageText() }
}

const fixtures = loadFixtures()
const bySlug = (prefix: string) => fixtures.find((fixture) => fixture.slug.startsWith(prefix))!

describe('the submit button on the captured forms', () => {
  it.each(fixtures.map((fixture) => [`${fixture.ats}/${fixture.slug}`, fixture] as const))('%s: one visible control says submit', (_name, fixture) => {
    const doc = new DOMParser().parseFromString(fixture.html, 'text/html')
    const submits = watchSubmits(doc)
    const target = findSubmitControl(doc, fixture.ats)
    expect(target).not.toBeNull()
    expect(target!.text).toMatch(/submit/i)
    expect(target!.disabled).toBe(false)
    expect(target!.count).toBe(1)
    // Marked, not pressed.
    expect(doc.querySelectorAll(`[${SUBMIT_MARK}]`)).toHaveLength(1)
    expect(submits.count).toBe(0)
  })

  it("picks Lever's visible button, never the hidden hCaptcha one", () => {
    const fixture = fixtures.find((entry) => entry.ats === 'lever')!
    const doc = new DOMParser().parseFromString(fixture.html, 'text/html')
    findSubmitControl(doc, 'lever')
    expect(doc.querySelector(`[${SUBMIT_MARK}]`)!.id).toBe('btn-submit')
  })

  it('finds nothing on a page whose button says something else', () => {
    const doc = new DOMParser().parseFromString('<form id="application-form"><button type="submit">Next</button></form>', 'text/html')
    expect(findSubmitControl(doc, 'greenhouse')).toBeNull()
  })
})

describe('pre-submit gates on the captured forms', () => {
  it('pass a fully answered form, without pressing anything', async () => {
    for (const prefix of ['mavenclinic', 'roboflow']) {
      const { decision, phase4, submits } = await gated(bySlug(prefix))
      expect(phase4.outcome, prefix).toBe('passed')
      expect(decision.outcome, `${prefix}: ${JSON.stringify(Object.entries(decision.gates).filter(([, gate]) => !gate.ok))}`).toBe('passed')
      expect(submits.count).toBe(0)
    }
  })

  it("put Blissway off-limits: its bot-trap box is left alone, and the posting is not submitted", async () => {
    const { decision, run } = await gated(bySlug('blissway'))
    expect(run.left.find((field) => field.reason === 'trap')).toBeDefined()
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'trap' })
    const items = decision.gates.no_trap.items ?? []
    expect(items).toEqual([expect.objectContaining({ why: 'trap wording', label: expect.stringContaining('reviewed the Job Description') })])
  })

  it('also catch the Blissway box if something ticked it', async () => {
    const { decision } = await gated(bySlug('blissway'), (doc) => {
      const box = doc.querySelector<HTMLInputElement>('input[type="checkbox"][name="Yes"]')!
      box.setAttribute('checked', '')
      box.checked = true
    })
    expect(decision.blockedReason).toBe('trap')
    expect(decision.gates.no_trap.items).toEqual(expect.arrayContaining([expect.objectContaining({ why: 'ticked but never planned' })]))
  })

  it("read Ashby's stated application limit off the page", async () => {
    const { text } = await gated(bySlug('ashby-56941cfb'))
    expect(statedCompanyCap(text)).toEqual({ cap: 3, days: 60 })
  })

  it('let a scoring script through at the press', async () => {
    const { decision } = await gated(bySlug('mavenclinic'), (doc) => {
      doc.head.insertAdjacentHTML('beforeend', '<script src="https://www.google.com/recaptcha/api.js"></script>')
    })
    // Loaded, not on screen: a scoring script every applicant gets.
    expect(decision.gates.no_challenge.ok).toBe(true)
  })
})

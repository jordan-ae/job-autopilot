// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Attempt } from '../attempt.js'
import type { BrowserSession } from '../browser/provider.js'
import type { FillResult } from 'ats-form-fill'
import type { ApplicationProfile } from '../types.js'
import { domDriver, type FormDriver } from './driver.js'
import { runClaimedAttempt, type ExecutorDeps, type PrepareResult } from './run.js'
import { pressAndConfirm } from './submit.js'
import type { SubmitFacts, SubmitRunDeps, AfterRun } from './submitRun.js'
import type { SubmitMode } from './submitPolicy.js'
import type { HoldResult } from '../store/types.js'
import { DEFAULT_SETTINGS, type AutopilotSettings } from '../settings.js'

/**
 * The submit step end to end, offline: a captured Greenhouse form in
 * happy-dom, filled by the real engine; the "employer" answers the press by
 * replacing the page, the way the live form does. Every store and billing
 * call is a fake that records what it was asked.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/forms/greenhouse')
const MAVEN = readFileSync(join(FIXTURES, 'mavenclinic-88643130.html'), 'utf8')
const MAVEN_URL = 'https://job-boards.greenhouse.io/embed/job_app?for=mavenclinic&token=88643130'

const PROFILE: ApplicationProfile = {
  client_key: 'user-1',
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 202 555 0143',
  location: 'Berlin, Germany',
  linkedin_url: 'https://www.linkedin.com/in/ada',
  portfolio_url: '',
  github_url: '',
  work_authorization: 'Authorized to work in the EU',
  requires_sponsorship: false,
  notice_period_days: 30,
  desired_salary: null,
  desired_salary_currency: 'EUR',
  earliest_start_date: null,
  custom_answers: {},
  eeo: {},
}

const RESUME = { fileName: 'Ada-Lovelace-Maven-Clinic.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' }

function prepared(): PrepareResult {
  return {
    ok: true,
    run: {
      ref: { ats: 'greenhouse', board: 'mavenclinic', jobId: '88643130' },
      ctx: {
        job: { id: 'job-1', company: 'Maven Clinic', role: 'Engineer', location: '', apply_url: '', source_id: null, ats: 'greenhouse', ats_job_id: 'mavenclinic:88643130' },
        profile: PROFILE,
        resumePdf: Buffer.from('%PDF-1.4'),
        coverLetterText: '',
        resumeFileName: RESUME.fileName,
      },
      documents: { resume: RESUME, coverLetter: null },
    },
  }
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'attempt-1',
    client_key: 'user-1',
    job_id: 'job-1',
    application_id: null,
    tailored_document_id: 'doc-1',
    executor: 'browser',
    origin: 'autopilot',
    status: 'preparing',
    pending_questions: [],
    payload: { questions: [] },
    target_url: '',
    confirmation: '',
    error: '',
    attempts: 1,
    approved_at: null,
    submitted_at: null,
    created_at: '2026-10-20T10:00:00Z',
    cost_usd: 0.01,
    gate_results: {},
    lease_owner: 'worker-a',
    dry_run: false,
    ...overrides,
  }
}

function liveWidgets(driver: FormDriver): FormDriver {
  const chosen = new Map<string, string>()
  return {
    ...driver,
    async fillField(field, value, options) {
      if (field.kind !== 'combobox' && field.kind !== 'boolean') return driver.fillField(field, value, options)
      chosen.set(field.key, String(value))
      return { key: field.key, ok: true, observed: String(value), reason: '' } satisfies FillResult
    },
    readField: async (field) => chosen.get(field.key) ?? driver.readField(field),
    settle: async () => {},
  }
}

/** How the "employer" answers the press. */
type Employer = 'confirm' | 'invalid' | 'silent' | 'captcha' | 'navigate-then-confirm'

function answerPress(doc: Document, employer: Employer, presses: { count: number }) {
  doc.addEventListener(
    'click',
    (event) => {
      const button = (event.target as HTMLElement | null)?.closest?.('button[type="submit"]')
      if (!button) return
      presses.count++
      if (employer === 'confirm' || employer === 'navigate-then-confirm') {
        doc.body.innerHTML = '<main><h1>Thank you for applying.</h1><p>Your application has been submitted.</p></main>'
      } else if (employer === 'invalid') {
        doc.querySelector('#email')?.setAttribute('aria-invalid', 'true')
      } else if (employer === 'captcha') {
        doc.querySelector('form')!.insertAdjacentHTML('beforeend', '<input id="security-code" type="text">')
      }
    },
    true,
  )
}

interface Options {
  mode?: SubmitMode
  employer?: Employer
  settings?: Partial<AutopilotSettings>
  facts?: Partial<SubmitFacts>
  marked?: 'marked' | 'lost'
  writeAfterPress?: Awaited<ReturnType<SubmitRunDeps['writeAfterPress']>>
  writeLate?: Awaited<ReturnType<SubmitRunDeps['writeLate']>>
  /** Breaks the run after the press (lease recovery case). */
  failAfterPress?: boolean
  confirm?: boolean
  /** What each holdCredit call answers, in turn (the last one repeats). Default: held. */
  holds?: HoldResult[]
  /** The agent route: navigation finds the same form on an employer's own host. */
  agent?: boolean
  /** The agentSubmit option. */
  agentSubmit?: boolean
}

const EMPLOYER_URL = 'https://careers.example.com/jobs/42/apply'

function harness(options: Options = {}) {
  let clock = Date.parse('2026-10-20T12:00:00Z')
  const presses = { count: 0 }
  const calls = {
    sessions: 0,
    closes: 0,
    writes: [] as Array<{ from: string; patch: Record<string, unknown> }>,
    released: [] as string[],
    charged: [] as string[],
    marked: [] as string[],
    applications: 0,
    screenshots: 0,
    late: [] as Array<Record<string, unknown>>,
    after: [] as AfterRun[],
    holds: 0,
    /** What happened, in order: 'hold', 'mark', 'press'. */
    order: [] as string[],
  }
  const facts: SubmitFacts = {
    jobActive: true,
    appliedToday: 0,
    dailyLimit: 5,
    companyApplied: 0,
    companyCap: 1,
    companyWindowDays: 30,
    spentUsd: 0.2,
    budgetUsd: 4,
    reviewedDrafts: 0,
    reviewedQuestionIds: [],
    eligibility: null,
    nextWindowAt: clock + 20 * 3600_000,
    profileName: null,
    ...options.facts,
  }
  const submit: SubmitRunDeps = {
    context: async () => ({ policy: { mode: options.mode ?? 'submit', reason: 'test' }, settings: { ...DEFAULT_SETTINGS, ...options.settings } }),
    facts: async () => facts,
    markClicked: async (_id, _owner, at) => {
      calls.marked.push(at)
      calls.order.push('mark')
      return options.marked ?? 'marked'
    },
    writeAfterPress: async (_id, _owner, patch) => {
      calls.writes.push({ from: 'submitting', patch })
      return options.writeAfterPress ?? 'written'
    },
    writeLate: async (_id, _at, patch) => {
      calls.late.push(patch)
      return options.writeLate ?? 'written'
    },
    charge: async (id) => {
      calls.charged.push(id)
    },
    holdCredit: async (row) => {
      calls.holds++
      calls.order.push('hold')
      const answers = options.holds ?? [{ ok: true, renewed: false }]
      return answers[Math.min(calls.holds - 1, answers.length - 1)]
    },
    recordApplication: async () => {
      calls.applications++
      return 'app-1'
    },
    uploadScreenshot: async (userId, attemptId) => {
      calls.screenshots++
      return { path: `${userId}/${attemptId}.png`, expiresAt: '2027-01-18T12:00:00.000Z' }
    },
    afterRun: async (input) => {
      calls.after.push(input)
    },
    confirmTimeoutMs: 30_000,
    // The fake clock moves with every wait, so a silent page times out.
    sleep: async (ms) => {
      clock += ms
    },
    ...(options.confirm !== undefined ? { confirmPress: async () => options.confirm! } : {}),
  }
  const deps: ExecutorDeps = {
    owner: 'worker-a',
    leaseSeconds: 300,
    maxRuns: 3,
    now: () => clock,
    allowed: async () => true,
    prepare: async () => {
      const ready = prepared()
      if (!options.agent || !ready.ok) return ready
      return { ok: true, run: { ...ready.run, ref: null, agent: { startUrl: 'https://careers.example.com/jobs/42' } } }
    },
    openSession: async () => {
      calls.sessions++
      return {
        provider: 'local',
        sessionId: 'local-1',
        inspectUrl: '',
        solvesCaptchas: false,
        context: {} as BrowserSession['context'],
        close: async () => {
          calls.closes++
          return { costUsd: null }
        },
      }
    },
    openForm: async () => form(MAVEN_URL),
    navigate: async () => ({ kind: 'form', driver: await form(EMPLOYER_URL), url: EMPLOYER_URL, host: 'careers.example.com', multiStep: false, hops: [] }),
    agentSubmit: options.agentSubmit ?? false,
    settle: async (id) => {
      calls.released.push(id)
    },
    write: async (_id, _owner, patch) => {
      calls.writes.push({ from: 'preparing', patch })
      return 'written'
    },
    submit,
  }
  async function form(url: string): Promise<FormDriver> {
    clock += 10_000
    const doc = new DOMParser().parseFromString(MAVEN, 'text/html')
    answerPress(doc, options.employer ?? 'confirm', presses)
    // happy-dom has no screen; stand in for the browser's PNG.
    const driver: FormDriver = { ...liveWidgets(domDriver(doc, url)), screenshot: async () => Buffer.from('PNG') }
    if (!options.failAfterPress) return driver
    return {
      ...driver,
      pressSubmit: async (target) => {
        await driver.pressSubmit(target)
        throw new Error('Target page, context or browser has been closed')
      },
      classifyPage: async () => {
        if (presses.count > 0) throw new Error('Target page, context or browser has been closed')
        return driver.classifyPage()
      },
    }
  }
  return { deps, calls, presses }
}

describe('the submit step', () => {
  it('an agent-route form is rehearsed, never pressed, while agent submit is off', async () => {
    const { deps, calls, presses } = harness({ employer: 'confirm', agent: true })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(presses.count).toBe(0)
    expect(calls.marked).toEqual([])
    expect(result).toMatchObject({ mode: 'rehearse', outcome: 'rehearsed', status: 'awaiting_approval' })
    expect(result.submit?.gates?.on_form_host).toMatchObject({ ok: true, detail: 'careers.example.com' })
    expect(calls.charged).toEqual([])
    expect(calls.released).toEqual(['attempt-1'])
  })

  it('an agent-route form goes through the same pre-submit gates and press once agent submit is on', async () => {
    const { deps, calls, presses } = harness({ employer: 'confirm', agent: true, agentSubmit: true })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(result.submit?.gates && Object.values(result.submit.gates).every((gate) => gate.ok)).toBe(true)
    expect(presses.count).toBe(1)
    expect(result).toMatchObject({ mode: 'submit', outcome: 'submitted', status: 'submitted' })
    expect(calls.marked).toHaveLength(1)
    expect(calls.charged).toEqual(['attempt-1'])
  })

  it('confirmation: submitted, charged, on the tracker, with a receipt and a screenshot', async () => {
    const { deps, calls, presses } = harness({ employer: 'confirm' })
    const result = await runClaimedAttempt(attempt(), deps)

    expect(presses.count).toBe(1)
    expect(calls.marked).toHaveLength(1)
    expect(result).toMatchObject({ outcome: 'submitted', status: 'submitted', mode: 'submit' })
    expect(result.submit).toMatchObject({ result: 'confirmed', target: 'Submit application', clickedAt: calls.marked[0] })
    const [{ from, patch }] = calls.writes
    expect(from).toBe('submitting')
    expect(patch).toMatchObject({ status: 'submitted', application_id: 'app-1', blocked_reason: '', lease_owner: '' })
    expect(String(patch.confirmation)).toMatch(/Thank you for applying/)
    expect(patch.gate_results).toMatchObject({ submit: { mode: 'submit', outcome: 'submitted', result: 'confirmed', clicked_at: calls.marked[0] } })
    expect(calls.charged).toEqual(['attempt-1'])
    expect(calls.released).toEqual([])
    expect(calls.applications).toBe(1)
    expect(calls.screenshots).toBe(1)
    expect(calls.after[0].receipt).toMatchObject({ status: 'submitted', confirmation: { text: expect.stringMatching(/Thank you/) }, screenshot: { path: 'user-1/attempt-1.png' } })
    expect(calls.closes).toBe(1)
  })

  it('validation error after the press: blocked, nothing re-pressed, credit released', async () => {
    const { deps, calls, presses } = harness({ employer: 'invalid' })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(presses.count).toBe(1)
    expect(result).toMatchObject({ outcome: 'hand_back', status: 'blocked' })
    expect(result.submit?.result).toBe('validation_error')
    expect(calls.writes[0]).toMatchObject({ from: 'submitting', patch: { status: 'blocked', executor: 'assisted', blocked_reason: 'validation' } })
    expect(calls.released).toEqual(['attempt-1'])
    expect(calls.charged).toEqual([])
    expect(calls.applications).toBe(0)
    expect(calls.after[0].receipt).toBeNull()
  })

  it('a bot check after the press: blocked with its kind, released, and measured', async () => {
    const { deps, calls } = harness({ employer: 'captcha' })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(result.submit).toMatchObject({ result: 'challenge', challengeAfterPress: 'email-code' })
    expect(calls.writes[0].patch).toMatchObject({ status: 'blocked', blocked_reason: 'email-code' })
    expect(calls.writes[0].patch.gate_results).toMatchObject({ submit: { challenge_after_press: 'email-code' } })
    expect(calls.released).toEqual(['attempt-1'])
  })

  it('no confirmation in time: unconfirmed, credit held, receipt kept', async () => {
    const { deps, calls, presses } = harness({ employer: 'silent' })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(presses.count).toBe(1)
    expect(result).toMatchObject({ outcome: 'unconfirmed', status: 'unconfirmed' })
    expect(result.submit?.result).toBe('timeout')
    expect(result.submit?.waitedMs).toBeGreaterThanOrEqual(30_000)
    expect(calls.writes[0]).toMatchObject({ from: 'submitting', patch: { status: 'unconfirmed' } })
    expect(calls.charged).toEqual([])
    expect(calls.released).toEqual([])
    expect(calls.after[0].receipt).toMatchObject({ status: 'unconfirmed', confirmation: null })
  })

  describe('never twice', () => {
    it('presses nothing when the compare-and-set finds the attempt taken', async () => {
      const { deps, calls, presses } = harness({ marked: 'lost' })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(0)
      // Never pressed, so nothing reached the employer: an ordinary failed run.
      expect(result.outcome).toBe('retry')
      expect(calls.writes[0]).toMatchObject({ from: 'preparing', patch: { status: 'ready' } })
      expect(calls.charged).toEqual([])
    })

    it('opens no browser for an attempt whose submit was already pressed', async () => {
      const { deps, calls, presses } = harness()
      const result = await runClaimedAttempt(attempt({ submit_clicked_at: '2026-10-20T11:00:00Z' }), deps)
      expect(calls.sessions).toBe(0)
      expect(presses.count).toBe(0)
      expect(result).toMatchObject({ outcome: 'unconfirmed', status: 'unconfirmed' })
      expect(calls.released).toEqual([])
    })

    it('presses once even when the page stays silent for the whole wait', async () => {
      const { deps, presses } = harness({ employer: 'silent' })
      await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(1)
    })
  })

  describe('lease recovery after the click', () => {
    it('a run that breaks after the press ends unconfirmed, never back in the queue', async () => {
      const { deps, calls, presses } = harness({ failAfterPress: true })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(1)
      expect(result).toMatchObject({ outcome: 'unconfirmed', status: 'unconfirmed' })
      expect(calls.writes[0]).toMatchObject({ from: 'submitting', patch: { status: 'unconfirmed' } })
      expect(calls.writes.some((write) => write.patch.status === 'ready')).toBe(false)
      expect(calls.charged).toEqual([])
      expect(calls.released).toEqual([])
    })

    it('a confirmation that lands after recovery called it unconfirmed still settles it', async () => {
      const { deps, calls } = harness({ employer: 'confirm', writeAfterPress: 'lease_lost' })
      await runClaimedAttempt(attempt(), deps)
      expect(calls.late).toHaveLength(1)
      expect(calls.late[0]).toMatchObject({ status: 'submitted' })
      expect(calls.late[0]).not.toHaveProperty('lease_owner')
      expect(calls.charged).toEqual(['attempt-1'])
    })

    it('with neither write landing, nothing is charged and the receipt says unconfirmed', async () => {
      const { deps, calls } = harness({ employer: 'confirm', writeAfterPress: 'lease_lost', writeLate: 'lease_lost' })
      await runClaimedAttempt(attempt(), deps)
      expect(calls.charged).toEqual([])
      expect(calls.after[0]).toMatchObject({ written: 'lease_lost', pressed: true })
    })
  })

  describe('modes', () => {
    it('review: filled, checked and parked for approval; credit held; no press', async () => {
      const { deps, calls, presses } = harness({ mode: 'review' })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(0)
      expect(result).toMatchObject({ outcome: 'review', status: 'awaiting_approval', mode: 'review' })
      expect(calls.writes[0].patch.executor).toBeUndefined()
      expect(calls.writes[0].patch.gate_results).toMatchObject({ submit: { outcome: 'review' } })
      expect(calls.released).toEqual([])
      expect(calls.screenshots).toBe(1)
      expect(calls.after[0].receipt).toMatchObject({ status: 'preview' })
    })

    it('rehearse: every gate and the screenshot, then stops; credit released', async () => {
      const { deps, calls, presses } = harness({ mode: 'rehearse' })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(0)
      expect(calls.marked).toEqual([])
      expect(result).toMatchObject({ outcome: 'rehearsed', status: 'awaiting_approval' })
      expect(result.submit?.gates && Object.values(result.submit.gates).every((gate) => gate.ok)).toBe(true)
      expect(calls.writes[0].patch).toMatchObject({ executor: 'assisted' })
      expect(calls.released).toEqual(['attempt-1'])
      expect(calls.screenshots).toBe(1)
    })

    it('hold (paused, off, breaker open): no browser, the run is not counted, credit held', async () => {
      const { deps, calls } = harness({ mode: 'hold' })
      const result = await runClaimedAttempt(attempt({ attempts: 2 }), deps)
      expect(calls.sessions).toBe(0)
      expect(result).toMatchObject({ outcome: 'hold', status: 'ready' })
      expect(calls.writes[0].patch).toMatchObject({ status: 'ready', attempts: 1 })
      expect(Date.parse(String(calls.writes[0].patch.lease_expires_at)) - Date.parse(result.finishedAt)).toBe(15 * 60_000)
      expect(calls.released).toEqual([])
    })

    it('dry_run: fill and the form gates only, no pre-submit gates', async () => {
      const { deps, calls, presses } = harness({ mode: 'dry_run' })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(0)
      expect(result).toMatchObject({ outcome: 'passed', status: 'awaiting_approval', mode: 'dry_run' })
      expect(result.submit).toBeUndefined()
      expect(calls.released).toEqual(['attempt-1'])
    })

    it('confirmation: not typing the company name stops before the press', async () => {
      const { deps, calls, presses } = harness({ confirm: false })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(0)
      expect(result.outcome).toBe('rehearsed')
      expect(calls.released).toEqual(['attempt-1'])
    })
  })

  describe('a gate that fails stops the press', () => {
    it('the daily cap holds it for the next window', async () => {
      const next = Date.parse('2026-10-21T08:00:00Z')
      const { deps, calls, presses } = harness({ facts: { appliedToday: 5, dailyLimit: 5, nextWindowAt: next } })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(0)
      expect(result.outcome).toBe('hold')
      expect(calls.writes[0].patch).toMatchObject({ status: 'ready', lease_expires_at: new Date(next).toISOString(), attempts: 0 })
      expect(calls.released).toEqual([])
    })

    it('the company cap hands it back and releases the credit', async () => {
      const { deps, calls, presses } = harness({ facts: { companyApplied: 1 } })
      const result = await runClaimedAttempt(attempt(), deps)
      expect(presses.count).toBe(0)
      expect(result).toMatchObject({ outcome: 'hand_back', status: 'blocked' })
      expect(calls.writes[0].patch).toMatchObject({ blocked_reason: 'company_cap', executor: 'assisted' })
      expect(calls.released).toEqual(['attempt-1'])
    })
  })
})

describe('no press without a live credit hold', () => {
  const exhausted: HoldResult = { ok: false, reason: 'credits_exhausted' }
  const held: HoldResult = { ok: true, renewed: false }

  it('checks the hold before opening a browser, and again right before the press', async () => {
    const { deps, calls, presses } = harness({ employer: 'confirm' })
    await runClaimedAttempt(attempt(), deps)
    expect(presses.count).toBe(1)
    expect(calls.holds).toBe(2)
    expect(calls.order).toEqual(['hold', 'hold', 'mark'])
  })

  it('out of credits before the run: no browser, parked for a top-up, nothing settled', async () => {
    const { deps, calls, presses } = harness({ holds: [exhausted] })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(calls.sessions).toBe(0)
    expect(presses.count).toBe(0)
    expect(result).toMatchObject({ outcome: 'credits', status: 'awaiting_approval' })
    const [{ from, patch }] = calls.writes
    expect(from).toBe('preparing')
    // Still the cloud browser's: approving after a top-up sends it back to the queue.
    expect(patch).toMatchObject({ status: 'awaiting_approval', blocked_reason: 'credits_exhausted', lease_owner: '' })
    expect(patch.executor).toBeUndefined()
    expect(calls.released).toEqual([])
    expect(calls.charged).toEqual([])
  })

  it('hold gone between opening the browser and the press, none to take: filled, never pressed, parked with a preview', async () => {
    const { deps, calls, presses } = harness({ holds: [held, exhausted] })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(calls.sessions).toBe(1)
    expect(presses.count).toBe(0)
    expect(calls.marked).toEqual([])
    expect(result).toMatchObject({ outcome: 'credits', status: 'awaiting_approval' })
    expect(calls.writes[0].patch).toMatchObject({ blocked_reason: 'credits_exhausted' })
    expect(calls.writes[0].patch.gate_results).toMatchObject({ submit: { outcome: 'credits' } })
    expect(calls.after[0].receipt).toMatchObject({ status: 'preview' })
    expect(calls.released).toEqual([])
    expect(calls.charged).toEqual([])
  })

  it('a ledger it cannot read: nothing pressed, the run is tried again later', async () => {
    const { deps, calls, presses } = harness({ holds: [held, { ok: false, reason: 'unavailable' }] })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(presses.count).toBe(0)
    expect(result.outcome).toBe('retry')
    expect(calls.writes[0].patch).toMatchObject({ status: 'ready' })
  })

  it('an attempt already charged is never pressed again', async () => {
    const { deps, calls, presses } = harness({ holds: [{ ok: false, reason: 'already_charged' }] })
    const result = await runClaimedAttempt(attempt(), deps)
    expect(presses.count).toBe(0)
    expect(result).toMatchObject({ status: 'blocked' })
    expect(calls.writes[0].patch).toMatchObject({ blocked_reason: 'already_charged' })
    expect(calls.released).toEqual([])
  })

  it('review, rehearse and dry_run never press, so never take a credit', async () => {
    for (const mode of ['review', 'rehearse', 'dry_run'] as const) {
      const { deps, calls } = harness({ mode })
      await runClaimedAttempt(attempt(), deps)
      expect(calls.holds).toBe(0)
    }
  })
})

describe('pressAndConfirm', () => {
  const page = (state: 'form' | 'confirmation' | 'validation_error') => ({ state, evidence: state, challenges: [] })
  const target = { selector: '#go', text: 'Submit', disabled: false, count: 1 }

  function driver(states: Array<ReturnType<typeof page>>, onPress: () => void = () => {}): FormDriver {
    let index = 0
    return {
      classifyPage: async () => states[Math.min(index++, states.length - 1)],
      pressSubmit: async () => onPress(),
      url: () => 'https://jobs.ashbyhq.com/acme/1/application',
    } as unknown as FormDriver
  }

  const clock = () => {
    let now = 0
    return { now: () => now, sleep: async (ms: number) => void (now += ms) }
  }

  it('waits out a validation flash that clears', async () => {
    const time = clock()
    const outcome = await pressAndConfirm(driver([page('validation_error'), page('form'), page('confirmation')]), target, {
      markClicked: async () => 'marked',
      timeoutMs: 10_000,
      ...time,
    })
    expect(outcome.kind).toBe('confirmed')
  })

  it('reports a validation error that stays', async () => {
    const time = clock()
    const outcome = await pressAndConfirm(driver([page('validation_error')]), target, { markClicked: async () => 'marked', timeoutMs: 10_000, ...time })
    expect(outcome.kind).toBe('validation_error')
  })

  it('never presses when the mark fails', async () => {
    let pressed = 0
    const time = clock()
    const outcome = await pressAndConfirm(driver([page('confirmation')], () => pressed++), target, {
      markClicked: async () => ({ error: 'connection reset' }),
      timeoutMs: 10_000,
      ...time,
    })
    expect(pressed).toBe(0)
    expect(outcome).toEqual({ kind: 'not_pressed', reason: 'mark failed: connection reset' })
  })

  it('keeps waiting through a press that threw, and a page mid-navigation', async () => {
    const time = clock()
    let calls = 0
    const flaky = {
      classifyPage: async () => {
        calls++
        if (calls === 1) throw new Error('Execution context was destroyed')
        return page('confirmation')
      },
      pressSubmit: async () => {
        throw new Error('Timeout 10000ms exceeded')
      },
      url: () => 'https://jobs.lever.co/acme/1/thanks',
    } as unknown as FormDriver
    const outcome = await pressAndConfirm(flaky, target, { markClicked: async () => 'marked', timeoutMs: 10_000, ...time })
    expect(outcome).toMatchObject({ kind: 'confirmed', pressError: 'Timeout 10000ms exceeded', url: 'https://jobs.lever.co/acme/1/thanks' })
  })
})

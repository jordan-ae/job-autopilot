// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true,"navigation":{"disableChildFrameNavigation":true,"disableChildPageNavigation":true}}}
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Attempt } from '../attempt.js'
import type { BrowserSession } from '../browser/provider.js'
import type { FillResult } from 'ats-form-fill'
import type { ApplicationProfile, ApplyQuestion } from '../types.js'
import { domDriver, type FormDriver } from './driver.js'
import type { ExecutionReport } from './report.js'
import { runClaimedAttempt, type ExecutorDeps, type PrepareResult } from './run.js'
import type { NavOutcome } from '../navigator/navigate.js'

/**
 * The runner around the page: claim in, result out. Everything that touches
 * the outside — the browser, the database, the ledger — is a fake here, and
 * the "browser" serves a captured Greenhouse form through happy-dom. Nothing
 * reaches Browserbase.
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

function prepared(profile = PROFILE): PrepareResult {
  return {
    ok: true,
    run: {
      ref: { ats: 'greenhouse', board: 'mavenclinic', jobId: '88643130' },
      ctx: {
        job: { id: 'job-1', company: 'Maven Clinic', role: 'Engineer', location: '', apply_url: '', source_id: null, ats: 'greenhouse', ats_job_id: 'mavenclinic:88643130' },
        profile,
        resumePdf: Buffer.from('%PDF-1.4'),
        coverLetterText: 'Dear team,\n\nHello.',
        resumeFileName: 'Ada-Lovelace-Maven-Clinic.pdf',
      },
      documents: {
        resume: { fileName: 'Ada-Lovelace-Maven-Clinic.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' },
        coverLetter: null,
      },
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
    gate_results: { agent_budget: { allowed: true } },
    lease_owner: 'worker-a',
    ...overrides,
  }
}

/** Typeaheads need the page's own JavaScript; stand in for them (see gates.fixtures.test.ts). */
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

/** What the runner asked to write, as the tests read it. */
interface Patch {
  [column: string]: unknown
  status: string
  executor?: string
  error: string
  cost_usd: number
  pending_questions: ApplyQuestion[]
  payload: { questions: ApplyQuestion[]; executorRuns: Array<ExecutionReport | { run: number }> }
}

interface Options {
  allowed?: boolean
  prepare?: PrepareResult
  provider?: 'browserbase' | 'browseruse' | 'local'
  /** What the provider says the session cost, on close. */
  reportedUsd?: number | null
  solvesCaptchas?: boolean
  openSession?: () => Promise<never>
  /** Browser time the form takes to load, on the fake clock. */
  browseMs?: number
  /** Replaces the page: throw, hang, or edit the document. */
  openForm?: (doc: Document) => Promise<FormDriver> | never
  write?: Awaited<ReturnType<ExecutorDeps['write']>>
  leaseSeconds?: number
  /** The agent route: what navigation finds. `form` serves Maven's form on `url`. */
  navigate?: { kind: 'form'; url: string; multiStep?: boolean } | Exclude<NavOutcome, { kind: 'form' }>
}

function harness(options: Options = {}) {
  let clock = Date.parse('2026-10-20T12:00:00Z')
  const calls = { sessions: 0, closes: 0, navigations: 0, forms: 0, writes: [] as Patch[], released: [] as string[] }
  const deps: ExecutorDeps = {
    owner: 'worker-a',
    leaseSeconds: options.leaseSeconds ?? 300,
    maxRuns: 3,
    now: () => clock,
    allowed: async () => options.allowed ?? true,
    prepare: async () => options.prepare ?? prepared(),
    openSession: async () => {
      if (options.openSession) return options.openSession()
      calls.sessions++
      return {
        provider: options.provider ?? 'browserbase',
        sessionId: 'bb-session-1',
        inspectUrl: '',
        solvesCaptchas: options.solvesCaptchas ?? false,
        context: {} as BrowserSession['context'],
        close: async () => {
          calls.closes++
          return { costUsd: options.reportedUsd ?? null }
        },
      }
    },
    openForm: async () => {
      calls.forms++
      clock += options.browseMs ?? 20_000
      const doc = new DOMParser().parseFromString(MAVEN, 'text/html')
      if (options.openForm) return options.openForm(doc)
      return liveWidgets(domDriver(doc, MAVEN_URL))
    },
    navigate: async () => {
      calls.navigations++
      const nav = options.navigate ?? { kind: 'lost', detail: 'no navigate option', url: '', hops: [] }
      if (nav.kind !== 'form') return nav
      clock += options.browseMs ?? 20_000
      const doc = new DOMParser().parseFromString(MAVEN, 'text/html')
      const host = new URL(nav.url).hostname
      return { kind: 'form', driver: liveWidgets(domDriver(doc, nav.url)), url: nav.url, host, multiStep: nav.multiStep ?? false, hops: [{ url: nav.url, action: 'stop: application form', inputs: 12, passwords: 0 }] }
    },
    agentSubmit: false,
    settle: async (attemptId) => {
      calls.released.push(attemptId)
    },
    write: async (_id, _owner, patch) => {
      calls.writes.push(patch as Patch)
      return options.write ?? 'written'
    },
  }
  return { deps, calls }
}

const lastReport = (patch: Patch) => patch.payload.executorRuns.at(-1) as ExecutionReport

describe('runClaimedAttempt', () => {
  it('fills, checks and stops before submit, then gives the attempt to the user', async () => {
    const { deps, calls } = harness()
    const report = await runClaimedAttempt(attempt(), deps)

    expect(report).toMatchObject({ outcome: 'passed', status: 'awaiting_approval', mode: 'dry_run', provider: 'browserbase', sessionId: 'bb-session-1' })
    expect(report.counts.filled).toBeGreaterThan(5)
    expect(report.counts.failed).toBe(0)
    expect(report.formUrl).toBe(MAVEN_URL)
    expect(Object.values(report.gates!).every((gate) => gate.ok)).toBe(true)

    expect(calls.sessions).toBe(1)
    expect(calls.closes).toBe(1)
    const [patch] = calls.writes
    // A dry run that passed is not a hand-off: it waits like any assisted attempt.
    expect(patch).toMatchObject({ status: 'awaiting_approval', executor: 'assisted', blocked_reason: '', lease_owner: '', lease_expires_at: null, error: '' })
    // Earlier gate results stay; the executor's are added beside them.
    expect(patch.gate_results).toMatchObject({ agent_budget: { allowed: true }, executor: { outcome: 'passed', passed: true, dry_run: true } })
    expect(lastReport(patch).outcome).toBe('passed')
    // Nothing was sent, so the credit goes back.
    expect(calls.released).toEqual(['attempt-1'])
  })

  it('never shows the applicant’s long answers in full in the report', async () => {
    const { deps } = harness()
    const report = await runClaimedAttempt(attempt(), deps)
    for (const field of report.filled) expect(field.observed.length).toBeLessThanOrEqual(80)
  })

  describe('cost', () => {
    it('adds the run’s browser minutes to cost_usd, one-minute minimum', async () => {
      const { deps, calls } = harness({ browseMs: 20_000 })
      const report = await runClaimedAttempt(attempt({ cost_usd: 0.01 }), deps)
      expect(report.cost).toEqual({ browserMinutes: 1, browserUsd: 0.002, modelUsd: 0, totalUsd: 0.002, source: 'estimate' })
      expect(calls.writes[0].cost_usd).toBeCloseTo(0.012, 9)
    })

    it('bills by the started minute', async () => {
      const { deps, calls } = harness({ browseMs: 150_000 })
      const report = await runClaimedAttempt(attempt({ cost_usd: '0' }), deps)
      expect(report.cost.browserMinutes).toBe(3)
      expect(calls.writes[0].cost_usd).toBeCloseTo(0.006, 9)
    })

    it('charges nothing for a local browser', async () => {
      const { deps, calls } = harness({ provider: 'local', browseMs: 150_000 })
      await runClaimedAttempt(attempt({ cost_usd: 0.01 }), deps)
      expect(calls.writes[0].cost_usd).toBe(0.01)
    })

    it('records what a failed run cost too', async () => {
      const { deps, calls } = harness({
        openForm: () => {
          throw new Error('page crashed')
        },
      })
      await runClaimedAttempt(attempt({ cost_usd: 0 }), deps)
      expect(calls.writes[0].cost_usd).toBe(0.002)
    })
  })

  describe('releasing the browser', () => {
    it('when the page fails to load', async () => {
      const { deps, calls } = harness({
        openForm: () => {
          throw new Error('net::ERR_TIMED_OUT')
        },
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(calls.closes).toBe(1)
      // Our failure, and runs are left: back in the queue, credit still held.
      expect(report).toMatchObject({ outcome: 'retry', status: 'ready', error: 'net::ERR_TIMED_OUT' })
      expect(calls.writes[0]).toMatchObject({ status: 'ready', lease_owner: '' })
      // Not claimable again for a while: the claim skips a lease in the future.
      expect(Date.parse(String(calls.writes[0].lease_expires_at)) - Date.parse(report.finishedAt)).toBe(2 * 60_000)
      expect(calls.writes[0].executor).toBeUndefined()
      expect(calls.released).toEqual([])
    })

    it('when the fill engine throws half way', async () => {
      const { deps, calls } = harness({
        openForm: async (doc) => {
          const driver = liveWidgets(domDriver(doc, MAVEN_URL))
          return { ...driver, readField: async () => Promise.reject(new Error('Execution context was destroyed')) }
        },
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(calls.closes).toBe(1)
      expect(report.outcome).toBe('retry')
    })

    it('when the run outlives its deadline', async () => {
      const { deps, calls } = harness({ leaseSeconds: 76, openForm: () => new Promise<never>(() => {}) })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(calls.closes).toBe(1)
      expect(report.outcome).toBe('retry')
      expect(report.error).toMatch(/longer than/)
    })

    it('when the gates stop the run', async () => {
      const { deps, calls } = harness({
        openForm: async (doc) => {
          doc.querySelector('form')!.insertAdjacentHTML('beforeend', '<input id="security-code" type="text">')
          return liveWidgets(domDriver(doc, MAVEN_URL))
        },
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(calls.closes).toBe(1)
      expect(report).toMatchObject({ outcome: 'blocked', status: 'blocked' })
      expect(calls.writes[0]).toMatchObject({ status: 'blocked', executor: 'assisted', blocked_reason: 'email-code' })
      expect(calls.writes[0].error).toMatch(/asked for a person/)
      expect(calls.released).toEqual(['attempt-1'])
    })

    it('when the result cannot be written', async () => {
      const { deps, calls } = harness({ write: { error: 'connection reset' } })
      await runClaimedAttempt(attempt(), deps)
      expect(calls.closes).toBe(1)
      // Not written means not settled: the lease runs out and recovery decides.
      expect(calls.released).toEqual([])
    })

    it('and opens none when the browser cannot be had', async () => {
      const { deps, calls } = harness({
        openSession: () => Promise.reject(new Error('browserbase create session -> 429: concurrency limit')),
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(calls.closes).toBe(0)
      expect(report).toMatchObject({ outcome: 'retry', status: 'ready', browserMs: 0 })
      expect(calls.writes[0].cost_usd).toBe(0.01)
    })
  })

  it('gives the attempt to the user after its last run fails', async () => {
    const { deps, calls } = harness({
      openForm: () => {
        throw new Error('page crashed')
      },
    })
    const report = await runClaimedAttempt(attempt({ attempts: 3 }), deps)
    expect(report).toMatchObject({ outcome: 'retry', status: 'blocked' })
    expect(calls.writes[0]).toMatchObject({ status: 'blocked', executor: 'assisted', blocked_reason: 'executor_failed' })
    expect(calls.writes[0].error).toMatch(/Finish it yourself/)
    expect(calls.released).toEqual(['attempt-1'])
  })

  it('leaves a lost lease to its new holder', async () => {
    const { deps, calls } = harness({ write: 'lease_lost' })
    await runClaimedAttempt(attempt(), deps)
    expect(calls.closes).toBe(1)
    expect(calls.released).toEqual([])
  })

  it('opens no browser for an account that is not on the allowlist', async () => {
    const { deps, calls } = harness({ allowed: false })
    const report = await runClaimedAttempt(attempt(), deps)
    expect(calls.sessions).toBe(0)
    expect(report).toMatchObject({ outcome: 'not_allowed', status: 'blocked' })
    expect(calls.writes[0]).toMatchObject({ executor: 'assisted', blocked_reason: 'not_allowed', cost_usd: 0.01 })
    expect(calls.released).toEqual(['attempt-1'])
  })

  it('opens no browser for a posting the fill engine does not cover', async () => {
    const { deps, calls } = harness({ prepare: { ok: false, kind: 'unsupported', reason: 'This posting is not on a form Autopilot can fill.' } })
    const report = await runClaimedAttempt(attempt(), deps)
    expect(calls.sessions).toBe(0)
    expect(report.outcome).toBe('unsupported')
    expect(calls.writes[0]).toMatchObject({ status: 'blocked', blocked_reason: 'unsupported' })
    expect(calls.writes[0].error).toMatch(/not on a form/)
  })

  it('asks the applicant for missing answers and keeps the attempt, and its credit, in Autopilot', async () => {
    const empty = { ...PROFILE, full_name: '', email: '', phone: '' }
    const { deps, calls } = harness({ prepare: prepared(empty) })
    const report = await runClaimedAttempt(attempt({ payload: { questions: [{ id: 'cover_letter', label: 'Cover letter', type: 'textarea', required: false }] } }), deps)
    expect(report).toMatchObject({ outcome: 'needs_input', status: 'needs_input' })
    const [patch] = calls.writes
    expect(patch.executor).toBeUndefined()
    expect(patch.pending_questions.length).toBeGreaterThan(0)
    for (const question of patch.pending_questions) expect(question).toMatchObject({ required: true, answer: null })
    // The questions already on the attempt are kept.
    expect(patch.payload.questions[0]).toMatchObject({ id: 'cover_letter' })
    expect(calls.released).toEqual([])
  })

  it('answers "how did you hear" on the page with the board the posting was found on, and asks when nobody said', async () => {
    const options = ["I'm a user", 'News article', 'Job board', 'Social media (LinkedIn, Instagram, X etc)', 'Referral', 'Other (please specify)']
    const openForm = async (doc: Document) => {
      doc.querySelector('form')!.insertAdjacentHTML(
        'beforeend',
        `<label for="hear">How did you hear about Maven Clinic?</label>
         <select id="hear" name="hear" required><option value="">Select...</option>${options.map((option) => `<option>${option}</option>`).join('')}</select>`,
      )
      return liveWidgets(domDriver(doc, MAVEN_URL))
    }
    const onBoard = prepared()
    if (onBoard.ok) onBoard.run.ctx.job.found_on = 'Remotive'
    const report = await runClaimedAttempt(attempt(), harness({ openForm, prepare: onBoard }).deps)
    expect(report.left.find((field) => field.key === 'hear')).toBeUndefined()
    expect(report.filled.find((field) => field.key === 'hear')).toMatchObject({ ok: true, observed: 'Job board' })

    const unknown = await runClaimedAttempt(attempt(), harness({ openForm }).deps)
    expect(unknown.left.find((field) => field.key === 'hear')).toMatchObject({ reason: 'no_answer', required: true })
  })

  it('never touches credits for an attempt the user started', async () => {
    const { deps, calls } = harness()
    await runClaimedAttempt(attempt({ origin: 'user' }), deps)
    expect(calls.released).toEqual([])
  })

  it('keeps the last five reports', async () => {
    const old = Array.from({ length: 5 }, (_, index) => ({ run: index }))
    const { deps, calls } = harness()
    await runClaimedAttempt(attempt({ payload: { questions: [], executorRuns: old } }), deps)
    const runs = calls.writes[0].payload.executorRuns
    expect(runs).toHaveLength(5)
    expect(runs[0]).toEqual({ run: 1 })
    expect((runs.at(-1) as ExecutionReport).outcome).toBe('passed')
  })

  it('tells the browser to stop before the lease runs out', async () => {
    const { deps } = harness()
    const openSession = vi.spyOn(deps, 'openSession')
    await runClaimedAttempt(attempt(), deps)
    expect(openSession).toHaveBeenCalledWith({ timeoutSeconds: 240, record: false })
  })

  describe('Browser Use', () => {
    it('records what the provider billed, not our estimate', async () => {
      const { deps, calls } = harness({ provider: 'browseruse', reportedUsd: 0.000334, browseMs: 150_000 })
      const report = await runClaimedAttempt(attempt({ cost_usd: 0.01 }), deps)
      expect(report.cost).toMatchObject({ browserUsd: 0.000334, totalUsd: 0.000334, source: 'provider' })
      expect(calls.writes[0].cost_usd).toBeCloseTo(0.010334, 9)
    })

    it('estimates at its list price when the stop did not report a cost', async () => {
      const { deps, calls } = harness({ provider: 'browseruse', reportedUsd: null, browseMs: 20_000 })
      const report = await runClaimedAttempt(attempt({ cost_usd: 0 }), deps)
      expect(report.cost).toMatchObject({ browserMinutes: 1, source: 'estimate' })
      // $0.02 a browser hour, one minute, to the millionth of a dollar.
      expect(calls.writes[0].cost_usd).toBe(0.000333)
    })

    it('waits for the solver and records a challenge it cleared', async () => {
      let shown = true
      const { deps, calls } = harness({
        provider: 'browseruse',
        solvesCaptchas: true,
        openForm: async (doc) => {
          doc.head.insertAdjacentHTML('beforeend', '<script src="https://www.google.com/recaptcha/api.js"></script>')
          doc.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha" data-sitekey="KEY"></div>')
          const driver = liveWidgets(domDriver(doc, MAVEN_URL))
          // The solver clears the box while the run leaves the page alone.
          return { ...driver, settle: async () => { if (shown) { doc.querySelector('.g-recaptcha')!.remove(); shown = false } } }
        },
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report.outcome).toBe('passed')
      expect(report.challenge).toMatchObject({ seen: true, solved: true, kinds: ['recaptcha-v2'], waits: 1 })
      expect(calls.writes[0].gate_results).toMatchObject({ executor: { challenge: { seen: true, solved: true } } })
    })

    it('hands the application over when the challenge is still there after waiting', async () => {
      const { deps, calls } = harness({
        provider: 'browseruse',
        solvesCaptchas: true,
        openForm: async (doc) => {
          // A reCAPTCHA checkbox the solver never clears.
          doc.head.insertAdjacentHTML('beforeend', '<script src="https://www.google.com/recaptcha/api.js"></script>')
          doc.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha" data-sitekey="KEY"></div>')
          return liveWidgets(domDriver(doc, MAVEN_URL))
        },
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report).toMatchObject({ outcome: 'blocked', status: 'blocked' })
      expect(report.challenge).toMatchObject({ seen: true, solved: false, waits: 2 })
      expect(report.counts.filled).toBe(0)
      expect(calls.writes[0]).toMatchObject({ blocked_reason: 'recaptcha-v2', executor: 'assisted' })
      expect(calls.writes[0].error).toMatch(/did not clear after waiting/)
      expect(calls.closes).toBe(1)
    })
  })

  describe('the agent route', () => {
    const agentPrepared = (): PrepareResult => {
      const ready = prepared()
      if (!ready.ok) throw new Error('fixture')
      return { ok: true, run: { ...ready.run, ref: null, agent: { startUrl: 'https://careers.example.com/jobs/42' } } }
    }

    it('hands back an account wall without touching the form, and gives the credit back', async () => {
      const { deps, calls } = harness({
        prepare: agentPrepared(),
        navigate: {
          kind: 'wall',
          wall: { code: 'account_required', by: 'workday', evidence: '2 password field(s)' },
          url: 'https://acme.wd1.myworkdayjobs.com/en-US/Acme/job/X/apply/applyManually',
          hops: [{ url: 'https://acme.wd1.myworkdayjobs.com/en-US/Acme/job/X/apply/applyManually', action: 'stop: account_required', inputs: 2, passwords: 2 }],
        },
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report).toMatchObject({ outcome: 'hand_back', status: 'blocked' })
      expect(report.navigation).toMatchObject({ outcome: 'wall', hops: [{ passwords: 2 }] })
      expect(calls.forms).toBe(0)
      expect(calls.writes[0]).toMatchObject({ status: 'blocked', executor: 'assisted', blocked_reason: 'account_required' })
      expect(calls.writes[0].error).toMatch(/create an account/)
      expect(calls.released).toEqual(['attempt-1'])
      expect(calls.closes).toBe(1)
    })

    it('carries a trail that ends on a fill-engine form as a normal run', async () => {
      const { deps, calls } = harness({
        prepare: agentPrepared(),
        navigate: { kind: 'ref', ref: { ats: 'greenhouse', board: 'mavenclinic', jobId: '88643130' }, hops: [] },
      })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report).toMatchObject({ outcome: 'passed', status: 'awaiting_approval', formUrl: MAVEN_URL })
      expect(calls.forms).toBe(1)
      expect(report.gates!.on_form_host.ok).toBe(true)
    })

    it('fills an employer-hosted form with the same engine and gates, pinned to its host', async () => {
      const { deps, calls } = harness({ prepare: agentPrepared(), navigate: { kind: 'form', url: 'https://careers.example.com/jobs/42/apply' } })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report).toMatchObject({ outcome: 'passed', status: 'awaiting_approval', mode: 'dry_run' })
      expect(report.counts.filled).toBeGreaterThan(5)
      expect(report.gates!.on_form_host).toMatchObject({ ok: true, detail: 'careers.example.com' })
      expect(calls.forms).toBe(0)
      expect(calls.navigations).toBe(1)
    })

    it('hands back a form that wanders off the host navigation found it on', async () => {
      const { deps } = harness({
        prepare: agentPrepared(),
        navigate: { kind: 'form', url: 'https://careers.example.com/jobs/42/apply' },
        openForm: undefined,
      })
      const real = deps.navigate
      deps.navigate = async (session, start) => {
        const nav = await real(session, start)
        return nav.kind === 'form' ? { ...nav, driver: { ...nav.driver, url: () => 'https://elsewhere.example.net/apply' } } : nav
      }
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report).toMatchObject({ outcome: 'hand_back', status: 'blocked' })
      expect(report.gates!.on_form_host.ok).toBe(false)
    })

    it('hands back a multi-page form before typing or asking anything', async () => {
      const { deps, calls } = harness({ prepare: agentPrepared(), navigate: { kind: 'form', url: 'https://careers.mastercard.com/us/en/apply?jobSeqNo=X', multiStep: true } })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report.status).toBe('blocked')
      expect(report.counts.filled).toBe(0)
      expect(calls.writes[0]).toMatchObject({ blocked_reason: 'multi_step' })
      expect(calls.writes[0]).not.toHaveProperty('pending_questions')
      expect(calls.released).toEqual(['attempt-1'])
    })

    it('hands back with nothing to find, as not_a_form', async () => {
      const { deps, calls } = harness({ prepare: agentPrepared(), navigate: { kind: 'lost', detail: 'no apply control on example.com', url: 'https://example.com', hops: [] } })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report.status).toBe('blocked')
      expect(calls.writes[0]).toMatchObject({ blocked_reason: 'not_a_form' })
      expect(calls.released).toEqual(['attempt-1'])
    })

    it('hands back a walled link before opening any browser', async () => {
      const { deps, calls } = harness({ prepare: { ok: false, kind: 'walled', reason: 'needs you signed in', code: 'login_required' } })
      const report = await runClaimedAttempt(attempt(), deps)
      expect(report.status).toBe('blocked')
      expect(calls.sessions).toBe(0)
      expect(calls.writes[0]).toMatchObject({ blocked_reason: 'login_required', executor: 'assisted' })
      expect(calls.released).toEqual(['attempt-1'])
    })
  })
})

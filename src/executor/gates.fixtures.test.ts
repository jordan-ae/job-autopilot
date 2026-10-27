// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true,"navigation":{"disableChildFrameNavigation":true,"disableChildPageNavigation":true}}}
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { FillResult } from 'ats-form-fill'
import type { FormAts } from 'ats-form-fill'
import type { ApplicationProfile, ApplyQuestion } from '../types.js'
import { domDriver, type FormDriver } from './driver.js'
import { askQuestions, decideGates, type GateDecision } from './gates.js'
import { runPage, type PageRun, type PageRunInput } from './pageRun.js'

/**
 * The executor's gates, run against the 25 application forms captured from
 * live Greenhouse, Ashby and Lever boards (test/fixtures/forms).
 *
 * Text boxes, native selects, radios, checkboxes and file inputs are filled
 * and read by the real fill engine in happy-dom. Two kinds of widget only work
 * with the page's own JavaScript running, which a saved snapshot does not
 * have: typeaheads (react-select, place lookups) and Ashby's Yes/No buttons.
 * `liveWidgets` stands in for those — it accepts a value the way the live
 * widget does and reads it back — so the gates see a form whose every control
 * behaves, and what they decide comes down to the questions themselves.
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

function input(fixture: Fixture, questions: ApplyQuestion[] = [], profile = PROFILE): PageRunInput {
  return {
    ats: fixture.ats,
    questions,
    profile,
    company: fixture.company,
    coverLetterText: 'Dear hiring team,\n\nI would like to apply.',
    documents: { resume: { fileName: 'ada-lovelace.pdf', ...PDF }, coverLetter: { fileName: 'ada-cover-letter.pdf', ...PDF } },
  }
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** Every submit the page saw: a form submitted, or a submit button pressed. */
function watchSubmits(doc: Document): { count: number } {
  const seen = { count: 0 }
  doc.addEventListener('submit', () => seen.count++, true)
  doc.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null
      const button = target?.closest?.('button, input[type="submit"]') as HTMLButtonElement | HTMLInputElement | null
      if (button && (button.type === 'submit' || /submit|apply/i.test(button.textContent ?? ''))) seen.count++
    },
    true,
  )
  return seen
}

/** The live behaviour of the widgets a snapshot cannot run. See the file comment. */
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
    async readField(field) {
      return chosen.get(field.key) ?? driver.readField(field)
    },
    settle: async () => {},
  }
}

async function run(
  fixture: Fixture,
  options: {
    questions?: ApplyQuestion[]
    profile?: ApplicationProfile
    wrap?: (driver: FormDriver, doc: Document) => FormDriver
    edit?: (doc: Document) => void
    challengeWait?: PageRunInput['challengeWait']
  } = {},
) {
  const doc = parse(fixture.html)
  options.edit?.(doc)
  const submits = watchSubmits(doc)
  const base = liveWidgets(domDriver(doc, fixture.url))
  const driver = options.wrap ? options.wrap(base, doc) : base
  const pageRun = await runPage(driver, { ...input(fixture, options.questions, options.profile), challengeWait: options.challengeWait })
  return { doc, submits, pageRun, decision: decideGates(pageRun) }
}

/** A plausible answer for each question the executor asked. */
function answer(question: ApplyQuestion): ApplyQuestion['answer'] {
  // A required tick box (a consent, a demographic-data agreement) is only
  // satisfied by ticking it.
  if (question.kind && question.type === 'boolean') return true
  switch (question.type) {
    case 'select':
      return question.declineOption ?? question.options?.[question.options.length - 1] ?? 'Prefer not to say'
    case 'multiselect':
      return question.options?.length ? [question.options[question.options.length - 1]] : ['Other']
    case 'boolean':
      return false
    case 'date':
      return '2026-11-15'
    default:
      return 'A considered answer.'
  }
}

const fixtures = loadFixtures()

function requiredEmpty(pageRun: PageRun): string[] {
  return pageRun.readBack.filter((field) => field.required && field.observed.trim() === '').map((field) => field.key)
}

describe('executor gates on the captured forms', () => {
  it('covers all 25 forms', () => {
    expect(fixtures).toHaveLength(25)
  })

  describe.each(fixtures.map((fixture) => [`${fixture.ats}/${fixture.slug}`, fixture] as const))('%s', (_name, fixture) => {
    let result: Awaited<ReturnType<typeof run>>
    const outcome = async () => (result ??= await run(fixture))

    it('fills the form, never submits it, and decides from what the page shows', async () => {
      const { submits, pageRun, decision } = await outcome()
      expect(submits.count).toBe(0)
      expect(pageRun.before.state).toBe('form')
      expect(pageRun.filled.length).toBeGreaterThan(0)
      // These boards all load a scoring bot check; none of them is on screen.
      expect(decision.gates.no_challenge.ok).toBe(true)
      expect(decision.gates.on_form_host.ok).toBe(true)
      expect(decision.gates.page_open.ok).toBe(true)

      // The required gate lists exactly the required fields still empty.
      const missing = (decision.gates.required_filled.items ?? []).map((item) => item.key)
      expect(missing.sort()).toEqual(requiredEmpty(pageRun).sort())

      // Passing means nothing required is empty and nothing failed to stick.
      expect(decision.outcome === 'passed').toBe(missing.length === 0 && decision.gates.readback.ok)
      if (decision.outcome === 'needs_input') expect(decision.ask.map((field) => field.key).sort()).toEqual(missing.sort())
      // Every hand-off names why, for the drawer's "Finish this one yourself".
      expect(decision.blockedReason !== '').toBe(decision.outcome === 'hand_back' || decision.outcome === 'blocked')
    })

    it('never ticks a consent or answers an equal-opportunity question from the profile', async () => {
      const { pageRun } = await outcome()
      const byKey = new Map(pageRun.fields.map((field) => [field.key, field]))
      for (const step of pageRun.filled) {
        const field = byKey.get(step.key)!
        expect(field.kind, `${step.key} (${step.label})`).not.toBe('checkbox')
      }
      for (const left of pageRun.left.filter((field) => field.reason === 'eeo' || field.reason === 'consent' || field.reason === 'trap')) {
        const readBack = pageRun.readBack.find((field) => field.key === left.key)!
        expect(readBack.observed, `${left.key} (${left.label})`).toBe('')
      }
    })

    it('asks for what is missing, and the answers land in the right fields next run', async () => {
      const first = await outcome()
      if (first.decision.outcome !== 'needs_input') return
      const asked = askQuestions(first.decision.ask, first.pageRun.fields, [])
      expect(asked.map((question) => question.id).sort()).toEqual(first.decision.ask.map((field) => field.key).sort())
      for (const question of asked) expect(question).toMatchObject({ required: true, answer: null })

      const answered = asked.map((question) => ({ ...question, answer: answer(question) }))
      const second = await run(fixture, { questions: answered })
      const stillMissing = (second.decision.gates.required_filled.items ?? []).map((item) => item.key)
      expect(stillMissing.filter((key) => asked.some((question) => question.id === key))).toEqual([])
      expect(second.submits.count).toBe(0)
    })

    it('stops at a bot check on screen before typing anything', async () => {
      const { pageRun, decision } = await run(fixture, {
        edit: (doc) => {
          // Parsed in, not appended, so happy-dom does not try to fetch it.
          doc.head.insertAdjacentHTML('beforeend', '<script src="https://www.google.com/recaptcha/api.js"></script>')
          doc.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha" data-sitekey="KEY"></div>')
        },
      })
      expect(pageRun.filled).toEqual([])
      expect(decision).toMatchObject({ outcome: 'blocked', blockedReason: 'recaptcha-v2' })
    })
  })
})

describe('executor gates on a page that misbehaves', () => {
  const mavenclinic = fixtures.find((fixture) => fixture.slug.startsWith('mavenclinic'))!
  const roboflow = fixtures.find((fixture) => fixture.slug.startsWith('roboflow'))!
  const blissway = fixtures.find((fixture) => fixture.slug.startsWith('blissway'))!

  it('passes a form whose every required question is answered', async () => {
    for (const fixture of [mavenclinic, roboflow]) {
      const { decision, submits } = await run(fixture)
      expect(decision.outcome, fixture.slug).toBe('passed')
      expect(Object.values(decision.gates).every((gate) => gate.ok && gate.ran)).toBe(true)
      expect(submits.count).toBe(0)
    }
  })

  it('hands back when a typeahead will not take the answer', async () => {
    const lever = fixtures.find((fixture) => fixture.slug.startsWith('captivateiq'))!
    const { decision } = await run(lever, {
      wrap: (driver) => ({
        ...driver,
        fillField: async (field, value, options) =>
          field.kind === 'combobox' ? { key: field.key, ok: false, observed: '', reason: `no suggestions for "${String(value)}"` } : driver.fillField(field, value, options),
      }),
    })
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'readback' })
    expect(decision.gates.readback.items).toEqual([expect.objectContaining({ key: 'location', why: 'no suggestions for "Berlin, Germany"' })])
  })

  it('hands back when the page resets an answer after it took', async () => {
    const { decision } = await run(mavenclinic, {
      wrap: (driver, doc) => ({
        ...driver,
        settle: async () => {
          // A controlled input snapping back to empty once focus moves on.
          const email = doc.querySelector<HTMLInputElement>('#email')!
          email.value = ''
        },
      }),
    })
    expect(decision.outcome).toBe('hand_back')
    expect(decision.gates.readback.items).toEqual([expect.objectContaining({ key: 'email', why: 'changed after filling' })])
  })

  it('hands back when the form flags an answer as invalid', async () => {
    const { decision } = await run(roboflow, {
      wrap: (driver, doc) => ({
        ...driver,
        settle: async () => {
          doc.querySelector('input[type="email"]')!.setAttribute('aria-invalid', 'true')
        },
      }),
    })
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'validation' })
    expect(decision.gates.no_validation_error).toMatchObject({ ok: false, detail: expect.stringContaining('invalid') })
  })

  it('hands back a posting the employer has closed, without filling anything', async () => {
    const { pageRun, decision } = await run(mavenclinic, {
      edit: (doc) => {
        doc.body.innerHTML = '<main><h1>Sorry, this job is no longer accepting applications.</h1></main>'
      },
    })
    expect(pageRun.filled).toEqual([])
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'closed' })
    expect(decision.gates.page_open).toMatchObject({ ok: false, detail: expect.stringMatching(/^closed/) })
    expect(decision.reason).toMatch(/closed/)
  })

  it('does not wait on a check no solver clears, even with a solver', async () => {
    let waits = 0
    const { decision } = await run(mavenclinic, {
      challengeWait: { waits: 2, ms: 10_000 },
      edit: (doc) => doc.querySelector('form')!.insertAdjacentHTML('beforeend', '<input id="security-code" type="text">'),
      wrap: (driver) => ({ ...driver, settle: async () => void waits++ }),
    })
    expect(waits).toBe(0)
    expect(decision).toMatchObject({ outcome: 'blocked', blockedReason: 'email-code', challenge: { seen: true, solved: false, waits: 0 } })
  })

  it('hands over a CAPTCHA at once when the browser has no solver', async () => {
    const { decision } = await run(mavenclinic, {
      challengeWait: { waits: 0, ms: 0 },
      edit: (doc) => doc.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha" data-sitekey="KEY"></div><script src="https://www.google.com/recaptcha/api.js"></script>'),
    })
    expect(decision).toMatchObject({ outcome: 'blocked', blockedReason: 'recaptcha-v2', challenge: { seen: true, solved: false, waits: 0 } })
  })

  it('stops when the form asks for an emailed code or a password', async () => {
    for (const markup of ['<input id="security-code" type="text">', '<input type="password" name="password">']) {
      const { decision } = await run(mavenclinic, { edit: (doc) => doc.querySelector('form')!.insertAdjacentHTML('beforeend', markup) })
      expect(decision.outcome).toBe('blocked')
    }
  })

  it('hands back when the form is on a host Autopilot does not fill', async () => {
    const elsewhere = { ...mavenclinic, url: 'https://careers.example.com/apply' }
    const { decision } = await run(elsewhere)
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'off_host' })
    expect(decision.gates.on_form_host).toMatchObject({ ok: false, detail: 'careers.example.com' })
  })

  it('leaves Blissway’s bot-trap box exactly as the page rendered it', async () => {
    const { pageRun } = await run(blissway)
    const trap = pageRun.left.find((field) => field.reason === 'trap')
    expect(trap).toBeDefined()
    expect(pageRun.readBack.find((field) => field.key === trap!.key)!.observed).toBe('')
  })

  it('asks rather than guesses when the profile is empty', async () => {
    const empty: ApplicationProfile = { ...PROFILE, full_name: '', email: '', phone: '', location: '', linkedin_url: '', portfolio_url: '', github_url: '' }
    const { decision } = await run(roboflow, { profile: empty })
    expect(decision.outcome).toBe('needs_input')
    expect(decision.ask.length).toBeGreaterThan(0)
    expect(decision.ask.every((field) => field.reason === 'no_answer')).toBe(true)
  })
})

/** Not a test of the gates themselves, but of decideGates' contract with the runner. */
describe('decideGates', () => {
  const page = (state: PageRun['before']['state']) => ({ state, evidence: state, challenges: [] })
  const empty = (overrides: Partial<PageRun>): PageRun => ({
    before: page('form'),
    fields: [],
    filled: [],
    left: [],
    readBack: [],
    after: page('form'),
    finalUrl: 'https://jobs.ashbyhq.com/acme/1/application',
    fillMs: 0,
    challenge: { seen: false, solved: false, kinds: [], waits: 0, waitedMs: 0 },
    ...overrides,
  })

  it('marks the gates it never reached', () => {
    const decision: GateDecision = decideGates(empty({ before: page('unknown'), after: page('unknown') }))
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'not_a_form' })
    expect(decision.gates.required_filled.ran).toBe(false)
    expect(decision.gates.readback.ran).toBe(false)
  })

  it('does not ask about a required field the page refused', () => {
    const decision = decideGates(
      empty({
        filled: [{ key: 'q', label: 'Q', kind: 'select', required: true, source: 'answer', ok: false, observed: '', reason: 'no option "x"', planned: 'x' }],
        readBack: [{ key: 'q', label: 'Q', kind: 'select', required: true, observed: '' }],
      }),
    )
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'readback' })
    expect(decision.gates.required_filled.items).toEqual([expect.objectContaining({ key: 'q', reason: 'did_not_take' })])
  })
})

// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { FormDriver } from '../executor/driver.js'
import { controlScore, looksLikeApplication, navigateToForm, type NavPage } from './navigate.js'
import { detectWall, PAGE_SNAPSHOT_JS, type PageSnapshot, type SnapshotControl } from './walls.js'

const control = (over: Partial<SnapshotControl>): SnapshotControl => ({ index: 0, tag: 'a', text: '', href: '', automationId: '', submits: false, ...over })
const page = (over: Partial<PageSnapshot>): PageSnapshot => ({ url: 'https://careers.example.com/job/1', title: '', text: '', passwords: 0, inputs: [], controls: [], ...over })

/** The pages of the 2026-10-21 dry run, as the snapshot saw them. */
const MARRIOTT = page({
  url: 'https://careers.marriott.com/flex-senior-full-stack-software-engineer/job/P1-6577711-0',
  controls: [
    control({ index: 0, text: 'Apply Now', href: 'https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/MI_CS_1/job/2610667' }),
    control({ index: 1, text: 'Save job', tag: 'button' }),
  ],
})
const ORACLE_JOB = page({
  url: 'https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/26106676',
  controls: [control({ index: 0, tag: 'button', text: 'Apply' })],
})
const ORACLE_EMAIL = page({
  url: 'https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/26106676/apply/email?posting_type=1',
  inputs: [{ type: 'text', label: 'Email Address', required: true }, { type: 'checkbox', label: 'I agree with my personal data being processed', required: true }],
  controls: [control({ index: 0, tag: 'button', text: 'Next' })],
})
const WORKDAY_JOB = page({
  url: 'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Full-stack-Engineer-4_R1001687-1',
  controls: [
    control({ index: 0, tag: 'button', text: 'Sign In', automationId: 'utilityButtonSignIn' }),
    control({ index: 1, text: 'Apply', automationId: 'adventureButton', href: 'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Full-stack-Engineer-4_R1001687-1/apply' }),
  ],
})
const WORKDAY_CHOICE = page({
  url: 'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Full-stack-Engineer-4_R1001687-1/apply',
  controls: [
    control({ index: 0, text: 'Autofill with Resume', automationId: 'autofillWithResume', href: 'https://capitalone.wd12.myworkdayjobs.com/x/apply/autofillWithResume' }),
    control({ index: 1, text: 'Apply Manually', automationId: 'applyManually', href: 'https://capitalone.wd12.myworkdayjobs.com/x/apply/applyManually' }),
  ],
})
const WORKDAY_ACCOUNT = page({
  url: 'https://capitalone.wd12.myworkdayjobs.com/x/apply/applyManually',
  title: 'Create Account',
  passwords: 2,
  inputs: [{ type: 'text', label: 'Email Address', required: true }, { type: 'text', label: 'Enter website. This input is for robots only, do not enter if you\'re human.', required: false }],
  controls: [control({ index: 0, tag: 'button', text: 'Create Account', automationId: 'createAccountSubmitButton', submits: true })],
})
const ZIP = page({
  url: 'https://www.ziprecruiter.com/c/capital-one/Job/Full-stack-Engineer-4/-in-Mclean,VA?jid=b33',
  text: 'Sign up or log in, and then apply on external site* Continue with Google Email Continue',
  inputs: [{ type: 'email', label: 'Email', required: false }],
  controls: [control({ index: 0, text: 'Apply', href: 'https://www.ziprecruiter.com/job-redirect?match_token=x' })],
})
const EMPLOYER_FORM = page({
  url: 'https://careers.example.com/job/1/apply',
  inputs: [
    { type: 'text', label: 'First name', required: true },
    { type: 'text', label: 'Last name', required: true },
    { type: 'email', label: 'Email', required: true },
    { type: 'file', label: 'Resume', required: true },
  ],
  controls: [control({ index: 0, tag: 'button', text: 'Submit application', submits: true })],
})

/** A browser that serves snapshots by address and follows presses by a map. */
function fakePage(pages: PageSnapshot[], presses: Record<string, string> = {}): NavPage & { visited: string[]; pressed: string[] } {
  const byUrl = new Map(pages.map((snap) => [snap.url, snap]))
  let current: PageSnapshot = page({ url: 'about:blank' })
  const visited: string[] = []
  const pressed: string[] = []
  return {
    visited,
    pressed,
    goto: async (url) => {
      visited.push(url)
      current = byUrl.get(url) ?? page({ url })
    },
    snapshot: async () => current,
    press: async (index) => {
      const chosen = current.controls[index]
      pressed.push(chosen.text)
      const next = presses[`${current.url}|${chosen.text}`]
      if (next) current = byUrl.get(next) ?? page({ url: next })
    },
    driver: async () => ({ url: () => current.url }) as unknown as FormDriver,
  }
}

describe('navigateToForm', () => {
  it('Marriott: Phenom → Oracle job → the email step, an account wall', async () => {
    // The Phenom link goes to the MI_CS_1 site, which redirects to CX/job/26106676.
    const browser = fakeWithRedirect([MARRIOTT, ORACLE_JOB, ORACLE_EMAIL], { [MARRIOTT.controls[0].href]: ORACLE_JOB.url }, { [`${ORACLE_JOB.url}|Apply`]: ORACLE_EMAIL.url })
    const result = await navigateToForm(browser, MARRIOTT.url)
    expect(result.kind).toBe('wall')
    expect(result.kind === 'wall' && result.wall).toMatchObject({ code: 'account_required', by: 'oracle' })
    expect(result.hops.map((hop) => hop.action)).toEqual([
      expect.stringMatching(/^goto https:\/\/ejwl/),
      'press "Apply"',
      expect.stringMatching(/^stop: account_required/),
    ])
  })

  it('Capital One on Workday: Apply → Apply Manually → Create Account, never Autofill or Sign In', async () => {
    const browser = fakeWithRedirect([WORKDAY_JOB, WORKDAY_CHOICE, WORKDAY_ACCOUNT], { [WORKDAY_CHOICE.controls[1].href]: WORKDAY_ACCOUNT.url }, {})
    const result = await navigateToForm(browser, WORKDAY_JOB.url)
    expect(result).toMatchObject({ kind: 'wall', wall: { code: 'account_required', by: 'workday' } })
    expect(browser.visited).toEqual([WORKDAY_JOB.url, WORKDAY_CHOICE.url, WORKDAY_ACCOUNT.url])
    expect(browser.pressed).toEqual([])
  })

  it('ZipRecruiter: its sign-up modal is a login wall', async () => {
    const result = await navigateToForm(fakePage([ZIP]), ZIP.url)
    expect(result).toMatchObject({ kind: 'wall', wall: { code: 'login_required', by: 'ziprecruiter' } })
  })

  it('stops on an application form and never presses its submit button', async () => {
    const listing = page({ url: 'https://remoteok.com/remote-jobs/1', controls: [control({ text: 'Apply', href: EMPLOYER_FORM.url })] })
    const browser = fakePage([listing, EMPLOYER_FORM])
    const result = await navigateToForm(browser, listing.url)
    expect(result).toMatchObject({ kind: 'form', host: 'careers.example.com', url: EMPLOYER_FORM.url })
    expect(browser.pressed).toEqual([])
  })

  it('hands a link to a fill-engine form to the normal run without opening it', async () => {
    const listing = page({ url: 'https://news.ycombinator.com/item?id=1', controls: [control({ text: 'Apply here', href: 'https://jobs.ashbyhq.com/acme/5db01aa4-92eb-4796-bd7e-446ea98402f2' })] })
    const browser = fakePage([listing])
    const result = await navigateToForm(browser, listing.url)
    expect(result).toMatchObject({ kind: 'ref', ref: { ats: 'ashby', board: 'acme' } })
  })

  it('gives up when nothing reads as Apply, or a press goes nowhere', async () => {
    expect(await navigateToForm(fakePage([page({ url: 'https://example.com/a' })]), 'https://example.com/a')).toMatchObject({ kind: 'lost' })
    const stuck = page({ url: 'https://example.com/b', controls: [control({ tag: 'button', text: 'Apply now' })] })
    const result = await navigateToForm(fakePage([stuck]), stuck.url)
    expect(result).toMatchObject({ kind: 'lost' })
    expect(result.hops.length).toBe(2)
  })
})

function fakeWithRedirect(pages: PageSnapshot[], redirects: Record<string, string>, presses: Record<string, string>) {
  const browser = fakePage(pages, presses)
  const original = browser.goto
  browser.goto = async (url) => original(redirects[url] ?? url)
  return browser
}

describe('controlScore', () => {
  it('leaves sign-in, save and submit controls alone', () => {
    expect(controlScore(control({ text: 'Sign In', tag: 'button' }), '')).toBe(0)
    expect(controlScore(control({ text: 'Save job', tag: 'button' }), '')).toBe(0)
    expect(controlScore(control({ text: 'Apply', tag: 'button', submits: true }), '')).toBe(0)
    expect(controlScore(control({ text: 'Apply with LinkedIn', href: 'https://www.linkedin.com/x' }), '')).toBe(0)
    expect(controlScore(control({ text: 'Autofill with Resume', automationId: 'autofillWithResume' }), '')).toBe(0)
  })
  it('prefers a direct form link, then Apply Manually, then Apply', () => {
    const form = controlScore(control({ text: 'Apply', href: 'https://job-boards.greenhouse.io/acme/jobs/1' }), '')
    const manual = controlScore(control({ text: 'Apply Manually', automationId: 'applyManually' }), '')
    const plain = controlScore(control({ text: 'Apply', tag: 'button' }), '')
    expect(form).toBeGreaterThan(manual)
    expect(manual).toBeGreaterThan(plain)
    expect(plain).toBeGreaterThan(0)
  })
})

describe('looksLikeApplication and detectWall', () => {
  it('a newsletter box is not an application; the employer form is', () => {
    expect(looksLikeApplication(page({ inputs: [{ type: 'email', label: 'Email', required: false }] }))).toBe(false)
    expect(looksLikeApplication(EMPLOYER_FORM)).toBe(true)
    expect(looksLikeApplication(WORKDAY_ACCOUNT)).toBe(false)
  })
  it('an ordinary employer form is no wall', () => {
    expect(detectWall(EMPLOYER_FORM)).toBeNull()
    expect(detectWall(MARRIOTT)).toBeNull()
  })
  it('a password box on any employer site is one', () => {
    expect(detectWall(page({ passwords: 1, text: 'Create your account to apply' }))).toMatchObject({ code: 'account_required' })
  })
})

describe('PAGE_SNAPSHOT_JS', () => {
  it('reads a page, skips cookie banners and hidden inputs, and marks the controls it reports', () => {
    document.body.innerHTML = `
      <div id="onetrust-consent-sdk"><input type="checkbox" id="c1"><label for="c1">Analytics Cookies</label><button>Accept and continue</button></div>
      <h1>Engineer</h1>
      <a href="/apply" id="go">Apply now</a>
      <input type="hidden" name="token">
      <label for="e">Email</label><input id="e" type="email" required>
      <input type="password">`
    const snap = new Function(`return ${PAGE_SNAPSHOT_JS}`)() as PageSnapshot
    // happy-dom lays nothing out, so every element is 0×0: nothing reads as visible.
    expect(snap).toMatchObject({ title: expect.any(String), passwords: 0 })
    expect(snap.inputs.every((input) => input.label !== 'Analytics Cookies')).toBe(true)
  })
})

describe('HN threads', () => {
  it("never follows YC's own accelerator application", () => {
    const here = 'https://news.ycombinator.com/item?id=1'
    expect(controlScore(control({ text: 'Apply to YC', href: 'https://www.ycombinator.com/apply/' }), here)).toBe(0)
    expect(controlScore(control({ text: 'apply', href: 'https://www.ycombinator.com/apply/' }), here)).toBe(0)
  })
})

describe('looksMultiStep', () => {
  it('Mastercard step 1 (Next, no submit) is one of several pages; a form ending in Submit is not', async () => {
    const { looksMultiStep } = await import('./navigate.js')
    const step1 = page({ controls: [control({ tag: 'button', text: 'Next', submits: true }), control({ tag: 'button', text: 'Review' })] })
    expect(looksMultiStep(step1)).toBe(true)
    expect(looksMultiStep(EMPLOYER_FORM)).toBe(false)
  })
})

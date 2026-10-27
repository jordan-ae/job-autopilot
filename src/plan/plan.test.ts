// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { corpusFromFixtures } from '../fields/corpusSource.js'
import { extractFormFields, detectAts } from 'ats-form-fill'
import { planFill } from './plan.js'
import type { ApplicationProfile, ResumeFacts } from '../types.js'

/**
 * The planner over all 25 captured forms, with a complete profile: what it
 * fills, and what it must never fill.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/forms')

const PROFILE: ApplicationProfile = {
  client_key: 'u',
  full_name: 'Budi Santoso',
  email: 'budi@example.com',
  phone: '+62 812 3456 7890',
  location: 'Jakarta, Indonesia',
  linkedin_url: 'https://linkedin.com/in/budi',
  portfolio_url: 'https://budi.dev',
  github_url: 'https://github.com/budi',
  work_authorization: '',
  requires_sponsorship: null,
  notice_period_days: 30,
  desired_salary: 60000,
  desired_salary_currency: 'USD',
  earliest_start_date: '2026-11-01',
  custom_answers: {},
  eeo: {},
  country: 'ID',
  citizenship: ['ID'],
  work_authorizations: [{ region: 'US', authorized: false, needs_sponsorship: true, open_to_contractor_eor: true }],
}

const RESUME: ResumeFacts = {
  summary: '',
  skills: 'Go',
  languages: [],
  experience: [{ company: 'Tokopedia', jobTitle: 'Backend Engineer', startDate: 'Jan 2019', endDate: 'Present' }],
  education: [{ school: 'Universitas Indonesia', degree: 'BSc Computer Science', year: '2018' }],
}

const CORPUS = corpusFromFixtures(FIXTURES)

const forms = [...new Set(CORPUS.map((question) => `${question.ats}/${question.form}`))].map((path) => {
  const doc = new DOMParser().parseFromString(readFileSync(join(FIXTURES, `${path}.html`), 'utf8'), 'text/html')
  const company = CORPUS.find((question) => `${question.ats}/${question.form}` === path)!.company
  return { path, company, ats: detectAts(doc), fields: extractFormFields(doc) }
})

function plan(form: (typeof forms)[number], profile: ApplicationProfile = PROFILE) {
  return planFill({
    ats: form.ats,
    fields: form.fields,
    questions: [],
    profile,
    company: form.company,
    hasCoverLetter: true,
    coverLetterText: 'Dear team',
    resume: RESUME,
    job: { id: 'job-1', location: 'San Francisco, CA, United States' },
  })
}

describe('planFill on the captured forms', () => {
  it('covers all 25 forms', () => {
    expect(forms).toHaveLength(25)
  })

  it('fills the identity fields on every form that has them, and attaches the CV', () => {
    let filled = 0
    let total = 0
    for (const form of forms) {
      const result = plan(form)
      filled += result.steps.length
      total += form.fields.length
      const byKey = new Map(result.steps.map((step) => [step.fieldKey, step]))
      if (form.fields.some((field) => /^(_systemfield_)?email$/.test(field.key))) expect(byKey.get('email')?.value, form.path).toBe('budi@example.com')
      if (form.fields.some((field) => field.kind === 'file' && /resume/i.test(field.key))) {
        expect(result.steps.some((step) => (step.value as { file?: string }).file === 'resume'), form.path).toBe(true)
      }
      // Every field is accounted for exactly once.
      expect(result.steps.length + result.left.length, form.path).toBe(form.fields.length)
    }
    console.log(`[field mapper] planFill over 25 forms: ${filled}/${total} fields filled with a complete profile`)
    expect(filled / total).toBeGreaterThan(0.45)
  })

  it('answers US work authorization from the US row', () => {
    const airbnb = forms.find((form) => form.path.includes('instacart'))!
    const step = plan(airbnb).steps.find((entry) => entry.label === 'Are you authorized to work in the United States?')
    // A combobox carries the answer as text, matched on the page.
    expect(step?.value).toBe('No')
    expect(step?.layer).toBe('identity')
  })

  it('never fills a consent, and leaves EEO alone until the user sets it up', () => {
    for (const form of forms) {
      const result = plan(form)
      for (const step of result.steps) {
        expect(/consent|privacy|agree|certify|attest/i.test(step.label) && step.kind === 'checkbox', `${form.path}: ${step.label}`).toBe(false)
        expect(['eeo_gender', 'eeo_race_ethnicity', 'eeo_veteran', 'eeo_disability'].includes(step.fieldKey ?? ''), `${form.path}: ${step.label}`).toBe(false)
      }
    }
  })

  it('declines EEO questions once the user has declined them', () => {
    const declined = { ...PROFILE, eeo_answers: { eeo_gender: 'decline', eeo_race_ethnicity: 'decline', eeo_veteran: 'decline', eeo_disability: 'decline' } }
    const lever = forms.find((form) => form.path === 'lever/coupa-f6008090')!
    const gender = plan(lever, declined).steps.find((step) => step.key === 'eeo[gender]')
    expect(gender?.value).toBe('Decline to self-identify')
  })
})

import { describe, expect, it } from 'vitest'
import { coerce, fillAnswers } from '../plan/answers.js'
import type { ApplicationProfile, ApplyQuestion, ResumeFacts } from '../types.js'
import { ageOn, currentJob, numericOption, parseCvDate, parsePhone, splitName, yearsOfExperience } from './computed.js'
import { countryOption, detectRegion, regionInText } from './countries.js'
import { CANONICAL_FIELDS, EEO_CATEGORIES, FIELD_TABS, effectiveMode, fieldByKey } from './registry.js'
import { resolveQuestion, type ResolveContext } from './resolver.js'
import { fieldFingerprint, findDeclineOption, jobFingerprint } from './text.js'

const TODAY = new Date('2026-10-20T00:00:00Z')

function profile(overrides: Partial<ApplicationProfile> = {}): ApplicationProfile {
  return {
    client_key: 'user-1',
    full_name: 'Budi Santoso Wijaya',
    email: 'budi@example.com',
    phone: '0812 3456 7890',
    location: 'Jakarta, Indonesia',
    linkedin_url: 'https://linkedin.com/in/budi',
    portfolio_url: '',
    github_url: 'https://github.com/budi',
    work_authorization: '',
    requires_sponsorship: null,
    notice_period_days: 30,
    desired_salary: 60_000,
    desired_salary_currency: 'USD',
    earliest_start_date: null,
    custom_answers: {},
    eeo: {},
    country: 'ID',
    citizenship: ['ID'],
    work_authorizations: [
      { region: 'US', authorized: false, needs_sponsorship: true, open_to_contractor_eor: true },
      { region: 'EU', authorized: false, needs_sponsorship: true, open_to_contractor_eor: true },
      { region: 'SG', authorized: true, needs_sponsorship: false, open_to_contractor_eor: null },
    ],
    ...overrides,
  }
}

const RESUME: ResumeFacts = {
  summary: 'Backend engineer.',
  skills: 'Go, PostgreSQL, Kubernetes',
  languages: ['Indonesian (Native)', 'English (Fluent)'],
  experience: [
    { company: 'Tokopedia', jobTitle: 'Senior Backend Engineer', startDate: 'Mar 2022', endDate: 'Present' },
    { company: 'Gojek', jobTitle: 'Backend Engineer', startDate: '2019-01', endDate: '2022-02' },
    // Overlaps the job above: counted once.
    { company: 'Freelance', jobTitle: 'Consultant', startDate: '2020', endDate: '2020' },
  ],
  education: [
    { school: 'SMA Negeri 8 Jakarta', degree: 'High school', year: '2014' },
    { school: 'Universitas Indonesia', degree: 'BSc Computer Science', year: '2014 – 2018' },
  ],
}

const ctx = (overrides: Partial<ResolveContext> = {}): ResolveContext => ({
  profile: profile(),
  company: 'Acme',
  resume: RESUME,
  today: TODAY,
  ...overrides,
})

const resolve = (label: string, extra: Partial<Parameters<typeof resolveQuestion>[0]> = {}, context: ResolveContext = ctx()) =>
  resolveQuestion({ label, ...extra }, context)

describe('the registry', () => {
  it('names 80–120 fields, each once, each on a tab', () => {
    const keys = CANONICAL_FIELDS.map((field) => field.key)
    expect(keys.length).toBeGreaterThanOrEqual(80)
    expect(keys.length).toBeLessThanOrEqual(120)
    expect(new Set(keys).size).toBe(keys.length)
    const tabs = new Set(FIELD_TABS.map((tab) => tab.id))
    for (const field of CANONICAL_FIELDS) expect(tabs.has(field.tab), field.key).toBe(true)
    for (const tab of tabs) expect(CANONICAL_FIELDS.some((field) => field.tab === tab), tab).toBe(true)
  })

  it('declines EEO by default and never lets a consent autofill', () => {
    for (const category of EEO_CATEGORIES) expect(fieldByKey(category)?.defaultMode, category).toBe('decline_or_blank')
    const consent = CANONICAL_FIELDS.find((field) => field.sensitivity === 'consent')!
    expect(effectiveMode(consent, { [consent.key]: 'autofill' })).toBe('ask')
  })
})

describe('computed fields', () => {
  it('splits a name into first, middle and last', () => {
    expect(splitName('Budi Santoso Wijaya')).toEqual({ first: 'Budi', middle: 'Santoso', last: 'Wijaya' })
    expect(splitName('Sukarno')).toEqual({ first: 'Sukarno', middle: '', last: '' })
    expect(resolve('First name').value).toBe('Budi')
    expect(resolve('Last name').value).toBe('Wijaya')
    // A column the user set beats the split.
    expect(resolve('Last name', {}, ctx({ profile: profile({ last_name: 'Santoso Wijaya' }) })).value).toBe('Santoso Wijaya')
  })

  it('reads a local phone number in the country the user lives in', () => {
    expect(parsePhone('0812 3456 7890', { homeCountry: 'ID' })).toMatchObject({ e164: '+6281234567890', countryCode: '+62', national: '81234567890' })
    expect(parsePhone('+44 20 7946 0958')).toMatchObject({ e164: '+442079460958', countryCode: '+44', national: '2079460958' })
    // No +code and no country to read it in: no guess.
    expect(parsePhone('0812 3456 7890')).toBeNull()
    expect(resolve('Country', { section: 'Phone', key: 'country', ats: 'greenhouse' }).value).toBe('Indonesia')
    expect(resolve('Phone country code').value).toBe('+62')
  })

  it('shares a preferred name and pronouns only when the user set them', () => {
    const label = 'At Acme, we encourage employees to bring their whole selves to work. Feel free to share your preferred name and pronouns.'
    expect(resolve(label).value).toBeNull()
    expect(resolve(label, {}, ctx({ profile: profile({ pronouns: 'he/him' }) })).value).toBe('Budi (he/him)')
  })

  it('answers age questions from the date of birth only', () => {
    expect(ageOn('2000-10-21', TODAY)).toBe(25)
    expect(ageOn('2000-10-20', TODAY)).toBe(26)
    const withDob = ctx({ profile: profile({ date_of_birth: '2000-10-21' }) })
    expect(resolve('Are you at least 18 years of age?', { kind: 'boolean' }, withDob).value).toBe(true)
    expect(resolve('Are you 18 or older?', {}, withDob).value).toBe(true)
    // No date of birth: asked, never assumed.
    expect(resolve('Are you at least 18 years of age?').value).toBeNull()
  })

  it('counts years of experience once across overlapping jobs', () => {
    // Jan 2019 – Feb 2022 (38 months) + Mar 2022 – Oct 2026 (56 months) = 94 months.
    expect(yearsOfExperience(RESUME.experience, TODAY)).toBe(7)
    expect(currentJob(RESUME.experience, TODAY)?.company).toBe('Tokopedia')
    expect(parseCvDate('Present')).toBe('present')
    expect(parseCvDate('01/2020')).toEqual({ year: 2020, month: 1 })
    const years = resolve('How many years of total work experience do you have?', { kind: 'radio', options: ['Less than 2 years', '2-5 years', '6-9 years', '10+ years'] })
    expect(years.value).toBe(7)
    expect(coerce(years.value!, { type: 'select', options: ['Less than 2 years', '2-5 years', '6-9 years', '10+ years'] })).toBe('6-9 years')
  })

  it('reads the current employer, title and latest school off the CV', () => {
    expect(resolve('Who is your most recent/current employer?').value).toBe('Tokopedia')
    expect(resolve('Current/Most Recent Job Title').value).toBe('Senior Backend Engineer')
    expect(resolve('School', { key: 'school--0', ats: 'greenhouse' }).value).toBe('Universitas Indonesia')
    expect(resolve('Discipline', { key: 'discipline--0', ats: 'greenhouse' }).value).toBe('Computer Science')
    expect(resolve('Graduation year').value).toBe('2018')
    expect(resolve('Do you have a High School Diploma or GED?', { kind: 'boolean' }).value).toBe(true)
    // Greenhouse's employment block, entry by entry, newest first.
    expect(resolve('Company name', { key: 'company-name-1', ats: 'greenhouse' }).value).toBe('Freelance')
    expect(resolve('Start date month', { key: 'start-date-month-0', ats: 'greenhouse' }).value).toBe('March')
    expect(resolve('Start date year', { key: 'start-date-year-0', ats: 'greenhouse' }).value).toBe('2022')
    expect(resolve('Current role', { key: 'current-role-0', ats: 'greenhouse' }).value).toBe(true)
  })

  it('says yes to "worked here before" only when the CV shows it', () => {
    expect(resolve('Have you previously worked at Gojek?', {}, ctx({ company: 'Gojek' })).value).toBe(true)
    // Not on the CV is not proof of never: the agent or the user answers.
    expect(resolve('Have you previously worked at Acme?').value).toBeNull()
  })

  it('snaps numbers onto range options', () => {
    expect(numericOption(['Under 30', '30-39', '40-49', '60 or older'], 26)).toBe('Under 30')
    expect(numericOption(['Under 30', '30-39', '40-49', '60 or older'], 61)).toBe('60 or older')
    expect(numericOption(['1', '2', '3+'], 5)).toBe('3+')
    expect(numericOption(['Junior', 'Senior'], 5)).toBeNull()
  })
})

describe('work authorization, per country', () => {
  it('finds the country in the question first, then in the job', () => {
    expect(detectRegion('Are you authorized to work in the United States?', 'Berlin, Germany')).toEqual({ region: 'US', via: 'question' })
    expect(detectRegion('Are you authorized to work in the country where the job is located?', 'Berlin, Germany')).toEqual({ region: 'DE', via: 'job' })
    expect(detectRegion('Are you authorized to work in the country where the job is located?', 'Remote')).toEqual({ region: null, via: null })
    expect(regionInText('Will you require sponsorship to work in the U.S.?')).toBe('US')
    expect(regionInText('Are you excited to work with us?')).toBeNull()
    expect(regionInText('Are you eligible to work in the EU?')).toBe('EU')
  })

  it('answers each country from its own row', () => {
    expect(resolve('Are you authorized to work in the United States?', { kind: 'boolean' }).value).toBe(false)
    expect(resolve('Will you now or in the future require visa sponsorship to work in the USA?', { kind: 'boolean' }).value).toBe(true)
    expect(resolve('Are you legally authorized to work in Singapore?').value).toBe(true)
    expect(resolve('Are you open to working as a contractor through an employer of record in the US?').value).toBe(true)
  })

  it('covers an EU member state with the EU row, and never derives a country from citizenship', () => {
    const inGermany = ctx({ job: { location: 'Berlin, Germany' } })
    expect(resolve('Are you legally authorized to work in the country where the job is located?', {}, inGermany).value).toBe(false)
    // Indonesian citizen, no Indonesia row: a legal answer is only ever the
    // one the user stored, so this is asked.
    expect(resolve('Are you authorized to work in Indonesia?').value).toBeNull()
    expect(resolve('Do you require sponsorship to work in Indonesia?').value).toBeNull()
  })

  it('asks when the country is unknown and the user’s answers differ by country', () => {
    const remote = ctx({ job: { location: 'Remote' } })
    const result = resolve('Are you legally authorized to work in the country where this position is located?', {}, remote)
    expect(result.value).toBeNull()
    expect(result.reason).toBe('no_data')
    // A country with no row and no citizenship is asked, not guessed.
    expect(resolve('Are you authorized to work in Canada?').value).toBeNull()
  })

  it('combines both rows for "without sponsorship"', () => {
    expect(resolve('Are you eligible to work in the US without sponsorship indefinitely?').value).toBe(false)
    expect(resolve('Are you eligible to work in Singapore without sponsorship?').value).toBe(true)
  })

  it('falls back to the single legacy answer only for a question naming no country', () => {
    const legacy = ctx({ profile: profile({ work_authorizations: [], requires_sponsorship: false }) })
    expect(resolve('Will you now or in the future require visa sponsorship?', {}, legacy).value).toBe(false)
    expect(resolve('Will you require sponsorship to work in the USA?', {}, legacy).value).toBeNull()
  })
})

describe('autofill modes', () => {
  it('asks when the user said ask, even with a value on file', () => {
    const asking = ctx({ profile: profile({ field_modes: { phone: 'ask' } }) })
    expect(resolve('Phone', {}, asking)).toMatchObject({ value: null, reason: 'mode_ask' })
  })

  it('leaves a decline-or-blank field empty', () => {
    const blank = ctx({ profile: profile({ field_modes: { linkedin_url: 'decline_or_blank' } }) })
    expect(resolve('LinkedIn Profile', {}, blank)).toMatchObject({ value: null, reason: 'mode_blank' })
  })
})

describe('EEO', () => {
  const gender = { label: 'Gender', kind: 'select', options: ['Male', 'Female', 'Decline To Self Identify'] }

  it('leaves an EEO question to the user until they have set it up', () => {
    expect(resolve(gender.label, gender)).toMatchObject({ value: null, reason: 'eeo_unset' })
  })

  it('picks the form’s decline option once the user has declined', () => {
    const declined = ctx({ profile: profile({ eeo_answers: { eeo_gender: 'decline' } }) })
    expect(resolve(gender.label, gender, declined)).toMatchObject({ value: 'Decline To Self Identify', decline: true })
    expect(findDeclineOption(['I am a veteran', 'I am not a veteran', 'Decline to self-identify'])).toBe('Decline to self-identify')
    expect(findDeclineOption(['Yes', 'No'])).toBeNull()
  })

  it('gives only what the user stated, and only in autofill mode', () => {
    const stated = ctx({ profile: profile({ eeo_answers: { eeo_gender: 'Male' }, field_modes: { eeo_gender: 'autofill' } }) })
    expect(resolve(gender.label, gender, stated).value).toBe('Male')
    // Stated, but the mode is still the decline default.
    const statedDefault = ctx({ profile: profile({ eeo_answers: { eeo_gender: 'Male' } }) })
    expect(resolve(gender.label, gender, statedDefault)).toMatchObject({ value: 'Decline To Self Identify', decline: true })
  })

  it('never fills a consent', () => {
    expect(resolve('I consent to the processing of my personal data', { kind: 'checkbox' })).toMatchObject({ value: null, reason: 'consent' })
  })
})

describe('the answer bank', () => {
  it('uses the user’s correction over the agent’s original', () => {
    const fp = 'how did you hear about this job'
    const corrected = ctx({
      profile: profile({
        custom_answers: { [fp]: 'Company careers page' },
        answer_meta: { [fp]: { source: 'user', fieldKey: 'referral_source', reviewState: 'corrected' } },
      }),
    })
    expect(resolve('How did you hear about this job?', {}, corrected)).toMatchObject({ value: 'Company careers page', layer: 'question' })
  })

  it('ranks an unreviewed agent answer below the profile', () => {
    const fp = 'phone'
    const agentSaid = ctx({
      profile: profile({
        phone: '+62 812 0000 0000',
        custom_answers: { [fp]: 'agent guess' },
        answer_meta: { [fp]: { source: 'agent', reviewState: 'pending' } },
      }),
    })
    expect(resolve('Phone', {}, agentSaid).value).toBe('+62 812 0000 0000')
  })

  it('serves one field-level answer to every wording of the field', () => {
    const bank = ctx({
      profile: profile({
        custom_answers: { [fieldFingerprint('referral_source')]: 'LinkedIn' },
        answer_meta: { [fieldFingerprint('referral_source')]: { source: 'user', fieldKey: 'referral_source' } },
      }),
    })
    expect(resolve('How did you hear about this opportunity?', {}, bank).value).toBe('LinkedIn')
    expect(resolve('Where have you learned about Acme? Select all that apply.', {}, bank).value).toBe('LinkedIn')
  })

  it('keeps a job-scoped answer to its job', () => {
    const fp = jobFingerprint('why are you interested in joining', 'job-1')
    const scoped = (jobId: string) =>
      ctx({
        job: { id: jobId },
        profile: profile({
          custom_answers: { [fp]: 'Your payments work.' },
          answer_meta: { [fp]: { source: 'agent', fieldKey: 'why_company', jobId: 'job-1', reviewState: 'pending' } },
        }),
      })
    expect(resolve('Why are you interested in joining Acme?', {}, scoped('job-1')).value).toBe('Your payments work.')
    expect(resolve('Why are you interested in joining Acme?', {}, scoped('job-2')).value).toBeNull()
  })

  it('fills a whole prepared form through the registry', () => {
    const questions: ApplyQuestion[] = [
      { id: 'first_name', label: 'First Name', type: 'text', required: true },
      { id: 'q1', label: 'Are you authorized to work in the United States?', type: 'boolean', required: true },
      { id: 'q2', label: 'Which country do you intend to work from?', type: 'select', required: true, options: ['Indonesia', 'Singapore'] },
      { id: 'q3', label: 'Describe a time you disagreed with your manager.', type: 'textarea', required: true },
    ]
    const filled = fillAnswers(questions, profile(), 'Acme', { resume: RESUME, today: TODAY })
    expect(filled.map((question) => question.answer)).toEqual(['Budi', false, 'Indonesia', null])
  })
})

describe('country options', () => {
  it('matches a country by name, alias or code-suffixed label', () => {
    expect(countryOption(['United States of America', 'Indonesia'], 'US')).toBe('United States of America')
    expect(countryOption(['Indonesia (+62)', 'India (+91)'], 'ID')).toBe('Indonesia (+62)')
    expect(countryOption(['Germany', 'France'], 'ID')).toBeNull()
  })
})


describe('questions whose answer the system already knows', () => {
  const rc = (over: Partial<ResolveContext> = {}): ResolveContext => ({
    profile: profile({ country: '', location: 'Yaounde, Cameroon' }),
    company: 'Tether',
    job: { id: 'job-1', location: 'Remote' },
    today: TODAY,
    ...over,
  })
  const ask = (label: string, extra: { kind?: string; options?: string[] } = {}) => ({ label, key: 'q', ats: 'recruitee', kind: 'text', ...extra })

  it('reads "from which country will you be working?" as the country, from the location', () => {
    const r = resolveQuestion(ask('Considering this is a remote role, from which country will you be working?'), rc())
    expect(r.classification?.field.key).toBe('country_of_residence')
    expect(r.value).toBeTruthy()
    expect(String(r.value)).toMatch(/Cameroon|CM/)
  })

  const onBoard = (foundOn: string) => rc({ job: { id: 'job-1', location: 'Remote', foundOn } })

  it('answers "how did you hear" with the board it was found on when nothing is stored: Other, not a guessed site', () => {
    const options = ['Company website', 'LinkedIn', 'HackerNews', 'Wellfound', 'Networking event or conference', 'Referral', 'Other']
    const r = resolveQuestion(ask('How did you hear about this opportunity?', { kind: 'select', options }), onBoard('Remotive'))
    expect(r.value).toBe('Other')
    expect(r.layer).toBe('computed')
    // The board itself, when the form lists it.
    expect(resolveQuestion(ask('How did you hear about this opportunity?', { kind: 'select', options }), onBoard('HackerNews')).value).toBe('HackerNews')
  })

  it('prefers a job-board choice when the form has one, and names the board in a free-text box', () => {
    expect(resolveQuestion(ask('How did you hear about this role?', { kind: 'select', options: ['LinkedIn', 'Job board', 'Other'] }), onBoard('Remotive')).value).toBe('Job board')
    expect(resolveQuestion(ask('How did you hear about this role?'), onBoard('Remotive')).value).toBe('Job board (Remotive)')
  })

  it('asks rather than guess when nobody said where the posting was found', () => {
    expect(resolveQuestion(ask('How did you hear about this role?', { kind: 'select', options: ['LinkedIn', 'Job board', 'Other'] }), rc()).value).toBeNull()
  })

  it('still lets a stored answer win', () => {
    const stored = rc({
      profile: profile({
        custom_answers: { [fieldFingerprint('referral_source')]: 'LinkedIn' },
        answer_meta: { [fieldFingerprint('referral_source')]: { source: 'user', fieldKey: 'referral_source' } },
      }),
    })
    expect(resolveQuestion(ask('How did you hear about this opportunity?', { kind: 'select', options: ['LinkedIn', 'Other'] }), stored).value).toBe('LinkedIn')
  })
})



describe('a salary in the period the form asks for', () => {
  const base = { company: 'Tether', job: { id: 'job-1' }, today: TODAY }
  const ask = (label: string) => ({ label, key: 'q', ats: 'recruitee', kind: 'text' })
  const withPay = (value: string): ResolveContext => ({ ...base, profile: profile({ desired_salary: null }), overrides: { desired_salary: value } })

  it('turns a monthly figure into the annual one a form asks for', () => {
    expect(resolveQuestion(ask("What's your expected annual salary for this role? (in USD)"), withPay('3500 USD per month')).value).toBe('42000 USD')
  })

  it('and an annual figure into a monthly one', () => {
    expect(resolveQuestion(ask('What is your expected monthly salary?'), withPay('60000 USD per year')).value).toBe('5000 USD')
    expect(resolveQuestion(ask('What is your expected monthly salary?'), withPay('5000 USD per month')).value).toBe('5000 USD')
  })

  it('leaves a figure with no stated period, or a question with none, exactly as it is', () => {
    expect(resolveQuestion(ask('What is your expected annual salary?'), withPay('3500 USD')).value).toBe('3500 USD')
    expect(resolveQuestion(ask('Salary expectations'), withPay('3500 USD per month')).value).toBe('3500 USD per month')
  })
})

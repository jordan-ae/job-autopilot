import { describe, expect, it } from 'vitest'
import type { WorkAuthorization } from '../types.js'
import {
  checkEligibility,
  eligibilityExcerpt,
  eligibilityQuestion,
  parseLocationField,
  parseRestrictions,
  verdictFromJev,
  type Applicant,
  type Verdict,
} from './eligibility.js'
import { regionsInText } from './regions.js'

const auth = (region: string, authorized: boolean | null, needs_sponsorship: boolean | null = null): WorkAuthorization => ({
  region,
  authorized,
  needs_sponsorship,
  open_to_contractor_eor: null,
})

/** The typical subscriber: a remote developer in Indonesia, authorised there only. */
const JAKARTA: Applicant = { country: 'ID', citizenship: ['ID'], workAuthorizations: [auth('ID', true, false)] }
const LISBON: Applicant = { country: 'PT', citizenship: ['PT'], workAuthorizations: [auth('EU', true, false)] }
const AUSTIN: Applicant = { country: 'US', citizenship: ['US'], workAuthorizations: [auth('US', true, false)] }
const NOWHERE: Applicant = { country: null, citizenship: [], workAuthorizations: [] }

describe('regionsInText', () => {
  it.each([
    ['Remote - US', ['US']],
    ['San Francisco, CA', ['US']],
    ['Austin, TX', ['US']],
    ['Toronto, ON', ['CA']],
    ['Berlin, DE', ['DE']],
    ['London, United Kingdom', ['GB']],
    ['Remote (UK)', ['GB']],
    ['Albuquerque, New Mexico', ['US']],
    ['Jakarta, Indonesia', ['ID']],
    ['Remote - US & Canada', ['CA', 'US']],
    ['Bengaluru', ['IN']],
  ])('%s → %j', (text, expected) => {
    expect([...regionsInText(text).countries].sort()).toEqual(expected)
  })

  it('expands region groups', () => {
    expect(regionsInText('Remote - EMEA').countries.has('NG')).toBe(true)
    expect(regionsInText('Remote - EMEA').countries.has('ID')).toBe(false)
    expect(regionsInText('LATAM').countries.has('BR')).toBe(true)
    expect(regionsInText('LATAM').countries.has('US')).toBe(false)
    expect(regionsInText('Remote, Americas').countries.has('US')).toBe(true)
    expect(regionsInText('Remote in Europe').countries.has('PT')).toBe(true)
    expect(regionsInText('APAC').countries.has('ID')).toBe(true)
    expect(regionsInText('North America').countries.has('BR')).toBe(false)
  })

  it('does not read "us" in a sentence as the United States', () => {
    expect(regionsInText('come work with us').countries.size).toBe(0)
  })
})

describe('parseLocationField', () => {
  it('splits multi-location strings into options', () => {
    const options = parseLocationField('Remote - US; Remote - Canada', true)
    expect(options).toHaveLength(2)
    expect(options.every((option) => option.remote)).toBe(true)
  })

  it('reads a bare Remote as remote with no place', () => {
    expect(parseLocationField('Remote', true)).toEqual([{ remote: true, countries: null, label: 'remote' }])
  })

  it('reads worldwide', () => {
    expect(parseLocationField('Remote (Worldwide)', true)[0].countries).toBe('anywhere')
    expect(parseLocationField('Anywhere', true)[0].countries).toBe('anywhere')
  })

  it('treats hybrid as on-site', () => {
    expect(parseLocationField('Hybrid - London', false)[0].remote).toBe(false)
  })
})

/**
 * Real location strings and description sentences seen on Greenhouse, Ashby,
 * Lever, Himalayas and Arbeitnow postings, and what each means for a
 * developer in Jakarta.
 */
const TABLE: Array<{ name: string; location: string; remote?: boolean; description?: string; user?: Applicant; verdict: Verdict; jev?: boolean }> = [
  { name: 'worldwide', location: 'Remote (Worldwide)', verdict: 'eligible' },
  { name: 'anywhere', location: 'Anywhere', verdict: 'eligible' },
  { name: 'remote - global', location: 'Remote - Global', verdict: 'eligible' },
  { name: 'US only', location: 'Remote - US', verdict: 'ineligible' },
  { name: 'US-Remote', location: 'US-Remote', verdict: 'ineligible' },
  { name: 'USA remote', location: 'United States (Remote)', verdict: 'ineligible' },
  { name: 'US & Canada', location: 'Remote - US & Canada', verdict: 'ineligible' },
  { name: 'EU/UK', location: 'Remote - EU/UK', verdict: 'ineligible' },
  { name: 'EMEA', location: 'Remote, EMEA', verdict: 'ineligible' },
  { name: 'LATAM', location: 'Remote - LATAM', verdict: 'ineligible' },
  { name: 'APAC', location: 'Remote - APAC', verdict: 'eligible' },
  { name: 'Southeast Asia', location: 'Remote (Southeast Asia)', verdict: 'eligible' },
  { name: 'Indonesia', location: 'Remote - Indonesia', verdict: 'eligible' },
  { name: 'Jakarta on-site', location: 'Jakarta, Indonesia', remote: false, verdict: 'eligible' },
  { name: 'SF on-site', location: 'San Francisco, CA', remote: false, verdict: 'ineligible' },
  { name: 'NYC hybrid', location: 'New York, NY (Hybrid)', remote: false, verdict: 'ineligible' },
  { name: 'London or remote UK', location: 'London | Remote (UK)', verdict: 'ineligible' },
  { name: 'bare remote, silent description', location: 'Remote', description: 'We build payroll software. You will own our API.', verdict: 'unknown', jev: true },
  { name: 'empty location', location: '', remote: false, verdict: 'unknown', jev: true },
  {
    name: 'bare remote + work from anywhere',
    location: 'Remote',
    description: 'We are a fully distributed team and hire from anywhere in the world.',
    verdict: 'eligible',
  },
  {
    name: 'bare remote + based in US',
    location: 'Remote',
    description: 'Candidates must be based in the United States.',
    verdict: 'ineligible',
  },
  {
    name: 'worldwide label but US-based in text',
    location: 'Remote',
    description: 'This role is open to US-based candidates only.',
    verdict: 'ineligible',
  },
  {
    name: 'Americas time zones',
    location: 'Remote',
    description: 'Work from anywhere in the world. You must be able to work in Americas time zones.',
    verdict: 'ineligible',
  },
  {
    name: 'UTC-3 to UTC+3',
    location: 'Remote (Worldwide)',
    description: 'We require overlap: you should be within UTC-3 to UTC+3.',
    verdict: 'ineligible',
  },
  {
    name: 'GMT+7 ± 2',
    location: 'Remote (Worldwide)',
    description: 'Our team works in GMT+7 ± 2 hours.',
    verdict: 'eligible',
  },
  {
    name: 'must be authorized in the US',
    location: 'Remote',
    description: 'You must be legally authorized to work in the United States.',
    verdict: 'ineligible',
  },
  {
    name: 'authorized in the US, user is US-authorised',
    location: 'Remote - US',
    description: 'You must be authorized to work in the U.S. without sponsorship.',
    user: AUSTIN,
    verdict: 'eligible',
  },
  {
    name: 'US citizens only',
    location: 'Remote - US',
    description: 'US citizenship required due to government contracts.',
    user: { ...AUSTIN, citizenship: ['CA'] },
    verdict: 'ineligible',
  },
  {
    name: 'security clearance',
    location: 'Remote (Worldwide)',
    description: 'An active Secret clearance is required.',
    verdict: 'ineligible',
  },
  {
    name: 'EU resident with an EU-wide row',
    location: 'Remote - EU',
    description: 'You must have the right to work in the EU.',
    user: LISBON,
    verdict: 'eligible',
  },
  {
    name: 'no sponsorship, user needs it',
    location: 'Remote - US',
    description: 'We are unable to sponsor visas for this role.',
    user: { country: 'US', citizenship: ['IN'], workAuthorizations: [auth('US', true, true)] },
    verdict: 'ineligible',
  },
  {
    name: 'authorised in the US but no row on file',
    location: 'Remote - US',
    description: 'Must be authorized to work in the US.',
    user: { country: 'US', citizenship: [], workAuthorizations: [] },
    verdict: 'unknown',
  },
  {
    name: 'country unknown, regional job',
    location: 'Remote - US',
    user: NOWHERE,
    verdict: 'unknown',
  },
  {
    name: 'country unknown, worldwide job',
    location: 'Remote (Worldwide)',
    user: NOWHERE,
    verdict: 'eligible',
  },
  {
    name: 'a restriction we cannot read',
    location: 'Remote (Worldwide)',
    description: 'Please note we can only hire in countries where we have an entity.',
    verdict: 'unknown',
    jev: true,
  },
  {
    name: 'unknown city, not remote',
    location: 'Springfield',
    remote: false,
    verdict: 'unknown',
    jev: true,
  },
  {
    name: 'auth in the country of the role, remote worldwide',
    location: 'Remote (Worldwide)',
    description: 'Visa sponsorship is not available.',
    verdict: 'eligible',
  },
  {
    name: 'HTML description',
    location: 'Remote',
    description: '<p>About us</p><ul><li>Remote within <strong>Europe</strong></li></ul>',
    verdict: 'ineligible',
  },
]

describe('checkEligibility: real-world postings for a developer in Jakarta', () => {
  it.each(TABLE)('$name → $verdict', ({ location, remote, description, user, verdict, jev }) => {
    const result = checkEligibility(
      { location, is_remote: remote ?? /remote|anywhere|worldwide/i.test(location), description: description ?? '' },
      user ?? JAKARTA,
    )
    expect({ verdict: result.verdict, reasons: result.reasons }).toMatchObject({ verdict })
    if (jev !== undefined) expect(result.needsJev).toBe(jev)
    if (verdict !== 'unknown') expect(result.needsJev).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('never says eligible for an unknown restriction, whatever the location says', () => {
    for (const row of TABLE.filter((entry) => entry.verdict === 'unknown')) {
      const result = checkEligibility({ location: row.location, is_remote: true, description: row.description ?? '' }, row.user ?? JAKARTA)
      expect(result.verdict).not.toBe('eligible')
    }
  })
})

describe('Jev for eligibility', () => {
  it('asks one noul about residence, naming the country', () => {
    const question = eligibilityQuestion('ID')
    expect(question.type).toBe('noul')
    expect(JSON.stringify(question)).toContain('Indonesia')
  })

  it('maps probabilities into bands, unknown in between', () => {
    expect(verdictFromJev(0.92)).toBe('eligible')
    expect(verdictFromJev(0.6)).toBe('unknown')
    expect(verdictFromJev(0.1)).toBe('ineligible')
  })

  it('sends only the sentences about place and hours', () => {
    const job = {
      location: 'Remote',
      is_remote: true,
      description: 'We build payroll software. Our stack is Go and Postgres. We can only hire in countries where we have an entity.',
    }
    const excerpt = eligibilityExcerpt(job, parseRestrictions(job))
    expect(excerpt).toContain('countries where we have an entity')
    expect(excerpt).not.toContain('Go and Postgres')
  })
})

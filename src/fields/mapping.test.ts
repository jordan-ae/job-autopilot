import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifyQuestion } from './classify.js'
import { corpusFromFixtures, type CorpusQuestion } from './corpusSource.js'
import { fingerprintQuestion } from './text.js'

/**
 * How many of the 455 questions on the 25 captured real forms map to a
 * canonical field — before the registry, and now.
 *
 * "Before" is the matcher list Arkoo's answers.ts used until the registry
 * replaced it, kept here verbatim as the baseline: ~15 meanings, wording
 * only, no ATS-native keys.
 */
const LEGACY_PROFILE_MATCHERS: Array<{ test: RegExp; unless?: RegExp }> = [
  { test: /^(?:legal )?(?:first|given) name$/ },
  { test: /^(?:legal )?(?:last|family) name$|^surname$/ },
  { test: /^(?:your |candidate |applicant )?(?:full legal |full |legal )?name$/ },
  { test: /^(?:your )?e ?mail(?: address)?$/ },
  { test: /^(?:your )?(?:(?:mobile|cell|contact) )?(?:phone|telephone|mobile)(?: number)?$/ },
  { test: /^(?:your )?linkedin\b|\blinkedin (?:profile|url|link)\b/ },
  { test: /^(?:your )?github\b|\bgithub (?:profile|url|link)\b/ },
  { test: /^(?:your )?(?:portfolio|personal website|website)\b|\b(?:portfolio|personal website) (?:url|link)\b/ },
  {
    test: new RegExp(
      [
        '^(?:your )?(?:current )?(?:location|city)(?: city)?$',
        '^(?:your )?(?:current )?city(?: (?:and|or|state|province|country|region|of residence))+$',
        '^(?:what|which) city do you (?:currently )?(?:live|reside) in$',
        '^where are you (?:currently )?(?:based|located)$',
        '^(?:please (?:enter|provide|share|list) )?your current (?:working |home )?location$',
      ].join('|'),
    ),
  },
  { test: /\b(?:require|need)\b.*\bsponsor/, unless: /\bwithout\b|^if\b/ },
  { test: /\b(authorized to work|work authorization|right to work|legally authorized)\b/, unless: /\bwithout\b/ },
  { test: /\b(notice period)\b/ },
  { test: /\b(salary expectation|desired salary|expected salary|compensation expectation)\b/ },
  {
    test: /^(?:your )?(?:(?:earliest|preferred|desired|available|possible|expected) )*start date$|\b(?:earliest|soonest) (?:possible )?start\b|\bwhen (?:can|could|would) you (?:be able to )?start\b|\bavailable (?:to start|from)\b/,
  },
]

function legacyMaps(question: CorpusQuestion): boolean {
  const fingerprint = fingerprintQuestion(question.label, question.company)
  return LEGACY_PROFILE_MATCHERS.some((matcher) => matcher.test.test(fingerprint) && !matcher.unless?.test(fingerprint))
}

function nowMaps(question: CorpusQuestion) {
  return classifyQuestion(
    { label: question.label, description: question.description, section: question.section, key: question.key, ats: question.ats, kind: question.kind, options: question.options },
    question.company,
  )
}

const CORPUS: CorpusQuestion[] = corpusFromFixtures(join(fileURLToPath(new URL('.', import.meta.url)), '../../test/fixtures/forms'))

const pct = (n: number, d: number) => Number(((n / d) * 100).toFixed(1))

describe('fixture questions mapped to a canonical field', () => {
  it('measures the corpus read from the 25 captured forms', () => {
    expect(new Set(CORPUS.map((question) => `${question.ats}/${question.form}`)).size).toBe(25)
    expect(CORPUS).toHaveLength(455)
  })

  it('maps far more of the 455 questions than the old matchers did', () => {
    const before = CORPUS.filter(legacyMaps).length
    const after = CORPUS.filter((question) => nowMaps(question) !== null).length

    const byAts = Object.fromEntries(
      (['greenhouse', 'ashby', 'lever'] as const).map((ats) => {
        const subset = CORPUS.filter((question) => question.ats === ats)
        return [
          ats,
          `${pct(subset.filter(legacyMaps).length, subset.length)}% → ${pct(subset.filter((question) => nowMaps(question) !== null).length, subset.length)}% of ${subset.length}`,
        ]
      }),
    )
    const viaNative = CORPUS.filter((question) => nowMaps(question)?.via === 'native').length
    console.log(
      `[field mapper] fixture questions mapped: before ${before}/${CORPUS.length} (${pct(before, CORPUS.length)}%) → ` +
        `after ${after}/${CORPUS.length} (${pct(after, CORPUS.length)}%); ${viaNative} by ATS-native key. ${JSON.stringify(byAts)}`,
    )
    console.log(
      `[field mapper] still unmapped: ${CORPUS.filter((question) => !nowMaps(question))
        .map((question) => `${question.ats}:"${question.label.slice(0, 60)}"`)
        .join('; ')}`,
    )

    // Measured 2026-10-20: 167 (36.7%) before, 454 (99.8%) after. The registry
    // was written against these same forms, so the "after" figure is an upper
    // bound — a held-out set of forms will map less, and the agent pass covers
    // the difference.
    expect(before).toBe(167)
    expect(after).toBeGreaterThanOrEqual(445)
  })

  it('maps the questions that matter, to the right field', () => {
    const keyFor = (label: string, extra: Partial<CorpusQuestion> = {}) =>
      nowMaps({ ats: 'greenhouse', form: 'x', company: 'Acme', key: 'question_1', kind: 'text', label, required: false, ...extra })?.field.key ?? null

    expect(keyFor('Are you legally authorized to work in the country where the job is located?')).toBe('work_authorized')
    expect(keyFor('Are you eligible to work in the US without sponsorship indefinitely?')).toBe('work_authorized_without_sponsorship')
    expect(keyFor('Will you now or in the future require company sponsorship to retain or extend your work authorization?')).toBe('requires_sponsorship')
    expect(keyFor('If you do need work sponsorship, please share the details')).toBe('sponsorship_details')
    expect(keyFor('Which location are you applying for?', { ats: 'lever', key: 'opportunityLocationId' })).toBe('job_location_choice')
    expect(keyFor('Have you worked at Acme in the past in a Full-Time, Part-Time, Contractor or Intern capacity?')).toBe('previously_employed_here')
    expect(keyFor('Are you located within 50 miles of one of the following office hubs')).toBe('near_office')
    expect(keyFor('Country', { section: 'Phone', key: 'country' })).toBe('phone_country')
    expect(keyFor('Company name', { key: 'company-name-0' })).toBe('employment_company')
    expect(keyFor('Start date month', { key: 'start-month--0' })).toBe('education_start_month')
    expect(keyFor('What is your location?', { section: 'Demographic Survey' })).toBe('demographic_location')
    // Outside a demographic survey the same words name nothing we would fill.
    expect(keyFor('What is your location?')).toBeNull()
    expect(keyFor('What is your current age?', { kind: 'radio', options: ['Under 30', '30-39'] })).toBe('eeo_age_range')
  })

  it('never maps an EEO or consent question to a field that would be filled from the profile', () => {
    for (const question of CORPUS) {
      const field = nowMaps(question)?.field
      if (!field) continue
      const looksEeo = /\b(gender|race|ethnic|veteran|disabilit|sexual orientation|transgender|hispanic)\b/i.test(question.label)
      if (looksEeo) expect(field.sensitivity, `${question.label} → ${field.key}`).toBe('eeo')
      if (question.kind === 'checkbox' && /consent|agree|certify/i.test(question.label)) {
        expect(field.sensitivity, `${question.label} → ${field.key}`).toBe('consent')
      }
    }
  })
})

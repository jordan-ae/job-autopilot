import { describe, expect, it } from 'vitest'
import { fillAnswers, findSimilarAnswer, fingerprintQuestion, namesCompany, unansweredRequired } from './answers.js'
import { splitAtsJobId, type ApplicationProfile, type ApplyQuestion } from '../types.js'

function makeProfile(overrides: Partial<ApplicationProfile> = {}): ApplicationProfile {
  return {
    client_key: 'user-1',
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+44 20 7946 0958',
    location: 'London, UK',
    linkedin_url: 'https://linkedin.com/in/ada',
    portfolio_url: '',
    github_url: 'https://github.com/ada',
    work_authorization: 'UK citizen',
    requires_sponsorship: false,
    notice_period_days: 30,
    desired_salary: 95_000,
    desired_salary_currency: 'GBP',
    earliest_start_date: '2026-10-01',
    custom_answers: {},
    eeo: {},
    ...overrides,
  }
}

function q(overrides: Partial<ApplyQuestion> & { id: string; label: string }): ApplyQuestion {
  return { type: 'text', required: false, ...overrides }
}

describe('fingerprintQuestion', () => {
  it('collapses punctuation and case', () => {
    expect(fingerprintQuestion('What is your Phone Number?')).toBe('what is your phone number')
  })

  it('strips the employer name, with or without its legal suffix', () => {
    const a = fingerprintQuestion('Why do you want to work at Acme, Inc.?', 'Acme')
    const b = fingerprintQuestion('Why do you want to work at Acme?', 'Acme')
    expect(a).toBe(b)
  })

  it('leaves the question intact when no company is given', () => {
    expect(fingerprintQuestion('Why Acme?')).toBe('why acme')
  })
})

describe('fillAnswers', () => {
  const profile = makeProfile()

  it('fills the standard identity fields from the profile', () => {
    const filled = fillAnswers(
      [
        q({ id: 'first_name', label: 'First Name' }),
        q({ id: 'last_name', label: 'Last Name' }),
        q({ id: 'email', label: 'Email' }),
        q({ id: 'phone', label: 'Phone' }),
        q({ id: 'lk', label: 'LinkedIn Profile' }),
      ],
      profile,
      'Acme',
    )
    expect(filled.map((f) => f.answer)).toEqual([
      'Ada',
      'Lovelace',
      'ada@example.com',
      '+44 20 7946 0958',
      'https://linkedin.com/in/ada',
    ])
  })

  it('NEVER invents an answer to a question it does not recognise', () => {
    const filled = fillAnswers(
      [q({ id: 'x', label: 'Describe a time you disagreed with your manager.', required: true, type: 'textarea' })],
      profile,
      'Acme',
    )
    expect(filled[0].answer).toBeNull()
    expect(unansweredRequired(filled)).toHaveLength(1)
  })

  it('reuses a stored custom answer for the same question at a different employer', () => {
    const stored = makeProfile({
      custom_answers: { 'why do you want to work here': 'Because the problem is interesting.' },
    })
    const filled = fillAnswers(
      [q({ id: 'x', label: 'Why do you want to work here?', required: true })],
      stored,
      'Acme',
    )
    expect(filled[0].answer).toBe('Because the problem is interesting.')
  })

  it('leaves a profile field blank rather than guessing when it is empty', () => {
    const blank = makeProfile({ phone: '', desired_salary: null })
    const filled = fillAnswers(
      [
        q({ id: 'p', label: 'Phone', required: true }),
        q({ id: 's', label: 'Desired salary', required: true }),
      ],
      blank,
      'Acme',
    )
    expect(filled.every((f) => f.answer === null)).toBe(true)
    expect(unansweredRequired(filled)).toHaveLength(2)
  })

  it('does not overwrite an answer that is already set', () => {
    const filled = fillAnswers([q({ id: 'email', label: 'Email', answer: 'typed@example.com' })], profile, 'Acme')
    expect(filled[0].answer).toBe('typed@example.com')
  })

  it('coerces yes/no answers for boolean questions', () => {
    const filled = fillAnswers(
      [q({ id: 'sp', label: 'Do you require visa sponsorship?', type: 'boolean', required: true })],
      profile,
      'Acme',
    )
    expect(filled[0].answer).toBe(false)
  })

  it('snaps an answer onto the select option with the same text', () => {
    const filled = fillAnswers(
      [
        q({
          id: 'auth',
          label: 'Work authorization',
          type: 'select',
          required: true,
          options: ['Requires sponsorship', 'uk  Citizen'],
        }),
      ],
      profile,
      'Acme',
    )
    expect(filled[0].answer).toBe('uk  Citizen')
  })

  it('asks rather than pick an option that merely contains the stored text', () => {
    // "UK citizen" is inside "UK citizen or settled status", and "No" is
    // inside "I do not wish to answer". Neither is the same answer.
    const filled = fillAnswers(
      [
        q({ id: 'auth', label: 'Work authorization', type: 'select', required: true, options: ['UK citizen or settled status', 'Requires sponsorship'] }),
        q({ id: 'sp', label: 'Will you require sponsorship?', type: 'select', required: true, options: ['I do not wish to answer', 'Not applicable'] }),
      ],
      profile,
      'Acme',
    )
    expect(filled.map((f) => f.answer)).toEqual([null, null])
  })

  it('maps a plain yes or no onto the one option that opens with it', () => {
    const filled = fillAnswers(
      [
        q({ id: 'a', label: 'Will you require sponsorship?', type: 'select', options: ['Yes, I will require sponsorship', 'No, I will not'] }),
        // Two options open with "No": which one is meant is the applicant's call.
        q({ id: 'b', label: 'Will you require sponsorship?', type: 'select', options: ['Yes', 'No, never', 'No, not currently'] }),
      ],
      profile,
      'Acme',
    )
    expect(filled.map((f) => f.answer)).toEqual(['No, I will not', null])
  })

  it('restores a remembered multi-select only when every part is still an option', () => {
    const stored = makeProfile({ custom_answers: { 'which languages do you speak': 'English, French' } })
    const ask = (options: string[]) =>
      fillAnswers([q({ id: 'l', label: 'Which languages do you speak?', type: 'multiselect', options })], stored, 'Acme')[0].answer
    expect(ask(['English', 'French', 'German'])).toEqual(['English', 'French'])
    expect(ask(['English', 'German'])).toBeNull()
  })

  it('asks rather than guesses when no option matches what we hold', () => {
    const filled = fillAnswers(
      [
        q({
          id: 'auth',
          label: 'Work authorization',
          type: 'select',
          required: true,
          options: ['Authorized in the US', 'Not authorized in the US'],
        }),
      ],
      profile,
      'Acme',
    )
    expect(filled[0].answer).toBeNull()
  })
})

describe('fillAnswers on wordings from real forms', () => {
  const profile = makeProfile({ portfolio_url: 'https://ada.dev' })
  const answer = (label: string, extra: Partial<ApplyQuestion> = {}, company = 'Acme') =>
    fillAnswers([q({ id: 'x', label, ...extra })], profile, company)[0].answer

  it('fills the applicant’s name only into questions that ask for it', () => {
    for (const label of ['Name', 'Full Name', 'Legal Name', 'Full Legal Name']) expect(answer(label), label).toBe('Ada Lovelace')
    for (const label of [
      'Company name',
      'Current/Most Recent Company Name',
      'Please provide the name of your current (or most recent) company',
      'Preferred Name',
      'Preferred First Name',
      'Name Pronunciation',
      'If yes, please provide their name(s) and department(s) so we can ensure there are no potential conflicts',
    ]) {
      expect(answer(label), label).toBeNull()
    }
  })

  it('fills where the applicant is, not where the job is', () => {
    for (const label of [
      'Location',
      'Location (City)',
      'Current location',
      'Please enter your current working location',
      'What city do you currently live in?',
    ]) {
      expect(answer(label), label).toBe('London, UK')
    }
    for (const label of [
      'Which location are you applying for?',
      'What is your location?',
      'Are you eligible to work in this location (without sponsorship)?',
      'Are you legally authorized to work in the location where this role is based?',
      'Are you aware that this role requires relocation to Denver, and is that something you would truly consider?',
    ]) {
      // The last two are yes/no questions on the real forms.
      expect(answer(label, { type: 'boolean' }), label).toBeNull()
      expect(answer(label), label).not.toBe('London, UK')
    }
  })

  it('answers sponsorship only when the question asks whether it is needed', () => {
    const yesNo: Partial<ApplyQuestion> = { type: 'boolean' }
    for (const label of [
      'Will you now or in the future require visa sponsorship?',
      'Do you now, or will you in the future, require immigration sponsorship to work at Acme?',
      'Now, or at any time in the future, will you require sponsorship?',
    ]) {
      expect(answer(label, yesNo), label).toBe(false)
    }
    // "No sponsorship needed" answered into this one would say the applicant
    // is NOT eligible — the reverse of the truth.
    expect(answer('Are you eligible to work in the US without sponsorship indefinitely?', yesNo)).toBeNull()
    // A stored yes/no is not the prose this asks for.
    expect(answer('If you do need work sponsorship, please share the details', { type: 'textarea' })).toBeNull()
    // Holding a visa and needing one sponsored are different facts.
    expect(answer('Do you hold a valid visa?', yesNo)).toBeNull()
  })

  it('does not mistake a past job’s start date for the applicant’s availability', () => {
    expect(answer('Earliest start date')).toBe('2026-10-01')
    expect(answer('When can you start?')).toBe('2026-10-01')
    expect(answer('Start date month')).toBeNull()
    expect(answer('Start date year')).toBeNull()
  })

  it('fills links into the fields that ask for them', () => {
    expect(answer('LinkedIn Profile (indicate N/A if you don\'t have one)')).toBe('https://linkedin.com/in/ada')
    expect(answer('Portfolio / Github URL')).toBe('https://github.com/ada')
    expect(answer('Personal Website/Portfolio')).toBe('https://ada.dev')
    expect(answer('Other website')).toBeNull()
  })

  it('never pre-fills an equal-opportunity question or a consent', () => {
    const stored = makeProfile({ custom_answers: { gender: 'Female', 'i consent to my data being processed': 'Yes' } })
    const filled = fillAnswers(
      [
        q({ id: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Decline To Self Identify'], kind: 'eeo' }),
        q({ id: 'gdpr', label: 'I consent to my data being processed', type: 'boolean', required: true, kind: 'consent' }),
      ],
      stored,
      'Acme',
    )
    expect(filled.map((f) => f.answer)).toEqual([null, null])
  })
})

describe('answers about one employer stay with that employer', () => {
  it('recognises the employer’s name, including a slug-style one', () => {
    expect(namesCompany('Why do you want to work at Acme?', 'Acme')).toBe(true)
    expect(namesCompany('Why Maven Clinic?', 'Mavenclinic')).toBe(true)
    expect(namesCompany('What draws you to this role?', 'Acme')).toBe(false)
    // A two-letter name inside an ordinary word is not a mention.
    expect(namesCompany('Describe a product you shipped', 'Ro')).toBe(false)
  })

  it('does not reuse a stored answer for a question that names this employer', () => {
    const stored = makeProfile({
      custom_answers: { 'why do you want to work at': 'I have followed Acme\'s launches for years.' },
    })
    const filled = fillAnswers([q({ id: 'x', label: 'Why do you want to work at Beta?', required: true })], stored, 'Beta')
    expect(filled[0].answer).toBeNull()
  })

  it('still reuses an answer to a question that names nobody', () => {
    const stored = makeProfile({ custom_answers: { 'what is your notice period': '30 days' } })
    const filled = fillAnswers([q({ id: 'x', label: 'What is your notice period?' })], stored, 'Beta')
    expect(filled[0].answer).toBe('30 days')
  })
})

describe('unansweredRequired', () => {
  it('ignores optional questions and file fields', () => {
    const questions = [
      q({ id: 'a', label: 'Optional note', required: false }),
      q({ id: 'b', label: 'Resume', required: true, type: 'file' }),
      q({ id: 'c', label: 'Required', required: true, answer: null }),
      q({ id: 'd', label: 'Empty list', required: true, type: 'multiselect', answer: [] }),
    ]
    expect(unansweredRequired(questions).map((x) => x.id)).toEqual(['c', 'd'])
  })
})

describe('splitAtsJobId', () => {
  it('splits board from posting id', () => {
    expect(splitAtsJobId('acme:4012345')).toEqual({ board: 'acme', jobId: '4012345' })
  })

  it('keeps colons inside the posting id', () => {
    expect(splitAtsJobId('acme:a:b')).toEqual({ board: 'acme', jobId: 'a:b' })
  })

  it('rejects malformed values', () => {
    expect(splitAtsJobId('')).toBeNull()
    expect(splitAtsJobId('acme')).toBeNull()
    expect(splitAtsJobId(':4012345')).toBeNull()
    expect(splitAtsJobId('acme:')).toBeNull()
  })
})

describe('findSimilarAnswer', () => {
  const stored = {
    'why do you want to work at': 'I like small teams shipping real products.',
    'what are your salary expectations': '$120,000',
    'start date': '2026-10-01',
  }

  it('reuses an answer across a near-identical wording', () => {
    // "at" vs "for" is the same question; it used to be two.
    const match = findSimilarAnswer('why do you want to work for', stored)
    expect(match?.value).toBe('I like small teams shipping real products.')
  })

  it('does not bridge questions that merely share vocabulary', () => {
    expect(findSimilarAnswer('what do you want to work on', stored)).toBeNull()
  })

  it('refuses short fingerprints, where one token flips the meaning', () => {
    // 'end date' vs 'start date' is a single token apart.
    expect(findSimilarAnswer('end date', stored)).toBeNull()
  })

  it('ignores empty stored answers', () => {
    expect(findSimilarAnswer('why do you want to work for', { 'why do you want to work at': '' })).toBeNull()
  })

  it('requires more than filler words in common', () => {
    // Same content words, different connectives — the case this exists for.
    expect(findSimilarAnswer('why would you want to work at', stored)?.key).toBe(
      'why do you want to work at',
    )
    // One content word in common is not a match, however similar it reads.
    expect(findSimilarAnswer('what is your current salary', stored)).toBeNull()
  })

  it('refuses to bridge a one-word question that flips meaning', () => {
    // Both reduce to {visa}; they ask the opposite thing.
    expect(findSimilarAnswer('will you need a visa', { 'do you have a visa': 'No' })).toBeNull()
  })
})

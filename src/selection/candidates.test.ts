import { describe, expect, it } from 'vitest'
import {
  agentAffordable,
  alreadyHandled,
  companyCap,
  companyExcluded,
  EMPTY_HISTORY,
  relevance,
  salaryBelowFloor,
  seniorityLevels,
  shortlistKey,
  titleSearchPatterns,
  trackedKey,
  type History,
} from './candidates.js'
import { job, profile, targeting } from './fixtures.js'

const NOW = new Date()

const SETTINGS = { remoteOnly: false, locations: [], excludedKeywords: [], excludedCompanies: [] }

describe('relevance (the digest scorer against profile targeting)', () => {
  it('keeps a posting whose title matches a target title', () => {
    expect(relevance(job(), [profile('p1')], SETTINGS)).toMatchObject({ profileId: 'p1' })
  })

  it('drops a posting whose title shares too little with every target title', () => {
    expect(relevance(job({ role: 'Account Executive' }), [profile('p1')], SETTINGS)).toBeNull()
  })

  it('picks the profile that fits best', () => {
    const profiles = [profile('backend'), profile('data', { targetTitles: ['Data Engineer'], mustHaveSkills: ['Python'] })]
    expect(relevance(job({ role: 'Data Engineer', tags: ['python'] }), profiles, SETTINGS)?.profileId).toBe('data')
  })

  it('applies the settings and profile exclusions, case-insensitively', () => {
    expect(relevance(job({ company: 'ACME Corp' }), [profile('p1')], { ...SETTINGS, excludedCompanies: ['acme'] })).toBeNull()
    expect(relevance(job(), [profile('p1', { excludedCompanies: ['Acme'] })], SETTINGS)).toBeNull()
    expect(relevance(job({ short_description: 'Crypto trading platform' }), [profile('p1')], { ...SETTINGS, excludedKeywords: ['crypto'] })).toBeNull()
  })

  it('honours remote preference and seniority', () => {
    expect(relevance(job({ is_remote: false }), [profile('p1')], SETTINGS)).toBeNull()
    expect(relevance(job({ role: 'Junior Backend Engineer' }), [profile('p1')], SETTINGS)).toBeNull()
    expect(relevance(job({ role: 'Staff Backend Engineer' }), [profile('p1')], SETTINGS)).not.toBeNull()
  })

  it('drops stale postings', () => {
    expect(relevance(job({ posted_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }), [profile('p1')], SETTINGS)).toBeNull()
  })
})

describe('salary floor', () => {
  it('applies only in the same currency', () => {
    const t = targeting({ salaryFloor: 100_000, salaryFloorCurrency: 'USD' })
    expect(salaryBelowFloor({ salary_min: 50_000, salary_max: 80_000, salary_currency: 'USD' }, t)).toBe(true)
    expect(salaryBelowFloor({ salary_min: 50_000, salary_max: 80_000, salary_currency: 'EUR' }, t)).toBe(false)
    expect(salaryBelowFloor({ salary_min: null, salary_max: null, salary_currency: 'USD' }, t)).toBe(false)
  })
})

describe('seniority bands', () => {
  it('accepts one step either side', () => {
    expect(seniorityLevels('senior')).toEqual(['mid', 'senior', 'lead'])
    expect(seniorityLevels('')).toEqual([])
  })
})

describe('dedupe', () => {
  const history: History = {
    ...EMPTY_HISTORY,
    attemptedJobIds: new Set(['a']),
    trackedJobIds: new Set(['t']),
    trackedKeys: new Set([trackedKey('Globex', 'Platform Engineer')]),
    hiddenJobIds: new Set(['h']),
  }

  it('skips attempted (any origin), tracked and hidden postings', () => {
    expect(alreadyHandled({ id: 'a', company: 'X', role: 'Y' }, history)).toBe('already_applied')
    expect(alreadyHandled({ id: 't', company: 'X', role: 'Y' }, history)).toBe('tracked')
    expect(alreadyHandled({ id: 'h', company: 'X', role: 'Y' }, history)).toBe('hidden')
    expect(alreadyHandled({ id: 'new', company: 'X', role: 'Y' }, history)).toBeNull()
  })

  it('matches a hand-typed tracker row by company and role', () => {
    expect(alreadyHandled({ id: 'other', company: 'GLOBEX', role: 'Platform  Engineer' }, history)).toBe('tracked')
  })
})

describe('company caps', () => {
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()

  it('stops at the rolling 30-day limit, counting this run’s picks', () => {
    const history = { companyApplications: [{ company: 'Acme', at: daysAgo(3) }] }
    expect(companyCap('Acme', history, new Map(), { perCompany30d: 2 }, NOW)).toBeNull()
    expect(companyCap('acme', history, new Map([['acme', 1]]), { perCompany30d: 2 }, NOW)).toMatchObject({ code: 'company_cap' })
  })

  it('forgets applications older than 30 days', () => {
    const history = { companyApplications: [{ company: 'Acme', at: daysAgo(45) }, { company: 'Acme', at: daysAgo(31) }] }
    expect(companyCap('Acme', history, new Map(), { perCompany30d: 2 }, NOW)).toBeNull()
  })

  it("respects OpenAI's published 5 per 180 days", () => {
    const history = { companyApplications: [10, 40, 70, 100, 150].map((days) => ({ company: 'OpenAI', at: daysAgo(days) })) }
    expect(companyCap('OpenAI', history, new Map(), { perCompany30d: 10 }, NOW)).toMatchObject({ code: 'known_cap' })
    expect(companyCap('OpenAI', { companyApplications: history.companyApplications.slice(1) }, new Map(), { perCompany30d: 10 }, NOW)).toBeNull()
  })

  it('a cap of 0 turns the 30-day limit off', () => {
    const history = { companyApplications: [{ company: 'Acme', at: daysAgo(1) }, { company: 'Acme', at: daysAgo(2) }] }
    expect(companyCap('Acme', history, new Map(), { perCompany30d: 0 }, NOW)).toBeNull()
  })
})

describe('company exclusion matching', () => {
  it('matches whole words, any case', () => {
    expect(companyExcluded('Meta Platforms', ['meta'])).toBe(true)
    expect(companyExcluded('Metabase', ['meta'])).toBe(false)
    expect(companyExcluded('Acme', [''])).toBe(false)
  })
})

describe('compute budget', () => {
  it('allows agent postings only while the estimate fits under the budget', () => {
    const budget = { budgetUsd: 4, spentUsd: 3.4, agentEstimateUsd: 0.25 }
    expect(agentAffordable(budget, 0)).toBe(true)
    expect(agentAffordable(budget, 2)).toBe(false)
    expect(agentAffordable({ ...budget, spentUsd: 4 }, 0)).toBe(false)
    expect(agentAffordable({ ...budget, budgetUsd: 0 }, 0)).toBe(false)
  })

  it('ranks postings our fill engine covers ahead of agent-only ones of similar fit', () => {
    expect(shortlistKey(70, 'fill', 1)).toBeGreaterThan(shortlistKey(75, 'agent', 1))
    expect(shortlistKey(70, 'api', 1)).toBe(shortlistKey(70, 'fill', 1))
  })
})


describe('title spellings and the database-side narrowing', () => {
  const fullstack = (title: string) => [profile('p1', targeting({ targetTitles: [title] }))]

  it('reads Fullstack, Full-stack, Full Stack and "Full- Stack" as the same title', () => {
    for (const role of ['Fullstack Engineer', 'Full-stack Engineer 4 (TypeScript, Python, AWS)', 'Full Stack Developer', 'Full- Stack Engineer 4 (Python)']) {
      expect(relevance(job({ role }), fullstack('Fullstack'), SETTINGS), role).not.toBeNull()
      expect(relevance(job({ role }), fullstack('Full-Stack Engineer'), SETTINGS), role).not.toBeNull()
    }
  })

  it('still rejects a title about something else', () => {
    expect(relevance(job({ role: 'Account Executive' }), fullstack('Fullstack'), SETTINGS)).toBeNull()
  })

  it('narrows the load to the words that say which job, in every spelling', () => {
    expect(titleSearchPatterns(fullstack('Fullstack'))).toEqual(['%full%stack%'])
    expect(titleSearchPatterns(fullstack('Senior Backend Engineer'))).toEqual(['%back%end%'])
    expect(titleSearchPatterns(fullstack('Data Scientist'))).toEqual(['%data%', '%scientist%'])
  })

  it('uses a generic title as a phrase, and reads nothing narrower when no title is set', () => {
    expect(titleSearchPatterns(fullstack('Software Engineer'))).toEqual(['%software%engineer%'])
    expect(titleSearchPatterns([profile('p1', targeting({ targetTitles: [] }))])).toEqual([])
  })
})

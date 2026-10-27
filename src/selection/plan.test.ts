import { describe, expect, it, vi } from 'vitest'
import type { decide } from '../ai/decide.js'
import { EMPTY_HISTORY, type PoolJob, type Route } from './candidates.js'
import { FIXTURE_PROFILES, FIXTURE_SETTINGS, JAKARTA_DEV, fakeJev, fixtureBoard, fixtureHistory, job, profile } from './fixtures.js'
import { acceptMatch, combine, describeFactors, matchQuestions, MATCH_WEIGHTS, readMatch, scoreValue } from './match.js'
import { planSelection, selectionSignature, type PlanInput, type PriorDecision } from './plan.js'

const routeOf = (entry: PoolJob): Route => (entry.ats === 'greenhouse' || entry.ats === 'ashby' || entry.ats === 'lever' ? 'fill' : 'agent')
const BUDGET = { budgetUsd: 4, spentUsd: 0, agentEstimateUsd: 0.25 }

function input(over: Partial<PlanInput> = {}): PlanInput {
  const jobs = over.jobs ?? fixtureBoard()
  return {
    now: new Date(),
    applicant: JAKARTA_DEV,
    settings: FIXTURE_SETTINGS,
    profiles: FIXTURE_PROFILES,
    jobs,
    history: fixtureHistory(jobs),
    wanted: 3,
    mode: 'review_first',
    budget: BUDGET,
    caps: { perCompany30d: 2 },
    routeOf,
    signature: 'sig-1',
    ...over,
  }
}

describe('match arithmetic', () => {
  it('weights sum to one', () => {
    expect(Object.values(MATCH_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('combines factors with the documented weights', () => {
    const match = combine('p', {
      title: { value: 1, confidence: 0.9 },
      skills: { value: 0.5, confidence: 0.8 },
      seniority: { value: 1, confidence: 1 },
      same: { value: 0, confidence: 1 },
    })
    expect(match.score).toBeCloseTo(0.35 + 0.15 + 0.15)
    expect(match.confidence).toBeCloseTo(0.925)
  })

  it('shares out the weight of a question that was not asked', () => {
    const match = combine('p', { title: { value: 1, confidence: 1 }, same: { value: 1, confidence: 1 } })
    expect(match.score).toBe(1)
    expect(match.factors).toEqual({ title: 1, same: 1 })
  })

  it('reads a score as its expected level, not just the top answer', () => {
    const question = { criteria: ['a', 'b', 'c', 'd', 'e'] }
    expect(scoreValue({ type: 'score', score: 4, confidence: 0.5, probabilities: { '3': 0.5, '4': 0.5 } }, question)).toBeCloseTo(0.875)
    expect(scoreValue({ type: 'score', score: 2, confidence: 0.9, probabilities: {} }, question)).toBe(0.5)
    expect(scoreValue({ type: 'score', score: 0, confidence: 0.9, probabilities: { e: 1 } }, question)).toBe(1)
  })

  it('asks skills and seniority only when the profile sets them', () => {
    const questions = matchQuestions([profile('a', { mustHaveSkills: [], seniority: '' }), profile('b')])
    expect(Object.keys(questions).sort()).toEqual(['same_p0', 'same_p1', 'seniority_p1', 'skills_p1', 'title_p0', 'title_p1'])
  })
})

describe('profile pick and threshold', () => {
  const profiles = [profile('backend', {}, 'Backend'), profile('data', { targetTitles: ['Data Engineer'] }, 'Data')]
  const questions = matchQuestions(profiles)
  const answer = (p0: number, p1: number, confidence = 0.9) => ({
    title_p0: { type: 'score', score: p0 * 4, confidence, probabilities: {} },
    skills_p0: { type: 'score', score: p0 * 4, confidence, probabilities: {} },
    seniority_p0: { type: 'score', score: 2, confidence, probabilities: {} },
    same_p0: { type: 'noul', noul: p0 },
    title_p1: { type: 'score', score: p1 * 4, confidence, probabilities: {} },
    skills_p1: { type: 'score', score: p1 * 4, confidence, probabilities: {} },
    seniority_p1: { type: 'score', score: 2, confidence, probabilities: {} },
    same_p1: { type: 'noul', noul: p1 },
  })

  it('picks the best-fitting profile and says why', () => {
    const match = readMatch(profiles, questions, answer(0.25, 1))
    expect(match.best?.profileId).toBe('data')
    expect(match.reason).toContain('(Data)')
    expect(match.reason).toMatch(/title 1\.00, skills 1\.00, seniority 1\.00, same-role 1\.00/)
  })

  it('refuses a match under the minimum', () => {
    const match = readMatch(profiles, questions, answer(0.5, 0.25)).best
    expect(acceptMatch(match, 0.7)).toMatchObject({ ok: false, code: 'below_match' })
    expect(acceptMatch(match, 0.5)).toEqual({ ok: true })
  })

  it('refuses a confident-looking score Jev was unsure of', () => {
    const match = readMatch(profiles, questions, { ...answer(1, 0, 0.1), same_p0: { type: 'noul', noul: 0.55 } }).best
    expect(acceptMatch(match, 0.5)).toMatchObject({ ok: false, code: 'low_confidence' })
  })

  it('describes factors in a fixed order', () => {
    expect(describeFactors({ factors: { same: 0.5, title: 1 } })).toBe('title 1.00, same-role 0.50')
  })
})

describe('planSelection on the fixture board', () => {
  it('picks eligible, matching postings and says why it passed over the rest', async () => {
    const plan = await planSelection(input(), { decide: fakeJev() })
    const picked = plan.picks.map((pick) => pick.job.company)
    expect(picked).toHaveLength(3)
    // Worldwide or APAC postings on forms we can fill.
    for (const company of picked) expect(['Northwind', 'Globex', 'Initech', 'Stark', 'Wayne', 'Soylent']).toContain(company)

    const skipped = Object.fromEntries(plan.skips.map((skip) => [skip.job.company, skip.code]))
    expect(skipped.Hooli).toBe('ineligible') // remote US + US authorization
    expect(skipped.Umbrella).toBe('ineligible') // EMEA
    expect(skipped.Vandelay).toBe('ineligible') // US Eastern hours
    expect(skipped.OpenAI).toBe('known_cap') // 5 per 180 days, already used
    // Never considered: a sales role, an on-site role for remote-only
    // profiles, and a hidden posting.
    expect(skipped.Acme).toBeUndefined()
    expect(skipped['Massive Dynamic']).toBeUndefined()
    expect(skipped.Cyberdyne).toBeUndefined()
    expect(plan.counts.hidden).toBe(1)

    for (const pick of plan.picks) {
      expect(pick.matchScore).toBeGreaterThanOrEqual(FIXTURE_SETTINGS.minMatch)
      expect(pick.reason).toMatch(/title .*skills/)
    }
    // One Jev call per shortlisted posting, a fraction of a cent each.
    expect(plan.counts.jevCalls).toBe(plan.counts.shortlisted)
    expect(plan.usage.costUsd / plan.counts.jevCalls).toBeLessThan(0.003)
  })

  it('never picks a posting behind an account or login wall, and spends no Jev call on it', async () => {
    const plan = await planSelection(input({ routeOf: () => 'walled', wanted: 10 }), { decide: fakeJev() })
    expect(plan.picks).toEqual([])
    expect(plan.counts.walled).toBe(plan.counts.relevant)
    expect(plan.counts.walled).toBeGreaterThan(0)
    expect(plan.counts.jevCalls).toBe(0)
  })

  it('sends the Data posting to the Data profile', async () => {
    const plan = await planSelection(input({ wanted: 10 }), { decide: fakeJev() })
    const wayne = [...plan.picks, ...plan.reserves].find((pick) => pick.job.company === 'Wayne')
    expect(wayne?.profileId).toBe(FIXTURE_PROFILES[1].id)
  })

  it('bounds the shortlist to 3× what is wanted', async () => {
    const board = Array.from({ length: 40 }, (_, index) => job({ company: `Co ${index}`, ats_job_id: `co${index}:1` }))
    const plan = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, wanted: 2 }), { decide: fakeJev() })
    expect(plan.counts.shortlisted).toBe(6)
    expect(plan.counts.jevCalls).toBe(6)
    expect(plan.picks).toHaveLength(2)
    expect(plan.reserves).toHaveLength(4)
  })

  it('keeps unknown eligibility for review, never hands-free', async () => {
    const board = [job({ company: 'Soylent', location: 'Remote', description: 'We build payroll software in Go on Postgres.' })]
    const uncertainJev = fakeJev() // answers 0.5 for a posting that never says "anywhere"
    const review = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, mode: 'review_first' }), { decide: uncertainJev })
    expect(review.picks.map((pick) => pick.eligibility)).toEqual(['unknown'])
    expect(review.picks[0].reason).toContain('check before approving')

    const handsFree = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, mode: 'hands_free' }), { decide: uncertainJev })
    expect(handsFree.picks).toHaveLength(0)
    expect(handsFree.skips[0]).toMatchObject({ code: 'eligibility_unknown' })
    expect(handsFree.eligibilityLearned).toEqual([expect.objectContaining({ country: 'ID', verdict: 'unknown' })])
  })

  it('uses the cached eligibility answer instead of asking again', async () => {
    const board = [job({ company: 'Soylent', location: 'Remote', description: 'Payroll software in Go.' })]
    const spy = vi.fn(fakeJev())
    const plan = await planSelection(
      input({ jobs: board, history: EMPTY_HISTORY, mode: 'hands_free', eligibilityCache: new Map([[board[0].id, { verdict: 'eligible', probability: 0.95 }]]) }),
      { decide: spy as unknown as typeof decide },
    )
    expect(plan.picks).toHaveLength(1)
    expect(Object.keys(spy.mock.calls[0][1] as object)).not.toContain('eligible')
  })

  it('skips agent-only postings once the compute budget is spent, and keeps the covered ones', async () => {
    const board = [
      job({ company: 'Stark', ats: '', ats_job_id: '', description: 'Anywhere in the world. Go, Postgres.' }),
      job({ company: 'Northwind', ats_job_id: 'nw:1' }),
    ]
    const plan = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, budget: { ...BUDGET, spentUsd: 3.9 } }), { decide: fakeJev() })
    expect(plan.picks.map((pick) => pick.job.company)).toEqual(['Northwind'])
    expect(plan.skips).toEqual([expect.objectContaining({ code: 'budget', job: expect.objectContaining({ company: 'Stark' }) })])
  })

  it('plans at most as many agent postings as the budget left covers', async () => {
    const board = Array.from({ length: 4 }, (_, index) => job({ company: `Agent ${index}`, ats: '', ats_job_id: '' }))
    const plan = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, wanted: 4, budget: { ...BUDGET, spentUsd: 3.5 } }), { decide: fakeJev() })
    expect(plan.picks).toHaveLength(2)
    expect(plan.skips.filter((skip) => skip.code === 'budget')).toHaveLength(2)
  })

  it('never puts more than the company cap into one plan', async () => {
    // Four different openings (same title would be one opening listed four times).
    const teams = ['Payments', 'Search', 'Platform', 'Data']
    const board = teams.map((team, index) => job({ company: 'Northwind', role: `Backend Engineer, ${team}`, ats_job_id: `nw:${index}` }))
    const plan = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, wanted: 4, caps: { perCompany30d: 2 } }), { decide: fakeJev() })
    expect(plan.picks).toHaveLength(2)
    expect(plan.skips.every((skip) => skip.code === 'company_cap')).toBe(true)
  })

  it('reuses a recent score under the same signature, and a sticky skip costs nothing', async () => {
    const board = [job({ company: 'Northwind', ats_job_id: 'nw:1' }), job({ company: 'Globex', ats_job_id: 'gx:1' })]
    const now = new Date()
    const prior = new Map<string, PriorDecision>([
      [board[0].id, { decision: 'reserve', reasonCode: null, matchScore: 0.9, confidence: 0.9, factors: { title: 1 }, profileId: FIXTURE_PROFILES[0].id, reason: 'title 1.00', signature: 'sig-1', decidedAt: now.toISOString() }],
      [board[1].id, { decision: 'skipped', reasonCode: 'below_match', matchScore: 0.3, confidence: 0.9, factors: {}, profileId: FIXTURE_PROFILES[0].id, reason: '', signature: 'sig-1', decidedAt: now.toISOString() }],
    ])
    const spy = vi.fn(fakeJev())
    const plan = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, prior }), { decide: spy as unknown as typeof decide })
    expect(spy).not.toHaveBeenCalled()
    expect(plan.counts.reusedMatches).toBe(1)
    expect(plan.picks.map((pick) => pick.job.company)).toEqual(['Northwind'])
    expect(plan.usage.costUsd).toBe(0)

    // New targeting: judged afresh.
    const fresh = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, prior, signature: 'sig-2' }), { decide: spy as unknown as typeof decide })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(fresh.counts.reusedMatches).toBe(0)
  })

  it('never re-picks a posting the user dismissed or one already scheduled', async () => {
    const board = [job({ company: 'Northwind', ats_job_id: 'nw:1' }), job({ company: 'Globex', ats_job_id: 'gx:1' })]
    const prior = new Map<string, PriorDecision>([
      [board[0].id, { decision: 'dismissed', reasonCode: null, matchScore: 0.9, confidence: 0.9, factors: {}, profileId: null, reason: '', signature: 'sig-1', decidedAt: new Date().toISOString() }],
      [board[1].id, { decision: 'scheduled', reasonCode: null, matchScore: 0.9, confidence: 0.9, factors: {}, profileId: null, reason: '', signature: 'sig-1', decidedAt: new Date().toISOString() }],
    ])
    const plan = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, prior }), { decide: fakeJev() })
    expect(plan.picks).toHaveLength(0)
  })

  it('picks nothing, and says so, when Jev is not configured', async () => {
    const notConfigured = (async () => ({ ok: false, reason: 'not_configured', message: 'TYPESAFE_API_KEY is not set' })) as unknown as typeof decide
    const plan = await planSelection(input(), { decide: notConfigured })
    expect(plan.picks).toHaveLength(0)
    expect(plan.notes.join(' ')).toMatch(/not configured/)
    expect(plan.skips.some((skip) => skip.code === 'scoring_failed')).toBe(true)
  })

  it('skips a posting Jev failed on and still picks others', async () => {
    const plan = await planSelection(input(), { decide: fakeJev({ failFor: (text) => text.includes('Northwind') }) })
    expect(plan.skips.find((skip) => skip.job.company === 'Northwind')?.code).toBe('scoring_failed')
    expect(plan.picks.length).toBeGreaterThan(0)
  })

  it('stops asking Jev once the per-run spend is reached', async () => {
    const board = Array.from({ length: 10 }, (_, index) => job({ company: `Co ${index}`, ats_job_id: `co${index}:1` }))
    const plan = await planSelection(input({ jobs: board, history: EMPTY_HISTORY, wanted: 3, limits: { maxJevUsd: 0.0000001, concurrency: 1 } }), { decide: fakeJev() })
    expect(plan.counts.jevCalls).toBe(1)
    expect(plan.skips.filter((skip) => skip.code === 'budget').length).toBeGreaterThan(0)
  })
})

describe('selectionSignature', () => {
  it('changes with targeting and with eligibility facts, not with order', () => {
    const base = selectionSignature(FIXTURE_PROFILES, JAKARTA_DEV)
    expect(selectionSignature([...FIXTURE_PROFILES].reverse(), JAKARTA_DEV)).toBe(base)
    expect(selectionSignature([profile(FIXTURE_PROFILES[0].id, { targetTitles: ['SRE'] })], JAKARTA_DEV)).not.toBe(base)
    expect(selectionSignature(FIXTURE_PROFILES, { ...JAKARTA_DEV, country: 'SG' })).not.toBe(base)
  })
})


describe('repeat listings of one opening', () => {
  const copies = () => [
    job({ id: 'dup-1', company: 'Marriott', role: 'FLEX Senior Full Stack Software Engineer', location: 'Remote' }),
    job({ id: 'dup-2', company: 'Marriott', role: 'FLEX Senior Full Stack Software Engineer', location: 'Anywhere' }),
    job({ id: 'dup-3', company: 'marriott ', role: 'FLEX Senior Full-Stack Software Engineer!', location: 'Remote' }),
  ]

  it('plans one of them, and says it skipped the others', async () => {
    const jobs = copies()
    const plan = await planSelection(input({ jobs, history: fixtureHistory(jobs), wanted: 5 }), { decide: fakeJev() })
    const marriott = [...plan.picks, ...plan.reserves].filter((entry) => entry.job.company.trim().toLowerCase() === 'marriott')
    expect(marriott.length).toBeLessThanOrEqual(1)
    expect(plan.notes.join(' ')).toMatch(/repeat listing/)
  })

  it('treats another copy of a role it already applied to as already applied', async () => {
    const jobs = copies()
    const history = { ...fixtureHistory(jobs), attemptedKeys: new Set(['marriott|flex senior full stack software engineer']) }
    const plan = await planSelection(input({ jobs, history, wanted: 5 }), { decide: fakeJev() })
    expect(plan.counts.alreadyApplied).toBeGreaterThanOrEqual(2)
    expect([...plan.picks, ...plan.reserves].some((entry) => entry.job.company.trim().toLowerCase() === 'marriott')).toBe(false)
  })
})

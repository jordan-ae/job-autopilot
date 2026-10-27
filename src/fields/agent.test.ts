import { describe, expect, it, vi } from 'vitest'
import type { DecideResult, JevQuestion } from '../ai/decide.js'
import type { ApplicationProfile, ApplyQuestion, ResumeFacts } from '../types.js'
import { agentFill, cacheId, type AgentContext, type AgentDeps, type CachedClassification, type ClassificationCache } from './agent.js'
import { checkDraft } from './draft.js'

const PROFILE: ApplicationProfile = {
  client_key: 'u',
  full_name: 'Budi Santoso',
  email: 'budi@example.com',
  phone: '+62 812 3456 7890',
  location: 'Jakarta, Indonesia',
  linkedin_url: '',
  portfolio_url: '',
  github_url: '',
  work_authorization: '',
  requires_sponsorship: null,
  notice_period_days: null,
  desired_salary: null,
  desired_salary_currency: 'USD',
  earliest_start_date: null,
  custom_answers: {},
  eeo: {},
  country: 'ID',
}

const RESUME: ResumeFacts = {
  summary: 'Backend engineer, 6 years in Go and PostgreSQL.',
  skills: 'Go, PostgreSQL, SQL, Kubernetes',
  languages: [],
  experience: [{ company: 'Tokopedia', jobTitle: 'Senior Backend Engineer', startDate: '2020-01', endDate: 'Present', bullets: ['Cut p99 latency by 40%'] }],
  education: [],
}

const ctx: AgentContext = { profile: PROFILE, company: 'Acme', resume: RESUME, ats: 'greenhouse', jobTitle: 'Backend Engineer', job: { id: 'job-1', location: 'Remote' } }

function memoryCache(seed: Record<string, CachedClassification> = {}): ClassificationCache & { rows: unknown[] } {
  const store = new Map(Object.entries(seed))
  const rows: unknown[] = []
  return {
    rows,
    async get(keys) {
      return new Map(keys.map(cacheId).filter((id) => store.has(id)).map((id) => [id, store.get(id)!]))
    },
    async put(newRows) {
      rows.push(...newRows)
    },
  }
}

type Responder = (state: unknown, questions: Record<string, JevQuestion>) => Record<string, unknown>

/** A Jev stand-in that answers each question with what `respond` says. */
function fakeDecide(respond: Responder) {
  return vi.fn(async (state: unknown, questions: Record<string, JevQuestion>) => ({
    ok: true,
    answers: respond(state, questions),
    usage: { inputTokens: 100, outputTokens: 1, costUsd: 0.000042, latencyMs: 80, model: 'jev-1.13.0' },
  })) as unknown as AgentDeps['decide'] & ReturnType<typeof vi.fn>
}

function deps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    decide: fakeDecide(() => ({})),
    draft: vi.fn(async () => ({ rejected: 'not_configured' as const })),
    cache: memoryCache(),
    jevEnabled: true,
    draftEnabled: true,
    ...over,
  }
}

const q = (over: Partial<ApplyQuestion> & { id: string; label: string }): ApplyQuestion => ({ type: 'text', required: true, ...over })

describe('agentFill', () => {
  it('does nothing at all without Jev', async () => {
    const decide = fakeDecide(() => ({}))
    const outcome = await agentFill([q({ id: 'a', label: 'Something odd', type: 'select', options: ['A', 'B'] })], ctx, deps({ decide, jevEnabled: false }))
    expect(decide).not.toHaveBeenCalled()
    expect(outcome.notes).toEqual(['jev_not_configured'])
    expect(outcome.questions[0].answer).toBeUndefined()
  })

  it('maps an unknown label through the cache before asking the model', async () => {
    const question = q({ id: 'question_9', label: 'Current employer (as of today)' })
    const cache = memoryCache({
      [cacheId({ ats: 'greenhouse', nativeKey: 'question_9', fingerprint: 'current employer as of today' })]: { canonicalKey: 'current_employer', confidence: 0.97 },
    })
    const decide = fakeDecide(() => ({}))
    const outcome = await agentFill([question], ctx, deps({ cache, decide }))
    expect(decide).not.toHaveBeenCalled()
    expect(outcome.mappings).toEqual([{ questionId: 'question_9', fieldKey: 'current_employer', via: 'cache', confidence: 0.97 }])
    expect(outcome.questions[0].answer).toBe('Tokopedia')
  })

  it('maps with Jev, caches the result for everyone, and ignores an unsure answer', async () => {
    const sure = q({ id: 'k1', label: 'Employer at present' })
    const unsure = q({ id: 'k2', label: 'Tell us your vibe' })
    const cache = memoryCache()
    const decide = fakeDecide((_state, questions) =>
      Object.fromEntries(
        Object.keys(questions).map((id, index) => [id, index === 0 ? { type: 'choice', choice: 'current_employer', confidence: 0.95, probabilities: {} } : { type: 'choice', choice: 'why_role', confidence: 0.4, probabilities: {} }]),
      ),
    )
    const outcome = await agentFill([sure, unsure], ctx, deps({ cache, decide }))
    expect(outcome.questions[0].answer).toBe('Tokopedia')
    expect(outcome.mappings.map((m) => m.fieldKey)).toEqual(['current_employer'])
    // Both are cached — the unsure one as "no field", so it is not asked again.
    expect(cache.rows).toEqual([
      expect.objectContaining({ nativeKey: 'k1', canonicalKey: 'current_employer' }),
      expect.objectContaining({ nativeKey: 'k2', canonicalKey: null }),
    ])
  })

  it('picks the option that says what we hold', async () => {
    const question = q({ id: 'c', label: 'Which country do you intend to work from?', type: 'select', options: ['ID — Indonesia', 'SG — Singapore'] })
    const decide = fakeDecide(() => ({ q0: { type: 'choice', choice: 'o0', confidence: 0.98, probabilities: {} } }))
    const outcome = await agentFill([question], ctx, deps({ decide }))
    expect(outcome.questions[0].answer).toBe('ID — Indonesia')
    // Our own value matched to its option: not a new claim, nothing to review.
    expect(outcome.answers).toEqual([])
  })

  it('never decides the value of a factual question — with nothing stored, it is asked', async () => {
    const questions = [
      q({ id: 's', label: 'Do you have advanced proficiency in SQL?', type: 'select', options: ['Yes', 'No'] }),
      q({ id: 'm', label: 'Have you directly managed a team before?', type: 'boolean' }),
      q({ id: 'y', label: 'How many years of hospital/physician collections experience do you have?', type: 'text' }),
    ]
    const decide = fakeDecide((_s, qs) =>
      Object.fromEntries(Object.keys(qs).map((id) => [id, { type: 'choice', choice: 'o0', confidence: 1, probabilities: {} }])),
    )
    const draft = vi.fn(async () => ({ answer: 'made up', usage: { promptTokens: 1, completionTokens: 1 } }))
    const outcome = await agentFill(questions, ctx, deps({ decide, draft }))
    expect(outcome.questions.map((question) => question.answer)).toEqual([undefined, undefined, undefined])
    expect(outcome.answers).toEqual([])
    expect(decide).not.toHaveBeenCalled()
    expect(draft).not.toHaveBeenCalled()
  })

  it('fills a factual question from the stored value, with Jev only matching the option', async () => {
    const stored: AgentContext = {
      ...ctx,
      profile: {
        ...PROFILE,
        custom_answers: { 'field:referral_source': 'LinkedIn' },
        answer_meta: { 'field:referral_source': { source: 'user', fieldKey: 'referral_source' } },
      },
    }
    const question = q({ id: 'r', label: 'How did you hear about this opportunity?', type: 'select', options: ['A LinkedIn post or ad', 'A friend'] })
    const decide = fakeDecide(() => ({ q0: { type: 'choice', choice: 'o0', confidence: 0.97, probabilities: {} } }))
    const outcome = await agentFill([question], stored, deps({ decide }))
    expect(outcome.questions[0].answer).toBe('A LinkedIn post or ad')
    // The state Jev saw carries the stored answer: it matched, it did not decide.
    expect(JSON.stringify((decide as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('LinkedIn')
    expect(outcome.answers).toEqual([])
  })

  it('never answers work authorization, identity, EEO or consent by inference', async () => {
    const questions = [
      q({ id: 'w', label: 'Are you authorized to work in Canada?', type: 'boolean' }),
      q({ id: 'g', label: 'Gender', type: 'select', options: ['Male', 'Female'], kind: 'eeo' }),
      q({ id: 'p', label: 'I agree to the privacy policy', type: 'boolean', kind: 'consent' }),
      q({ id: 'z', label: 'Postal Code', type: 'text' }),
    ]
    const decide = fakeDecide((_s, qs) => Object.fromEntries(Object.keys(qs).map((id) => [id, { type: 'choice', choice: 'o0', confidence: 1, probabilities: {} }])))
    const outcome = await agentFill(questions, ctx, deps({ decide }))
    expect(outcome.questions.map((question) => question.answer)).toEqual([undefined, undefined, undefined, undefined])
    expect(decide).not.toHaveBeenCalled()
  })

  it('drafts a written answer only when the gate says it needs one, and scopes it to the employer', async () => {
    const essay = q({ id: 'why', label: 'Why are you interested in joining Acme?', type: 'textarea' })
    const short = q({ id: 'n', label: 'Something we could not place', type: 'text' })
    const decide = fakeDecide((_state, questions) => {
      const first = Object.values(questions)[0]
      if (first.type === 'choice') return Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'choice', choice: 'none', confidence: 0.99, probabilities: {} }]))
      return { q0: { type: 'noul', noul: 0.95 }, q1: { type: 'noul', noul: 0.1 } }
    })
    const draft = vi.fn(async () => ({ answer: 'I build payment backends in Go at Tokopedia.', usage: { promptTokens: 1000, completionTokens: 100 } }))
    const outcome = await agentFill([essay, short], ctx, deps({ decide, draft }))
    expect(draft).toHaveBeenCalledTimes(1)
    expect(outcome.questions.map((question) => question.answer)).toEqual(['I build payment backends in Go at Tokopedia.', undefined])
    expect(outcome.answers).toEqual([expect.objectContaining({ questionId: 'why', via: 'draft', fieldKey: 'why_company', jobScoped: true })])
    expect(outcome.draftCostUsd).toBeGreaterThan(0)
  })

  it('carries on, asking, when Jev fails', async () => {
    const decide = vi.fn(async () => ({ ok: false, reason: 'timeout', message: 'slow' }) as DecideResult<Record<string, JevQuestion>>) as unknown as AgentDeps['decide']
    const outcome = await agentFill([q({ id: 'x', label: 'What excites you about this role?', type: 'textarea' })], ctx, deps({ decide }))
    expect(outcome.questions[0].answer).toBeUndefined()
    expect(outcome.notes).toContain('gate:timeout')
  })
})

describe('the draft guard', () => {
  const args = { material: 'Senior engineer at Tokopedia since 2020. Cut p99 latency by 40%.', company: 'Acme', jobTitle: 'Backend Engineer' }

  it('accepts a draft whose figures come from the material', () => {
    expect(checkDraft({ grounded: true, answer: 'At Tokopedia I cut p99 latency by 40%.' }, args)).toMatchObject({ answer: 'At Tokopedia I cut p99 latency by 40%.' })
  })

  it('rejects an invented number, an ungrounded draft, and an empty one', () => {
    expect(checkDraft({ grounded: true, answer: 'I led a team of 12 engineers.' }, args)).toMatchObject({ rejected: 'new_numbers' })
    expect(checkDraft({ grounded: false, answer: 'Something' }, args)).toMatchObject({ rejected: 'ungrounded' })
    expect(checkDraft({ grounded: true, answer: '  ' }, args)).toMatchObject({ rejected: 'empty' })
  })

  it('trims to the box at a word boundary', () => {
    const out = checkDraft({ grounded: true, answer: 'I work at Tokopedia on payments and search.' }, { ...args, maxLength: 20 })
    expect(out).toMatchObject({ answer: 'I work at Tokopedia' })
  })
})

describe('questions whose options are not a list', () => {
  it('does not take the pass down (Recruitee once sent {"length":120})', async () => {
    const odd = { id: 'open_question:1', label: 'Why are you interested in working at Acme?', type: 'text', required: true, options: { length: 120 } } as unknown as ApplyQuestion
    const outcome = await agentFill([odd], ctx, deps({ decide: fakeDecide(() => ({ q0: { type: 'noul', noul: 0.1 } })) }))
    expect(outcome.notes.some((note) => note.startsWith('failed:'))).toBe(false)
  })
})


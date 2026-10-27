import type { decide, JevQuestion } from '../ai/decide.js'
import type { WorkAuthorization } from '../types.js'
import type { ProfileTargeting } from '../types.js'
import { EMPTY_HISTORY, type History, type PoolJob, type TargetProfile } from './candidates.js'
import type { Applicant } from './eligibility.js'
import { plainText } from './eligibility.js'
import { DEFAULT_SETTINGS, type AutopilotSettings } from '../settings.js'

/**
 * A small, realistic world for selection without a database or a network: a
 * backend developer in Jakarta with two resume profiles, a board of postings
 * shaped like the real ones (Greenhouse, Ashby, Lever, Workable, agent-only),
 * and a stand-in for Jev that answers from keyword overlap.
 *
 * Used by the tests.
 */

export function targeting(over: Partial<ProfileTargeting> = {}): ProfileTargeting {
  return {
    targetTitles: ['Backend Engineer'],
    mustHaveSkills: ['Go', 'Postgres'],
    niceToHaveSkills: ['Kubernetes'],
    seniority: 'senior',
    remotePreference: 'remote',
    locations: [],
    salaryFloor: null,
    salaryFloorCurrency: 'USD',
    excludedCompanies: [],
    excludedKeywords: [],
    ...over,
  }
}

export function profile(id: string, over: Partial<ProfileTargeting> = {}, name = id): TargetProfile {
  return { id, name, targeting: targeting(over) }
}

let seq = 0
const daysAgo = (days: number, from = Date.now()) => new Date(from - days * 86_400_000).toISOString()

export function job(over: Partial<PoolJob> = {}): PoolJob {
  seq++
  return {
    id: over.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    company: 'Acme',
    role: 'Senior Backend Engineer',
    location: 'Remote (Worldwide)',
    employment_type: 'Full-time',
    is_remote: true,
    salary_min: null,
    salary_max: null,
    salary_currency: 'USD',
    tags: ['go', 'postgres'],
    short_description: 'Build our Go services on Postgres.',
    posted_at: daysAgo(2),
    ats: 'greenhouse',
    ats_job_id: 'acme:1',
    apply_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
    quality_tier: 1,
    description: 'We are a remote-first company and hire from anywhere in the world. You will build Go services on Postgres.',
    ...over,
  }
}

export const auth = (region: string, authorized: boolean | null, needs_sponsorship: boolean | null = null): WorkAuthorization => ({
  region,
  authorized,
  needs_sponsorship,
  open_to_contractor_eor: null,
})

export const JAKARTA_DEV: Applicant = { country: 'ID', citizenship: ['ID'], workAuthorizations: [auth('ID', true, false)] }

export const FIXTURE_SETTINGS: AutopilotSettings = { ...DEFAULT_SETTINGS, enabled: true, timezone: 'Asia/Jakarta', minMatch: 0.6 }

export const FIXTURE_PROFILES: TargetProfile[] = [
  profile('11111111-1111-4111-8111-111111111111', {}, 'Backend (Go)'),
  profile(
    '22222222-2222-4222-8222-222222222222',
    { targetTitles: ['Data Engineer'], mustHaveSkills: ['Python', 'SQL'], niceToHaveSkills: ['Airflow'], seniority: 'mid' },
    'Data',
  ),
]

/** A board shaped like the live one, each posting chosen to exercise a rule. */
export function fixtureBoard(): PoolJob[] {
  return [
    job({ company: 'Northwind', role: 'Senior Backend Engineer (Go)', ats: 'greenhouse', ats_job_id: 'northwind:1' }),
    job({ company: 'Globex', role: 'Backend Engineer', ats: 'ashby', ats_job_id: 'globex:2', apply_url: 'https://jobs.ashbyhq.com/globex/2', location: 'Remote - APAC' }),
    job({ company: 'Initech', role: 'Senior Backend Engineer', ats: 'lever', ats_job_id: 'initech:3', apply_url: 'https://jobs.lever.co/initech/3', location: 'Remote', description: 'Fully distributed. We hire from anywhere in the world. Go, gRPC, Postgres.' }),
    job({ company: 'Hooli', role: 'Senior Backend Engineer', location: 'Remote - US', description: 'You must be authorized to work in the United States.' }),
    job({ company: 'Umbrella', role: 'Backend Engineer', location: 'Remote, EMEA', description: 'Go and Postgres.' }),
    job({ company: 'Soylent', role: 'Senior Backend Engineer', location: 'Remote', description: 'We build payroll software in Go. You will own our Postgres schema.' }),
    job({ company: 'Vandelay', role: 'Backend Engineer', location: 'Remote (Worldwide)', description: 'Go, Postgres. Must work within US Eastern time zone business hours.' }),
    job({ company: 'Stark', role: 'Senior Backend Engineer', ats: '', ats_job_id: '', apply_url: 'https://stark.example/careers/9', description: 'Remote, anywhere in the world. Go and Postgres at scale.' }),
    job({ company: 'Wayne', role: 'Data Engineer', tags: ['python', 'sql', 'airflow'], short_description: 'Python and SQL pipelines on Airflow.', description: 'Hire from anywhere in the world. Python, SQL, Airflow.', ats: 'ashby', ats_job_id: 'wayne:7' }),
    job({ company: 'Cyberdyne', role: 'Backend Engineer, Payments', tags: ['java'], short_description: 'Java and Spring.', description: 'Work from anywhere in the world. Java, Spring, Oracle.' }),
    job({ company: 'OpenAI', role: 'Senior Backend Engineer', ats: 'ashby', ats_job_id: 'openai:1', description: 'Remote, anywhere in the world. Go, Postgres.' }),
    job({ company: 'Acme', role: 'Account Executive', tags: [], short_description: 'Sell our software.' }),
    job({ company: 'Massive Dynamic', role: 'Senior Backend Engineer', location: 'San Francisco, CA', is_remote: false, description: 'On-site in our SF office.' }),
  ]
}

export function fixtureHistory(board: PoolJob[], now = Date.now()): History {
  return {
    ...EMPTY_HISTORY,
    // Five OpenAI applications this half-year: its published limit.
    companyApplications: [10, 40, 70, 100, 150].map((days) => ({ company: 'OpenAI', at: daysAgo(days, now) })),
    hiddenJobIds: new Set(board.filter((entry) => entry.company === 'Cyberdyne').map((entry) => entry.id)),
  }
}

const words = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9+#]+/).filter((word) => word.length > 1))

/**
 * Jev, imitated: scores from word overlap between the posting and each
 * profile, the eligibility noul from whether the text says "anywhere".
 * Charges like the real thing (~$0.42 per million input tokens, ~4 chars a
 * token) so the cost a run prints is the right order of magnitude.
 */
export function fakeJev(options: { failFor?: (state: string) => boolean } = {}): typeof decide {
  const fn = async (state: unknown, questions: Record<string, JevQuestion>, opts: { onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; model: string }) => void } = {}) => {
    const text = JSON.stringify({ state, questions })
    const inputTokens = Math.ceil(text.length / 4)
    const usage = { inputTokens, outputTokens: 0, costUsd: (inputTokens * 0.42) / 1_000_000, latencyMs: 120, model: 'fake-jev' }
    opts.onUsage?.(usage)
    if (options.failFor?.(text)) return { ok: false as const, reason: 'timeout' as const, message: 'no answer', usage }

    const s = state as { job: { title: string; description: string; tags: string[]; level_from_title: string }; profiles: Record<string, { target_titles: string[]; must_have_skills: string[]; seniority: string }>; eligibility_text?: string }
    const jobWords = words(`${s.job.title} ${plainText(s.job.description)} ${s.job.tags.join(' ')}`)
    const titleWords = words(s.job.title)
    const answers: Record<string, unknown> = {}
    for (const [id, question] of Object.entries(questions)) {
      const [factor, key] = id.split('_')
      const p = s.profiles?.[key]
      if (id === 'eligible') {
        const anywhere = /anywhere|worldwide/i.test(`${s.eligibility_text ?? ''} ${plainText(s.job.description)}`)
        answers[id] = { type: 'noul', noul: anywhere ? 0.93 : 0.5 }
        continue
      }
      if (!p) continue
      const titleHit = Math.max(0, ...p.target_titles.map((title) => [...words(title)].filter((w) => titleWords.has(w)).length / Math.max(1, words(title).size)))
      const skillHit = p.must_have_skills.length ? p.must_have_skills.filter((skill) => jobWords.has(skill.toLowerCase())).length / p.must_have_skills.length : 0.5
      const levels = question.type === 'score' ? question.criteria.length : 2
      const level = (fraction: number) => Math.round(Math.max(0, Math.min(1, fraction)) * (levels - 1))
      if (factor === 'title') answers[id] = { type: 'score', score: level(titleHit), confidence: 0.85, probabilities: { [String(level(titleHit))]: 0.85 } }
      else if (factor === 'skills') answers[id] = { type: 'score', score: level(skillHit), confidence: 0.8, probabilities: { [String(level(skillHit))]: 0.8 } }
      else if (factor === 'seniority') {
        const rank = ['junior', 'mid', 'senior', 'lead']
        const gap = Math.abs(rank.indexOf(s.job.level_from_title) - rank.indexOf(p.seniority === 'principal' ? 'lead' : p.seniority))
        answers[id] = { type: 'score', score: Math.max(0, 2 - gap), confidence: 0.9, probabilities: { [String(Math.max(0, 2 - gap))]: 0.9 } }
      } else if (factor === 'same') answers[id] = { type: 'noul', noul: titleHit >= 0.5 ? 0.9 : 0.1 }
    }
    return { ok: true as const, answers, usage }
  }
  return fn as unknown as typeof decide
}

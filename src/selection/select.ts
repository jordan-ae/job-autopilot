import type { Applicant } from '../applicant.js'
import type { decide } from '../ai/decide.js'
import { env } from '../config.js'
import { monthlyComputeSpend } from '../executor/deps.js'
import { countryFromLocation } from '../fields/countries.js'
import { agentStartFrom } from '../navigator/start.js'
import { postingRef } from '../posting.js'
import { effectiveMode } from '../settings.js'
import type { Store } from '../store/types.js'
import { trackedKey, type History, type PoolJob, type Route, type TargetProfile } from './candidates.js'
import type { Applicant as EligibilityFacts } from './eligibility.js'
import { planSelection, selectionSignature, type Plan } from './plan.js'

/**
 * Selection wired to a Store: which of a list of postings Autopilot would
 * apply to next, for this applicant, and why it passed over the rest. The
 * planner itself (plan.ts) is pure; this gathers its inputs.
 */

/** What one browser-agent application is expected to cost, for the budget. */
export const AGENT_ESTIMATE_USD = 0.25

/** How a posting would be carried. There is no ATS API route in this package. */
export function routeOf(job: Pick<PoolJob, 'ats' | 'ats_job_id' | 'apply_url' | 'description'>): Route {
  if (postingRef(job)) return 'fill'
  return agentStartFrom(job.apply_url ?? '', job.description ?? '').kind === 'walled' ? 'walled' : 'agent'
}

/** Country of residence (stated, else read from the location), citizenship, per-country authorization. */
export function eligibilityFacts(applicant: Applicant): EligibilityFacts {
  const stated = (applicant.profile.country ?? '').trim().toUpperCase()
  return {
    country: /^[A-Z]{2}$/.test(stated) ? stated : countryFromLocation(applicant.profile.location),
    citizenship: applicant.profile.citizenship ?? [],
    workAuthorizations: applicant.profile.work_authorizations ?? [],
  }
}

/** A posting from a jobs file, with blanks where it says nothing. */
export function poolJob(raw: Partial<PoolJob> & { apply_url: string }, index = 0): PoolJob {
  const ref = postingRef({ ats: raw.ats ?? '', ats_job_id: raw.ats_job_id ?? '', apply_url: raw.apply_url })
  return {
    id: raw.id ?? `job-${index + 1}`,
    company: raw.company ?? '',
    role: raw.role ?? '',
    location: raw.location ?? '',
    employment_type: raw.employment_type ?? '',
    is_remote: raw.is_remote ?? /\bremote\b/i.test(raw.location ?? ''),
    salary_min: raw.salary_min ?? null,
    salary_max: raw.salary_max ?? null,
    salary_currency: raw.salary_currency ?? null,
    tags: raw.tags ?? null,
    short_description: raw.short_description ?? (raw.description ?? '').slice(0, 400),
    description: raw.description ?? null,
    posted_at: raw.posted_at ?? new Date().toISOString(),
    apply_url: raw.apply_url,
    ats: ref?.ats ?? raw.ats ?? '',
    ats_job_id: ref ? `${ref.board}:${ref.jobId}` : (raw.ats_job_id ?? ''),
    found_on: raw.found_on ?? null,
  }
}

export async function selectJobs(input: {
  store: Store
  applicant: Applicant
  jobs: PoolJob[]
  /** How many to pick. Default: the applicant's daily target. */
  wanted?: number
  now?: Date
  decide?: typeof decide
}): Promise<Plan> {
  const { store, applicant } = input
  const now = input.now ?? new Date()
  const profiles: TargetProfile[] = applicant.targeting.map(({ id, name, ...targeting }) => ({ id, name, targeting }))
  if (profiles.length === 0) throw new Error('the profile has no "targeting": say what to look for first')

  const attempts = await store.listAttempts(applicant.userId)
  const postings = new Map<string, { company: string; role: string }>()
  for (const attempt of attempts) {
    const posting = await store.getPosting(attempt.job_id)
    if (posting) postings.set(attempt.job_id, posting)
  }
  const since = new Date(now.getTime() - 180 * 86_400_000)
  const history: History = {
    attemptedJobIds: new Set(attempts.map((attempt) => attempt.job_id)),
    attemptedKeys: new Set(
      attempts
        .filter((attempt) => attempt.status !== 'failed')
        .map((attempt) => postings.get(attempt.job_id))
        .filter((posting): posting is { company: string; role: string } => Boolean(posting))
        .map((posting) => trackedKey(posting.company, posting.role)),
    ),
    trackedJobIds: new Set(),
    trackedKeys: new Set(),
    hiddenJobIds: new Set(),
    companyApplications: attempts
      .filter((attempt) => attempt.status === 'submitted' && attempt.submitted_at && Date.parse(attempt.submitted_at) >= since.getTime())
      .map((attempt) => ({ company: postings.get(attempt.job_id)?.company ?? '', at: attempt.submitted_at! })),
  }
  const facts = eligibilityFacts(applicant)
  const sent = attempts.filter((attempt) => attempt.status === 'submitted').length
  return planSelection(
    {
      now,
      applicant: facts,
      settings: applicant.settings,
      profiles,
      jobs: input.jobs,
      history,
      wanted: input.wanted ?? applicant.settings.dailyTarget,
      mode: effectiveMode(applicant.settings, sent).mode,
      budget: { budgetUsd: env.autopilotMonthlyBudgetUsd, spentUsd: await monthlyComputeSpend(store, applicant.userId, now), agentEstimateUsd: AGENT_ESTIMATE_USD },
      caps: { perCompany30d: env.autopilotCompanyCap },
      routeOf,
      signature: selectionSignature(profiles, facts),
    },
    input.decide ? { decide: input.decide } : {},
  )
}

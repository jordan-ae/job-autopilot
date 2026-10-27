import { createHash } from 'node:crypto'
import { decide as realDecide, type DecisionUsage, type JevQuestion, type NoulAnswer } from '../ai/decide.js'
import { EMPTY_FEEDBACK, type FeedbackSignals } from './score.js'
import {
  agentAffordable,
  alreadyHandled,
  companyCap,
  companyKey,
  relevance,
  shortlistKey,
  trackedKey,
  type BudgetState,
  type CapConfig,
  type History,
  type PoolJob,
  type Relevance,
  type Route,
  type TargetProfile,
} from './candidates.js'
import {
  checkEligibility,
  eligibilityExcerpt,
  eligibilityQuestion,
  verdictFromJev,
  type Applicant,
  type Verdict,
} from './eligibility.js'
import { acceptMatch, matchQuestions, matchState, readMatch, type Factor, type ProfileMatch } from './match.js'
import type { AutopilotMode, AutopilotSettings } from '../settings.js'

/**
 * Selection, one user, one run: what Autopilot would apply to next, and why
 * it passed over the rest. Pure apart from two injected calls — Jev, and
 * loading descriptions for the shortlist — so the CLI (select.ts) and the
 * tests run exactly this.
 *
 *   1. relevance      digest scoring against each profile's targeting (free)
 *   2. dedupe         applied, tracked, hidden; user exclusions (free)
 *   3. company caps   rolling 30 days, plus limits employers publish (free)
 *   4. eligibility    rules on the location field and description (free)
 *   5. route/budget   agent-carried postings only while the budget lasts
 *   6. Jev            one call per shortlisted posting: the match questions for
 *                     every profile, plus the eligibility noul when the rules
 *                     left it open and nothing is cached
 *   7. pick           eligible first, then by match; unknown eligibility only
 *                     in review-first mode, never hands-free
 *
 * The shortlist is bounded (3× what is wanted, at most 30), which bounds the
 * Jev spend: about $0.001–0.002 a posting.
 */

export type SkipCode =
  | 'ineligible'
  | 'eligibility_unknown'
  | 'company_cap'
  | 'known_cap'
  | 'budget'
  | 'below_match'
  | 'low_confidence'
  | 'scoring_failed'

/** Codes that stand until the profiles change: re-scoring would only cost. */
export const STICKY_SKIPS: ReadonlySet<string> = new Set(['ineligible', 'below_match', 'low_confidence'])

export interface PriorDecision {
  decision: 'picked' | 'reserve' | 'scheduled' | 'skipped' | 'dismissed'
  reasonCode: string | null
  matchScore: number | null
  confidence: number | null
  factors: Partial<Record<Factor, number>> | null
  profileId: string | null
  reason: string | null
  signature: string
  decidedAt: string
}

export interface CachedEligibility {
  verdict: Verdict
  probability: number | null
}

export interface PlanLimits {
  /** Shortlist this many times what is wanted. */
  shortlistFactor: number
  maxShortlist: number
  /** Descriptions are loaded for at most this many of the best relevant postings. */
  describeTop: number
  minConfidence: number
  /** Jev spend allowed in one run, USD. */
  maxJevUsd: number
  /** A cached match older than this is asked again. */
  reuseMatchDays: number
  concurrency: number
}

export const DEFAULT_LIMITS: PlanLimits = {
  shortlistFactor: 3,
  maxShortlist: 30,
  describeTop: 120,
  minConfidence: 0.4,
  maxJevUsd: 0.08,
  reuseMatchDays: 3,
  concurrency: 4,
}

export interface PlanInput {
  now: Date
  applicant: Applicant
  settings: Pick<AutopilotSettings, 'minMatch' | 'remoteOnly' | 'locations' | 'excludedKeywords' | 'excludedCompanies'>
  profiles: TargetProfile[]
  jobs: PoolJob[]
  history: History
  feedback?: FeedbackSignals
  /** How many applications to pick. */
  wanted: number
  /** The mode in force (settings.effectiveMode): unknown eligibility is review-only. */
  mode: AutopilotMode
  budget: BudgetState
  caps: CapConfig
  routeOf: (job: PoolJob) => Route
  /** Earlier decisions on these postings for this user, by job id. */
  prior?: Map<string, PriorDecision>
  /** Jev's earlier eligibility answers for the user's country, by job id. */
  eligibilityCache?: Map<string, CachedEligibility>
  /** Changes whenever the profiles' targeting or the user's eligibility facts do
   * (selectionSignature): an earlier score or skip is reused only under the same one. */
  signature: string
  limits?: Partial<PlanLimits>
}

export interface PlanDeps {
  decide?: typeof realDecide
  /** Full descriptions for these job ids. */
  loadDescriptions?: (ids: string[]) => Promise<Map<string, string>>
}

export interface PlannedJob {
  job: PoolJob
  profileId: string
  matchScore: number
  confidence: number
  factors: Partial<Record<Factor, number>>
  /** Machine-made: factors, profile, eligibility. */
  reason: string
  eligibility: Verdict
  eligibilityReason: string
  route: Route
  localScore: number
  /** Jev spend on this posting in this run. */
  costUsd: number
}

export interface SkippedJob {
  job: Pick<PoolJob, 'id' | 'company' | 'role' | 'location'>
  code: SkipCode
  reason: string
  profileId: string | null
  matchScore: number | null
  confidence: number | null
  factors: Partial<Record<Factor, number>> | null
  costUsd: number
}

export interface EligibilityRecord {
  jobId: string
  country: string
  verdict: Verdict
  probability: number
  model: string
}

export interface PlanCounts {
  pool: number
  relevant: number
  alreadyApplied: number
  tracked: number
  hidden: number
  /** Relevant, but behind an account or login wall: the applicant's to file. */
  walled: number
  eligible: number
  ineligible: number
  unknown: number
  shortlisted: number
  jevCalls: number
  reusedMatches: number
  picked: number
  reserves: number
}

export interface Plan {
  picks: PlannedJob[]
  /** Good enough, not needed today: picked from first when a pick falls through. */
  reserves: PlannedJob[]
  skips: SkippedJob[]
  counts: PlanCounts
  usage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; model: string }
  /** Jev eligibility answers to cache per (job, country). */
  eligibilityLearned: EligibilityRecord[]
  /** Why nothing (or less) was picked, when it isn't a per-posting reason. */
  notes: string[]
}

interface Considered {
  job: PoolJob
  rel: Relevance
  route: Route
  key: number
}

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export async function planSelection(input: PlanInput, deps: PlanDeps = {}): Promise<Plan> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits }
  const decide = deps.decide ?? realDecide
  const prior = input.prior ?? new Map<string, PriorDecision>()
  const eligibilityCache = input.eligibilityCache ?? new Map<string, CachedEligibility>()
  const country = input.applicant.country?.toUpperCase() ?? null
  const counts: PlanCounts = {
    pool: input.jobs.length,
    relevant: 0,
    alreadyApplied: 0,
    tracked: 0,
    hidden: 0,
    walled: 0,
    eligible: 0,
    ineligible: 0,
    unknown: 0,
    shortlisted: 0,
    jevCalls: 0,
    reusedMatches: 0,
    picked: 0,
    reserves: 0,
  }
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, model: '' }
  const skips: SkippedJob[] = []
  const notes: string[] = []
  const eligibilityLearned: EligibilityRecord[] = []
  const plan = (picks: PlannedJob[], reserves: PlannedJob[]): Plan => {
    counts.picked = picks.length
    counts.reserves = reserves.length
    usage.costUsd = round6(usage.costUsd)
    return { picks, reserves, skips, counts, usage, eligibilityLearned, notes }
  }
  const skip = (job: PoolJob, code: SkipCode, reason: string, extra: Partial<SkippedJob> = {}) =>
    skips.push({
      job: { id: job.id, company: job.company, role: job.role, location: job.location },
      code,
      reason,
      profileId: null,
      matchScore: null,
      confidence: null,
      factors: null,
      costUsd: 0,
      ...extra,
    })

  if (input.profiles.length === 0) {
    notes.push('No resume profile has Autopilot turned on.')
    return plan([], [])
  }
  if (input.wanted <= 0) {
    notes.push("Today's target is already met.")
    return plan([], [])
  }

  // 1–2. Relevance and dedupe, everything in memory.
  const considered: Considered[] = []
  for (const job of input.jobs) {
    const handled = alreadyHandled(job, input.history)
    if (handled === 'already_applied') {
      counts.alreadyApplied++
      continue
    }
    if (handled === 'tracked') {
      counts.tracked++
      continue
    }
    if (handled === 'hidden') {
      counts.hidden++
      continue
    }
    const earlier = prior.get(job.id)
    // The user dismissed it from Up next, or it already became an attempt.
    if (earlier && (earlier.decision === 'dismissed' || earlier.decision === 'scheduled')) continue
    const rel = relevance(job, input.profiles, input.settings, input.feedback ?? EMPTY_FEEDBACK)
    if (!rel) continue
    counts.relevant++
    const route = input.routeOf(job)
    if (route === 'walled') {
      counts.walled++
      continue
    }
    considered.push({ job, rel, route, key: shortlistKey(rel.localScore, route, job.quality_tier) })
  }
  considered.sort((a, b) => b.key - a.key)

  // The board lists one opening several times (job boards re-post it, with
  // different ids and sometimes a different location). Applying twice to the
  // same role at the same company is not two applications: keep the best copy.
  const seenRoles = new Set<string>()
  let duplicates = 0
  for (let index = 0; index < considered.length; ) {
    const roleKey = trackedKey(considered[index].job.company, considered[index].job.role)
    if (seenRoles.has(roleKey)) {
      considered.splice(index, 1)
      duplicates++
    } else {
      seenRoles.add(roleKey)
      index++
    }
  }
  if (duplicates > 0) notes.push(`Skipped ${duplicates} repeat listing${duplicates === 1 ? '' : 's'} of a role already considered.`)

  // Descriptions for the top of the list only: eligibility and Jev read them.
  const top = considered.slice(0, limits.describeTop)
  if (deps.loadDescriptions) {
    const missing = top.filter((entry) => entry.job.description == null).map((entry) => entry.job.id)
    if (missing.length > 0) {
      const loaded = await deps.loadDescriptions(missing)
      for (const entry of top) if (entry.job.description == null) entry.job.description = loaded.get(entry.job.id) ?? ''
    }
  }

  // 3–5. Caps, eligibility and budget, walking down until the shortlist is full.
  const shortlistSize = Math.min(limits.maxShortlist, Math.ceil(input.wanted * limits.shortlistFactor))
  const perCompany = new Map<string, number>()
  type Short = Considered & { eligibility: Verdict; eligibilityReason: string; askEligibility: boolean; reuse: PriorDecision | null }
  const shortlist: Short[] = []
  for (const entry of top) {
    if (shortlist.length >= shortlistSize) break
    const { job } = entry
    const earlier = prior.get(job.id)
    const sameBasis = Boolean(earlier && earlier.signature === input.signature)
    if (earlier && sameBasis && earlier.decision === 'skipped' && earlier.reasonCode && STICKY_SKIPS.has(earlier.reasonCode)) {
      // Settled before on the same profiles and the same eligibility facts:
      // don't pay to ask again. A match under the minimum stands only while
      // the minimum does — lowering it brings the posting back, unscored.
      if (earlier.reasonCode === 'ineligible') {
        counts.ineligible++
        continue
      }
      const stored = earlier.matchScore != null ? { profileId: earlier.profileId ?? '', score: earlier.matchScore, confidence: earlier.confidence ?? 0, factors: earlier.factors ?? {} } : null
      if (!stored || !acceptMatch(stored, input.settings.minMatch, limits.minConfidence).ok) continue
    }

    const cap = companyCap(job.company, input.history, perCompany, input.caps, input.now)
    if (cap) {
      skip(job, cap.code, cap.reason)
      continue
    }

    const rules = checkEligibility(job, input.applicant)
    let eligibility: Verdict = rules.verdict
    let eligibilityReason = rules.reasons.join('; ')
    let askEligibility = false
    if (rules.verdict === 'unknown' && rules.needsJev && country) {
      const cached = eligibilityCache.get(job.id)
      if (cached) {
        eligibility = cached.verdict
        eligibilityReason = `${eligibilityReason}; Jev read the posting: ${cached.verdict}${cached.probability != null ? ` (${cached.probability.toFixed(2)})` : ''}`
      } else askEligibility = true
    }
    if (eligibility === 'ineligible') {
      counts.ineligible++
      skip(job, 'ineligible', eligibilityReason)
      continue
    }
    if (eligibility === 'unknown' && !askEligibility && input.mode === 'hands_free') {
      counts.unknown++
      skip(job, 'eligibility_unknown', `${eligibilityReason}; hands-free applies only where you are sure to be eligible`)
      continue
    }

    if (entry.route === 'agent' && !agentAffordable(input.budget, 0)) {
      skip(job, 'budget', "needs the browser agent and this month's compute budget is used up")
      continue
    }

    // A score from a recent run on the same basis is as good as a new one.
    const reuse =
      earlier &&
      sameBasis &&
      earlier.matchScore != null &&
      earlier.profileId &&
      input.now.getTime() - new Date(earlier.decidedAt).getTime() <= limits.reuseMatchDays * 86_400_000
        ? earlier
        : null

    perCompany.set(companyKey(job.company), (perCompany.get(companyKey(job.company)) ?? 0) + 1)
    shortlist.push({ ...entry, eligibility, eligibilityReason, askEligibility, reuse })
  }
  counts.shortlisted = shortlist.length

  // 6. Jev, once per posting that needs it.
  const questionsFor = (entry: Short): Record<string, JevQuestion> => ({
    ...(entry.reuse ? {} : matchQuestions(input.profiles)),
    ...(entry.askEligibility && country ? { eligible: eligibilityQuestion(country) } : {}),
  })
  let stopped: string | null = null
  const scored = await mapLimit(shortlist, limits.concurrency, async (entry) => {
    const questions = questionsFor(entry)
    let match: { best: ProfileMatch | null; reason: string } | null = null
    let costUsd = 0
    if (entry.reuse) {
      counts.reusedMatches++
      const reused = entry.reuse
      match = {
        best: {
          profileId: reused.profileId ?? entry.rel.profileId,
          score: reused.matchScore!,
          confidence: reused.confidence ?? 1,
          factors: reused.factors ?? {},
        },
        reason: (reused.reason ?? '').split('; ')[0],
      }
    }
    if (Object.keys(questions).length === 0) return { entry, match, costUsd, failed: null as string | null }
    if (stopped) return { entry, match: null, costUsd, failed: stopped }
    if (input.budget.spentUsd + usage.costUsd >= input.budget.budgetUsd || usage.costUsd >= limits.maxJevUsd) {
      return { entry, match: null, costUsd, failed: 'budget' }
    }

    const state = {
      ...matchState(entry.job, input.profiles),
      ...(entry.askEligibility ? { eligibility_text: eligibilityExcerpt(entry.job, checkEligibility(entry.job, input.applicant).restrictions) } : {}),
    }
    const result = await decide(state, questions, {
      onUsage: (u: DecisionUsage) => {
        usage.calls += 1
        usage.inputTokens += u.inputTokens
        usage.outputTokens += u.outputTokens
        usage.costUsd += u.costUsd
        usage.model = u.model
        costUsd += u.costUsd
      },
    })
    counts.jevCalls++
    if (!result.ok) {
      if (result.reason === 'not_configured') stopped = 'not_configured'
      return { entry, match: null, costUsd, failed: `${result.reason}: ${result.message}` }
    }
    const answers = result.answers as Record<string, unknown>
    if (entry.askEligibility && country) {
      const answer = answers.eligible as NoulAnswer
      entry.eligibility = verdictFromJev(answer.noul)
      entry.eligibilityReason = `${entry.eligibilityReason}; Jev read the posting: ${entry.eligibility} (${answer.noul.toFixed(2)})`
      eligibilityLearned.push({ jobId: entry.job.id, country, verdict: entry.eligibility, probability: answer.noul, model: result.usage.model })
    }
    if (!entry.reuse) match = readMatch(input.profiles, questions, answers)
    return { entry, match, costUsd, failed: null as string | null }
  })

  if (stopped === 'not_configured') {
    notes.push('Jev is not configured (TYPESAFE_API_KEY), so nothing can be scored. Autopilot picks nothing rather than guess.')
  }

  // 7. Accept, then pick.
  const accepted: PlannedJob[] = []
  for (const { entry, match, costUsd, failed } of scored) {
    const { job } = entry
    if (failed === 'budget') {
      skip(job, 'budget', 'the compute budget for scoring ran out in this run', { costUsd })
      continue
    }
    if (failed || !match) {
      skip(job, 'scoring_failed', failed === 'not_configured' ? 'Jev is not configured' : `scoring failed (${failed ?? 'no answer'})`, { costUsd })
      continue
    }
    if (entry.eligibility === 'ineligible') {
      counts.ineligible++
      skip(job, 'ineligible', entry.eligibilityReason, { costUsd })
      continue
    }
    const best = match.best
    const verdict = acceptMatch(best, input.settings.minMatch, limits.minConfidence)
    const extra = { profileId: best?.profileId ?? null, matchScore: best?.score ?? null, confidence: best?.confidence ?? null, factors: best?.factors ?? null, costUsd }
    if (!verdict.ok) {
      skip(job, verdict.code, `${verdict.reason}${match.reason ? ` — ${match.reason}` : ''}`, extra)
      continue
    }
    if (entry.eligibility === 'unknown') {
      counts.unknown++
      if (input.mode === 'hands_free') {
        skip(job, 'eligibility_unknown', `${entry.eligibilityReason}; hands-free applies only where you are sure to be eligible`, extra)
        continue
      }
    } else counts.eligible++
    accepted.push({
      job,
      profileId: best!.profileId,
      matchScore: best!.score,
      confidence: best!.confidence,
      factors: best!.factors,
      reason: `${match.reason}; ${entry.eligibility === 'eligible' ? 'eligible' : 'eligibility unconfirmed — check before approving'}: ${entry.eligibilityReason}`.slice(0, 500),
      eligibility: entry.eligibility,
      eligibilityReason: entry.eligibilityReason,
      route: entry.route,
      localScore: entry.rel.localScore,
      costUsd,
    })
  }

  // Eligible first; then match, with postings our fill engine or an API
  // carries ahead of agent-only ones unless the agent one fits clearly better.
  const ROUTE_PENALTY = 0.05
  const rankOf = (entry: PlannedJob) => entry.matchScore - (entry.route === 'agent' ? ROUTE_PENALTY : 0)
  accepted.sort((a, b) => {
    if (a.eligibility !== b.eligibility) return a.eligibility === 'eligible' ? -1 : 1
    return rankOf(b) - rankOf(a) || b.localScore - a.localScore
  })
  const picks: PlannedJob[] = []
  const reserves: PlannedJob[] = []
  const planned = new Map<string, number>()
  let agentPlanned = 0
  for (const candidate of accepted) {
    const cap = companyCap(candidate.job.company, input.history, planned, input.caps, input.now)
    if (cap) {
      skip(candidate.job, cap.code, cap.reason, { profileId: candidate.profileId, matchScore: candidate.matchScore, confidence: candidate.confidence, factors: candidate.factors, costUsd: candidate.costUsd })
      continue
    }
    if (candidate.route === 'agent' && !agentAffordable(input.budget, agentPlanned)) {
      skip(candidate.job, 'budget', "needs the browser agent and this month's compute budget would run out", { profileId: candidate.profileId, matchScore: candidate.matchScore, costUsd: candidate.costUsd })
      continue
    }
    if (picks.length < input.wanted) {
      picks.push(candidate)
      planned.set(companyKey(candidate.job.company), (planned.get(companyKey(candidate.job.company)) ?? 0) + 1)
      if (candidate.route === 'agent') agentPlanned++
    } else reserves.push(candidate)
  }
  if (picks.length < input.wanted && notes.length === 0) {
    notes.push(
      counts.relevant === 0
        ? "No fresh posting matches your profiles' target titles and filters."
        : `Found ${picks.length} of the ${input.wanted} wanted that pass eligibility and your minimum match.`,
    )
  }
  return plan(picks, reserves)
}

/**
 * What a cached score or skip was decided on: every profile's targeting and
 * the user's eligibility facts. Any change to either and postings are judged
 * afresh.
 */
export function selectionSignature(profiles: TargetProfile[], applicant: Applicant): string {
  const basis = {
    profiles: [...profiles].sort((a, b) => a.id.localeCompare(b.id)).map((profile) => ({ id: profile.id, targeting: profile.targeting })),
    country: applicant.country,
    citizenship: [...applicant.citizenship].sort(),
    auth: [...applicant.workAuthorizations].sort((a, b) => a.region.localeCompare(b.region)),
  }
  return createHash('sha1').update(JSON.stringify(basis)).digest('hex').slice(0, 16)
}

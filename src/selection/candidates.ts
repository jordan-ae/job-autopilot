import { scoreJob, tokenize, EMPTY_FEEDBACK, type FeedbackSignals, type ScorableJob, type ScoreResult, type ScoringPrefs, type SeniorityLevel } from './score.js'
import type { ProfileTargeting, Seniority } from '../types.js'
import type { AutopilotSettings } from '../settings.js'

/**
 * Selection's cheap half: which fresh postings are worth asking Jev about
 * for this user at all. Everything here is pure and costs nothing — the
 * keyword scorer (score.ts) against each resume profile's
 * targeting, the user's exclusions, everything they already applied to or
 * hid, per-company limits, and which postings our fill engine can carry.
 *
 * What survives is a short, ordered list; plan.ts spends Jev on its top.
 */

/** A posting as the planner reads it. `description` is loaded only for the shortlist. */
export interface PoolJob extends ScorableJob {
  ats: string
  ats_job_id: string
  apply_url: string
  salary_currency?: string | null
  quality_tier?: number | null
  description?: string | null
  /** The job board it was found on, when it was. */
  found_on?: string | null
}

/** A resume profile Autopilot may apply under. */
export interface TargetProfile {
  id: string
  name: string
  targeting: ProfileTargeting
}

/** How a posting would be carried, cheapest first (select.ts routeOf). `api`:
 * an ATS's own endpoint, which this package does not include.
 * `walled`: its apply link is an account or login wall (navigator/target.ts),
 * which nothing of Autopilot's carries, so it is never picked. */
export type Route = 'api' | 'fill' | 'agent' | 'walled'

// ── Targeting → the digest's scoring preferences ─────────────────────────────

/** Postings older than this are not Autopilot's: fresh roles get read. */
export const MAX_AGE_DAYS = 21

/** Words that say what kind of job, not which: a title match on these alone means little. */
const GENERIC_TITLE_WORDS = new Set(['engineer', 'engineering', 'developer', 'development', 'software', 'manager', 'specialist', 'associate', 'analyst', 'consultant', 'architect', 'programmer'])

/** A title word as a database pattern: the compounds match every way a title spells them. */
const PATTERN_FOR: Record<string, string> = { fullstack: '%full%stack%', frontend: '%front%end%', backend: '%back%end%', devops: '%dev%ops%' }

/**
 * The patterns a role title must match for a posting to be worth loading at
 * all: every word of the targets that says which job ("fullstack", "react"),
 * or — when a target is only generic words ("Software Engineer") — the words
 * together. This is the database-side twin of the scorer's rule that at least
 * half a target title must be in the posting's title, so it drops nothing the
 * scorer would keep. Empty when no profile names a title: then nothing can be
 * narrowed and the newest postings are read as they come.
 */
export function titleSearchPatterns(profiles: TargetProfile[]): string[] {
  const patterns = new Set<string>()
  for (const profile of profiles) {
    for (const title of profile.targeting.targetTitles) {
      const tokens = tokenize(title)
      if (tokens.length === 0) continue
      const distinctive = tokens.filter((token) => !GENERIC_TITLE_WORDS.has(token))
      if (distinctive.length > 0) {
        for (const token of distinctive) patterns.add(PATTERN_FOR[token] ?? `%${token.replace(/[%,()]/g, '')}%`)
      } else {
        patterns.add(`%${tokens.join('%').replace(/[,()]/g, '')}%`)
      }
    }
  }
  return [...patterns].slice(0, 24)
}

/**
 * Seniority levels a profile accepts. One step either side of what it
 * targets, because titles are an imperfect signal ("Software Engineer" reads
 * as mid at a company that has no "Senior"); Jev's seniority question then
 * scores the fit properly.
 */
export function seniorityLevels(seniority: Seniority): SeniorityLevel[] {
  switch (seniority) {
    case 'junior':
      return ['junior', 'mid']
    case 'mid':
      return ['junior', 'mid', 'senior']
    case 'senior':
      return ['mid', 'senior', 'lead']
    case 'lead':
    case 'principal':
      return ['senior', 'lead']
    default:
      return []
  }
}

export function prefsForProfile(targeting: ProfileTargeting, settings: Pick<AutopilotSettings, 'remoteOnly' | 'locations' | 'excludedKeywords'>): ScoringPrefs {
  return {
    targetRoles: targeting.targetTitles,
    locations: [...new Set([...targeting.locations, ...settings.locations])],
    remoteOnly: settings.remoteOnly || targeting.remotePreference === 'remote',
    // The floor is checked here only when the posting's currency matches
    // (salaryBelowFloor); scoreJob knows nothing of currencies.
    minSalary: null,
    keywords: targeting.mustHaveSkills,
    excludeKeywords: [...settings.excludedKeywords, ...targeting.excludedKeywords],
    maxAgeDays: MAX_AGE_DAYS,
    employmentTypes: [],
    seniorityLevels: seniorityLevels(targeting.seniority),
  }
}

/** A published salary entirely under the floor, in the floor's own currency. */
export function salaryBelowFloor(job: Pick<PoolJob, 'salary_min' | 'salary_max' | 'salary_currency'>, targeting: Pick<ProfileTargeting, 'salaryFloor' | 'salaryFloorCurrency'>): boolean {
  if (targeting.salaryFloor == null || job.salary_max == null) return false
  const currency = (job.salary_currency || 'USD').toUpperCase()
  if (currency !== (targeting.salaryFloorCurrency || 'USD').toUpperCase()) return false
  return job.salary_max < targeting.salaryFloor
}

const norm = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Does `company` match one of the user's excluded companies? Whole words, any case. */
export function companyExcluded(company: string, excluded: string[]): boolean {
  const name = ` ${norm(company)} `
  return excluded.some((entry) => {
    const word = norm(entry)
    return word !== '' && (name.trim() === word || name.includes(` ${word} `))
  })
}

export interface Relevance {
  profileId: string
  /** The digest's 0–100. */
  localScore: number
  result: ScoreResult
}

/**
 * The best local score across the profiles, or null when no profile wants
 * this posting: a hard filter fails (remote, seniority, excluded word, age,
 * salary), the company is excluded, or the title shares too little with the
 * profile's target titles.
 */
export function relevance(
  job: PoolJob,
  profiles: TargetProfile[],
  settings: Pick<AutopilotSettings, 'remoteOnly' | 'locations' | 'excludedKeywords' | 'excludedCompanies'>,
  feedback: FeedbackSignals = EMPTY_FEEDBACK,
): Relevance | null {
  if (companyExcluded(job.company, settings.excludedCompanies)) return null
  let best: Relevance | null = null
  for (const profile of profiles) {
    const t = profile.targeting
    if (companyExcluded(job.company, t.excludedCompanies)) continue
    if (salaryBelowFloor(job, t)) continue
    if (t.remotePreference === 'onsite' && job.is_remote) continue
    const result = scoreJob(job, prefsForProfile(t, settings), [...t.mustHaveSkills, ...t.niceToHaveSkills], feedback)
    if (!result) continue
    // With target titles set, at least half of one must be in the title.
    if (t.targetTitles.length > 0 && (result.breakdown.role?.score ?? 0) < (result.breakdown.role?.max ?? 40) / 2) continue
    if (!best || result.score > best.localScore) best = { profileId: profile.id, localScore: result.score, result }
  }
  return best
}

// ── What the user has already done ───────────────────────────────────────────

export interface History {
  /** Jobs with an apply attempt of any origin, in any state. */
  attemptedJobIds: Set<string>
  /**
   * "company|role" of the postings those attempts were for (a failed attempt
   * never reached the employer and is left out). The board lists one opening
   * several times, under different ids; this catches the copies.
   */
  attemptedKeys?: Set<string>
  /** Jobs on the tracker (applications.job_id). */
  trackedJobIds: Set<string>
  /** "company|role", normalised, for tracker rows typed in by hand. */
  trackedKeys: Set<string>
  /** Hidden from the board (job_feedback dislike). */
  hiddenJobIds: Set<string>
  /** Applications per company in the last 180 days, for the caps. */
  companyApplications: Array<{ company: string; at: string }>
}

export const EMPTY_HISTORY: History = {
  attemptedJobIds: new Set(),
  attemptedKeys: new Set(),
  trackedJobIds: new Set(),
  trackedKeys: new Set(),
  hiddenJobIds: new Set(),
  companyApplications: [],
}

export const trackedKey = (company: string, role: string) => `${norm(company)}|${norm(role)}`

export type DedupeReason = 'already_applied' | 'tracked' | 'hidden'

export function alreadyHandled(job: Pick<PoolJob, 'id' | 'company' | 'role'>, history: History): DedupeReason | null {
  if (history.attemptedJobIds.has(job.id)) return 'already_applied'
  if (history.attemptedKeys?.has(trackedKey(job.company, job.role))) return 'already_applied'
  if (history.trackedJobIds.has(job.id) || history.trackedKeys.has(trackedKey(job.company, job.role))) return 'tracked'
  if (history.hiddenJobIds.has(job.id)) return 'hidden'
  return null
}

// ── Per-company limits ───────────────────────────────────────────────────────

/**
 * Limits employers state on their own forms. A user over one gets an
 * automatic rejection at best and a flagged profile at worst. Only limits a
 * company publishes go here — never guessed.
 */
export const KNOWN_COMPANY_CAPS: Array<{ match: RegExp; max: number; days: number; note: string }> = [
  { match: /^openai$/, max: 5, days: 180, note: 'OpenAI accepts 5 applications per 180 days' },
]

export interface CapConfig {
  /** Autopilot's own limit: at most this many applications to one company per rolling 30 days. */
  perCompany30d: number
}

export interface CapCheck {
  code: 'company_cap' | 'known_cap'
  reason: string
}

/**
 * Would one more application to `company` break a limit? `planned` counts
 * the ones already chosen in this run.
 */
export function companyCap(
  company: string,
  history: Pick<History, 'companyApplications'>,
  planned: Map<string, number>,
  config: CapConfig,
  now: Date,
): CapCheck | null {
  const key = norm(company)
  const within = (days: number) =>
    history.companyApplications.filter((entry) => norm(entry.company) === key && now.getTime() - new Date(entry.at).getTime() <= days * 86_400_000).length +
    (planned.get(key) ?? 0)
  for (const cap of KNOWN_COMPANY_CAPS) {
    if (cap.match.test(key) && within(cap.days) >= cap.max) return { code: 'known_cap', reason: `${cap.note}; you have ${within(cap.days)}` }
  }
  if (config.perCompany30d > 0 && within(30) >= config.perCompany30d) {
    return { code: 'company_cap', reason: `already ${within(30)} application${within(30) === 1 ? '' : 's'} to ${company} in 30 days (limit ${config.perCompany30d})` }
  }
  return null
}

export const companyKey = norm

// ── Routes and the compute budget ────────────────────────────────────────────

export interface BudgetState {
  budgetUsd: number
  /** This month so far: attempts' compute plus selection's Jev calls. */
  spentUsd: number
  /** What one browser-agent application is expected to cost. */
  agentEstimateUsd: number
}

/**
 * May one more agent-carried application be planned? Fill-engine and API
 * postings cost cents and are never refused here; the agent is what the
 * budget is for.
 */
export function agentAffordable(budget: BudgetState, agentPlanned: number): boolean {
  if (budget.budgetUsd <= 0) return false
  return budget.spentUsd + (agentPlanned + 1) * budget.agentEstimateUsd <= budget.budgetUsd
}

/** Ordering key for the shortlist: local fit, nudged toward postings we can carry cheaply. */
export function shortlistKey(localScore: number, route: Route, qualityTier: number | null | undefined): number {
  return localScore + (route === 'agent' ? 0 : 12) + (qualityTier ?? 1) * 2
}


export interface ScorableJob {
  id: string
  company: string
  role: string
  location: string
  employment_type: string
  is_remote: boolean
  salary_min: number | null
  salary_max: number | null
  tags: string[] | null
  short_description: string
  posted_at: string
  /** Used by the digest to identify quota-bought sweep jobs (jsearch:*). */
  source_id?: string | null
  /** Refreshed on every upsert — a proxy for "appeared in today's sweep". */
  updated_at?: string
}

export type SeniorityLevel = 'junior' | 'mid' | 'senior' | 'lead'

export interface ScoringPrefs {
  targetRoles: string[]
  locations: string[]
  remoteOnly: boolean
  minSalary: number | null
  keywords: string[]
  excludeKeywords: string[]
  /** Jobs posted more than this many days ago are excluded outright. */
  maxAgeDays: number
  /** Empty = any. Values match jobs.employment_type ('Full-time', 'Contract', ...). */
  employmentTypes: string[]
  /** Empty = any. Levels are inferred from the job title. */
  seniorityLevels: SeniorityLevel[]
}

/** Infer seniority from the job title. Unmarked titles read as 'mid'. */
export function inferSeniority(role: string): SeniorityLevel {
  const r = role.toLowerCase()
  if (/\b(intern|internship|junior|jr|graduate|entry[- ]level|trainee|working student)\b/.test(r)) return 'junior'
  if (/\b(lead|staff|principal|head|director|architect|vp)\b/.test(r)) return 'lead'
  if (/\b(senior|sr)\b/.test(r)) return 'senior'
  return 'mid'
}

/**
 * What a user's like/dislike history says about a job, computed once per digest
 * run in run.ts rather than per (user, job) pair.
 *
 * These are the only adjustments that can push the total outside a dimension's
 * own maximum, so the final score is clamped back to 0-100 and the difference
 * is folded into the breakdown as its own line — the number on the card always
 * equals the sum of the parts shown under it.
 */
export interface FeedbackSignals {
  /** Companies the user disliked at least twice. */
  dislikedCompanies: Set<string>
  /** Companies the user liked at least once. */
  likedCompanies: Set<string>
  /** Net weight per title token: positive = liked, negative = disliked. */
  titleTokenWeights: Map<string, number>
}

export const EMPTY_FEEDBACK: FeedbackSignals = {
  dislikedCompanies: new Set(),
  likedCompanies: new Set(),
  titleTokenWeights: new Map(),
}

export type ScoreDimension =
  | 'role'
  | 'skills'
  | 'keywords'
  | 'location'
  | 'salary'
  | 'freshness'
  | 'feedback'

/** Fixed maxima, summing to 100. The total score is the sum of the parts —
 * there is no multiplier on top, so a dimension can never move the total by
 * more than its max. */
export const DIMENSION_MAX: Record<ScoreDimension, number> = {
  role: 40,
  skills: 20,
  keywords: 15,
  location: 10,
  salary: 10,
  freshness: 5,
  // Feedback is an adjustment, not a component: it has no share of the 100 and
  // is only shown when it actually moved the score.
  feedback: 0,
}

/** The six dimensions that make up the 0-100 total, in display order. */
export const SCORED_DIMENSIONS: ScoreDimension[] = [
  'role',
  'skills',
  'keywords',
  'location',
  'salary',
  'freshness',
]

export const SCORE_DIMENSIONS = Object.keys(DIMENSION_MAX) as ScoreDimension[]

export interface DimensionScore {
  score: number
  max: number
  note: string
}

/** Partial because `feedback` is only present when it actually moved the
 * score. The six SCORED_DIMENSIONS are always present. */
export type ScoreBreakdownMap = Partial<Record<ScoreDimension, DimensionScore>>

export interface ScoreResult {
  /** Integer 0-100. Always equals the sum of the breakdown scores. */
  score: number
  breakdown: ScoreBreakdownMap
  reasons: string[]
}

export type ScoreBand = 'Excellent fit' | 'Great fit' | 'Good fit' | 'Possible fit'

/** Label for a 0-100 score. Every card gets one. */
export function scoreBand(score: number): ScoreBand {
  if (score >= 90) return 'Excellent fit'
  if (score >= 80) return 'Great fit'
  if (score >= 70) return 'Good fit'
  return 'Possible fit'
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'at', 'or', 'senior', 'junior', 'mid', 'lead', 'staff'])

/** Titles spell these three ways ("Full-stack", "Full Stack", "Fullstack"); they are one word. */
const COMPOUNDS: Array<[RegExp, string]> = [
  [/\bfull[\s-]+stack\b/g, 'fullstack'],
  [/\bfront[\s-]+end\b/g, 'frontend'],
  [/\bback[\s-]+end\b/g, 'backend'],
  [/\bdev[\s-]+ops\b/g, 'devops'],
]

export function tokenize(value: string): string[] {
  return COMPOUNDS.reduce((text, [pattern, word]) => text.replace(pattern, word), value.toLowerCase())
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

/**
 * A dimension the user has given us no signal for scores half marks rather
 * than zero: it is unknown, not bad. The note says so, and because the value
 * is identical for every job it never changes the ranking — only the honesty
 * of the number we show.
 */
function unscored(dimension: ScoreDimension, note: string): DimensionScore {
  return { score: Math.round(DIMENSION_MAX[dimension] / 2), max: DIMENSION_MAX[dimension], note }
}

function dim(dimension: ScoreDimension, fraction: number, note: string): DimensionScore {
  const max = DIMENSION_MAX[dimension]
  const clamped = Math.max(0, Math.min(1, fraction))
  return { score: Math.round(max * clamped), max, note }
}

/** Deterministic 0-100 relevance score. Returns null when the job is hard-filtered
 * out (stale, remote-only mismatch, wrong employment type or seniority, excluded
 * keyword, salary below floor). */
export function scoreJob(
  job: ScorableJob,
  prefs: ScoringPrefs,
  skills: string[],
  feedback: FeedbackSignals = EMPTY_FEEDBACK,
): ScoreResult | null {
  const haystack = `${job.role} ${job.short_description} ${(job.tags ?? []).join(' ')}`.toLowerCase()
  const ageDays = Math.max(0, (Date.now() - new Date(job.posted_at).getTime()) / 86_400_000)

  // Hard filters first — unchanged.
  if (ageDays > prefs.maxAgeDays) return null
  if (prefs.remoteOnly && !job.is_remote) return null
  if (
    prefs.employmentTypes.length > 0 &&
    !prefs.employmentTypes.some((t) => t.toLowerCase() === job.employment_type.toLowerCase())
  ) {
    return null
  }
  if (prefs.seniorityLevels.length > 0 && !prefs.seniorityLevels.includes(inferSeniority(job.role))) return null
  for (const excluded of prefs.excludeKeywords) {
    if (excluded && haystack.includes(excluded.toLowerCase())) return null
  }
  if (prefs.minSalary != null && job.salary_max != null && job.salary_max < prefs.minSalary) return null

  const reasons: string[] = []
  const breakdown: ScoreBreakdownMap = {}

  // --- role (40) — target-role token overlap, the heaviest signal.
  const targets = prefs.targetRoles.filter((t) => tokenize(t).length > 0)
  if (targets.length === 0) {
    breakdown.role = unscored('role', 'no target roles set')
  } else {
    const roleTokens = new Set(tokenize(job.role))
    let bestFraction = 0
    let bestRole = ''
    for (const target of targets) {
      const targetTokens = tokenize(target)
      const matched = targetTokens.filter((t) => roleTokens.has(t)).length
      const fraction = matched / targetTokens.length
      if (fraction > bestFraction) {
        bestFraction = fraction
        bestRole = target
      }
    }
    breakdown.role = dim(
      'role',
      bestFraction,
      bestFraction > 0 ? `matches "${bestRole}"` : 'title does not match your target roles',
    )
    if (bestFraction > 0) reasons.push(`matches target role "${bestRole}"`)
  }

  // --- skills (20) — profile skills named in the posting. Saturates at 5.
  const realSkills = skills.filter(Boolean)
  if (realSkills.length === 0) {
    breakdown.skills = unscored('skills', 'no skills on your profile yet')
  } else {
    const hits = realSkills.filter((s) => haystack.includes(s.toLowerCase())).length
    const target = Math.min(realSkills.length, 5)
    breakdown.skills = dim('skills', hits / target, `${hits} of your ${realSkills.length} skills mentioned`)
    if (hits > 0) reasons.push(`${hits} of your skills mentioned`)
  }

  // --- keywords (15) — must-have keywords found. Saturates at 3.
  const realKeywords = prefs.keywords.filter(Boolean)
  if (realKeywords.length === 0) {
    breakdown.keywords = unscored('keywords', 'no keywords set')
  } else {
    const matchedKeywords = realKeywords.filter((k) => haystack.includes(k.toLowerCase()))
    const target = Math.min(realKeywords.length, 3)
    breakdown.keywords = dim(
      'keywords',
      matchedKeywords.length / target,
      matchedKeywords.length > 0 ? `matched ${matchedKeywords.slice(0, 3).join(', ')}` : 'none of your keywords appear',
    )
    for (const keyword of matchedKeywords.slice(0, 3)) reasons.push(`keyword: ${keyword}`)
  }

  // --- location (10).
  const realLocations = prefs.locations.filter(Boolean)
  if (realLocations.length > 0) {
    const jobLocation = job.location.toLowerCase()
    const matched = realLocations.find((loc) => jobLocation.includes(loc.toLowerCase()))
    if (matched) {
      breakdown.location = dim('location', 1, `in ${matched}`)
      reasons.push(`in ${matched}`)
    } else if (job.is_remote) {
      // Remote clears a location preference without satisfying it outright.
      breakdown.location = dim('location', 0.7, 'remote, but not in your preferred locations')
      reasons.push('remote')
    } else {
      breakdown.location = dim('location', 0, `${job.location || 'location'} is outside your preferences`)
    }
  } else if (job.is_remote) {
    breakdown.location = dim('location', 1, 'remote')
    reasons.push('remote')
  } else {
    breakdown.location = unscored('location', 'no location preference set')
  }

  // --- salary (10).
  if (prefs.minSalary != null) {
    if (job.salary_min != null && job.salary_min >= prefs.minSalary) {
      breakdown.salary = dim('salary', 1, 'whole range is above your minimum')
      reasons.push('salary meets your minimum')
    } else if (job.salary_max != null) {
      // salary_max < minSalary was hard-filtered above, so the range straddles.
      breakdown.salary = dim('salary', 0.6, 'top of the range clears your minimum')
    } else {
      breakdown.salary = dim('salary', 0.3, 'no salary published')
    }
  } else if (job.salary_min != null || job.salary_max != null) {
    breakdown.salary = dim('salary', 1, 'salary published')
  } else {
    breakdown.salary = dim('salary', 0.5, 'no salary published')
  }

  // --- freshness (5) — a dimension, not a multiplier on the total. Staleness
  // is already handled by the maxAgeDays hard filter above.
  const freshness = prefs.maxAgeDays > 0 ? 1 - ageDays / prefs.maxAgeDays : 1
  breakdown.freshness = dim(
    'freshness',
    freshness,
    ageDays < 1 ? 'posted today' : `posted ${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? '' : 's'} ago`,
  )
  if (ageDays < 1) reasons.push('posted today')
  else if (ageDays < 3) reasons.push('posted this week')

  const base = SCORED_DIMENSIONS.reduce((sum, key) => sum + (breakdown[key]?.score ?? 0), 0)

  // --- feedback adjustment, from what this user has liked and disliked before.
  const { delta, note } = feedbackAdjustment(job, feedback)
  // Clamping happens here, not on the delta, so the adjustment line always
  // reports the amount the total actually moved by.
  const score = Math.max(0, Math.min(100, base + delta))
  const applied = score - base
  if (applied !== 0) {
    breakdown.feedback = { score: applied, max: 0, note }
    reasons.push(note)
  }

  // The total IS the sum of the (already integral) parts, so the breakdown can
  // never disagree with the number on the card.
  return { score, breakdown, reasons }
}

/**
 * Company- and title-level nudges derived from the user's own verdicts.
 *
 * Deliberately small and bounded: this steers the ranking, it does not
 * overrule the fit signals. Jobs the user disliked outright are excluded in
 * run.ts before they ever reach the scorer.
 */
function feedbackAdjustment(job: ScorableJob, feedback: FeedbackSignals): { delta: number; note: string } {
  const notes: string[] = []
  let delta = 0

  const company = job.company.trim().toLowerCase()
  if (feedback.dislikedCompanies.has(company)) {
    delta -= 15
    notes.push(`you passed on other ${job.company} roles`)
  } else if (feedback.likedCompanies.has(company)) {
    delta += 10
    notes.push(`you liked another ${job.company} role`)
  }

  if (feedback.titleTokenWeights.size > 0) {
    const tokens = new Set(tokenize(job.role))
    let net = 0
    for (const token of tokens) net += feedback.titleTokenWeights.get(token) ?? 0
    if (net !== 0) {
      // Saturates at ±10 so one heavily-repeated token can't dominate.
      const titleDelta = Math.round(Math.max(-10, Math.min(10, net * 5)))
      if (titleDelta !== 0) {
        delta += titleDelta
        notes.push(titleDelta > 0 ? 'title matches roles you liked' : 'title matches roles you passed on')
      }
    }
  }

  return { delta, note: notes.join('; ') }
}

/** Build the aggregates once per user per digest run. */
export function buildFeedbackSignals(
  rows: Array<{ verdict: string; company: string; role: string }>,
): FeedbackSignals {
  const dislikeCountByCompany = new Map<string, number>()
  const likedCompanies = new Set<string>()
  const titleTokenWeights = new Map<string, number>()

  for (const row of rows) {
    const company = row.company.trim().toLowerCase()
    if (row.verdict === 'dislike') {
      dislikeCountByCompany.set(company, (dislikeCountByCompany.get(company) ?? 0) + 1)
    } else if (row.verdict === 'like') {
      likedCompanies.add(company)
    }

    // 'skip' is a weak signal — the user moved on without an opinion — so it
    // contributes nothing rather than counting as a soft dislike.
    const weight = row.verdict === 'like' ? 1 : row.verdict === 'dislike' ? -1 : 0
    if (weight === 0) continue
    for (const token of new Set(tokenize(row.role))) {
      titleTokenWeights.set(token, (titleTokenWeights.get(token) ?? 0) + weight)
    }
  }

  const dislikedCompanies = new Set(
    [...dislikeCountByCompany.entries()].filter(([, count]) => count >= 2).map(([company]) => company),
  )
  // A single like outweighs an old dislike pattern: the user told us directly.
  for (const company of likedCompanies) dislikedCompanies.delete(company)

  return { dislikedCompanies, likedCompanies, titleTokenWeights }
}

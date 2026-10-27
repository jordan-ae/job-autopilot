import type { JevQuestion, NoulAnswer, ScoreAnswer, ScoreQuestion } from '../ai/decide.js'
import { noulConfidence } from '../ai/decide.js'
import { inferSeniority } from './score.js'
import type { PoolJob, TargetProfile } from './candidates.js'
import { plainText } from './eligibility.js'

/**
 * Selection's scoring: how well one posting fits each of the user's resume
 * profiles, from decomposed questions Jev answers in one call per posting.
 *
 * Every profile rides in the state under a short key (p0, p1, …) and gets the
 * same four questions:
 *
 *   title_pN      score, 5 levels   does the job's title/role match the profile's target titles
 *   skills_pN     score, 5 levels   how many of its must-have skills the job asks for or uses
 *   seniority_pN  score, 3 levels   is the level the same, one off, or further
 *   same_pN       noul              is this the same kind of role the profile targets
 *
 * Jev reads and scores; this module does the arithmetic, so the weights
 * below are the whole of how a match is decided:
 *
 *   match = 0.35·title + 0.30·skills + 0.15·seniority + 0.20·same
 *
 * Title leads because the wrong job is the worst outcome for the user's name
 * with an employer. Skills next: must-haves are what screening filters on.
 * Seniority is a smaller weight because titles understate it. The noul is a
 * cross-check on the title score from a differently worded question. A
 * profile with no must-have skills, or no seniority set, has that question
 * left out and its weight shared out among the others.
 *
 * Each level is read as Jev's expected level (probability-weighted), not the
 * top answer, so a 50/50 between "close" and "exact" scores between them.
 */

export const MATCH_WEIGHTS = { title: 0.35, skills: 0.3, seniority: 0.15, same: 0.2 } as const
export type Factor = keyof typeof MATCH_WEIGHTS

/** Below this mean confidence a match is not trusted, whatever its score. */
export const MIN_CONFIDENCE = 0.4

/** How much of the description rides along: enough to judge fit, cheap to send. */
export const DESCRIPTION_CHARS = 1800

const TITLE_LEVELS = [
  'unrelated role',
  'adjacent field, different job',
  'same field, different focus',
  'close match to a target title',
  'exact match to a target title',
]
const SKILL_LEVELS = [
  'none of the must-have skills',
  'one or two of them',
  'about half of them',
  'most of them',
  'all or nearly all of them',
]
const SENIORITY_LEVELS = ['two or more levels apart', 'one level apart', 'the same level']

export interface ProfileMatch {
  profileId: string
  /** 0–1. */
  score: number
  /** Mean confidence of the answers that went into it, 0–1. */
  confidence: number
  /** Each factor's 0–1 value; absent when the question was not asked. */
  factors: Partial<Record<Factor, number>>
}

export interface JobMatch {
  best: ProfileMatch | null
  all: ProfileMatch[]
  /** 'title 0.92, skills 0.75, seniority 1.00, same-role 0.88 (Backend profile)'. */
  reason: string
}

const profileKey = (index: number) => `p${index}`

/** The state Jev reads for one posting. Profiles by short key; ids stay here. */
export function matchState(job: Pick<PoolJob, 'role' | 'company' | 'location' | 'is_remote' | 'description' | 'short_description' | 'tags'>, profiles: TargetProfile[]) {
  const description = (plainText(job.description) || plainText(job.short_description)).slice(0, DESCRIPTION_CHARS)
  return {
    job: {
      title: job.role,
      company: job.company,
      location: job.location,
      remote: job.is_remote,
      level_from_title: inferSeniority(job.role),
      tags: (job.tags ?? []).slice(0, 12),
      description,
    },
    profiles: Object.fromEntries(
      profiles.map((profile, index) => [
        profileKey(index),
        {
          target_titles: profile.targeting.targetTitles,
          must_have_skills: profile.targeting.mustHaveSkills,
          nice_to_have_skills: profile.targeting.niceToHaveSkills,
          seniority: profile.targeting.seniority || 'not set',
        },
      ]),
    ),
  }
}

/** The questions for every profile, keyed `<factor>_p<N>`. */
export function matchQuestions(profiles: TargetProfile[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {}
  profiles.forEach((profile, index) => {
    const key = profileKey(index)
    questions[`title_${key}`] = {
      type: 'score',
      instructions: `Compare the job's title and the work its description describes with profile ${key}'s target_titles. How close is this job to what ${key} is looking for?`,
      criteria: TITLE_LEVELS,
    }
    if (profile.targeting.mustHaveSkills.length > 0) {
      questions[`skills_${key}`] = {
        type: 'score',
        instructions: `How many of profile ${key}'s must_have_skills does this job require or clearly use day to day, judging from its description and tags?`,
        criteria: SKILL_LEVELS,
      }
    }
    if (profile.targeting.seniority) {
      questions[`seniority_${key}`] = {
        type: 'score',
        instructions: `Profile ${key} targets ${profile.targeting.seniority}-level roles. How far is this job's level (from its title and the experience it asks for) from that?`,
        criteria: SENIORITY_LEVELS,
      }
    }
    questions[`same_${key}`] = {
      type: 'noul',
      instructions: `Is this job the same kind of role that profile ${key} targets — the same discipline and day-to-day work, not just overlapping keywords?`,
      criteria: { true: `Same kind of role as ${key} targets.`, false: `A different kind of role from what ${key} targets.` },
    }
  })
  return questions
}

/** A score answer as 0–1: the probability-weighted level, else the top level. */
export function scoreValue(answer: ScoreAnswer, question: Pick<ScoreQuestion, 'criteria'>): number {
  const levels = question.criteria.length
  const top = levels - 1
  const probabilities = answer.probabilities ?? {}
  let mass = 0
  let weighted = 0
  for (const [key, p] of Object.entries(probabilities)) {
    if (typeof p !== 'number' || !Number.isFinite(p)) continue
    const asIndex = /^\d+$/.test(key) ? Number(key) : question.criteria.indexOf(key)
    if (asIndex < 0 || asIndex > top) continue
    mass += p
    weighted += p * asIndex
  }
  const level = mass > 0.5 ? weighted / mass : answer.score
  return Math.max(0, Math.min(1, level / top))
}

/**
 * Combine one profile's answers. Factors with no answer drop out and the
 * weights left are scaled back up to 1.
 */
export function combine(profileId: string, factors: Partial<Record<Factor, { value: number; confidence: number }>>): ProfileMatch {
  let weight = 0
  let total = 0
  let confidence = 0
  let count = 0
  const values: Partial<Record<Factor, number>> = {}
  for (const factor of Object.keys(MATCH_WEIGHTS) as Factor[]) {
    const entry = factors[factor]
    if (!entry) continue
    weight += MATCH_WEIGHTS[factor]
    total += MATCH_WEIGHTS[factor] * entry.value
    confidence += entry.confidence
    count += 1
    values[factor] = Math.round(entry.value * 100) / 100
  }
  return {
    profileId,
    score: weight > 0 ? Math.round((total / weight) * 1000) / 1000 : 0,
    confidence: count > 0 ? Math.round((confidence / count) * 1000) / 1000 : 0,
    factors: values,
  }
}

const FACTOR_WORDS: Record<Factor, string> = { title: 'title', skills: 'skills', seniority: 'seniority', same: 'same-role' }

/** 'title 0.92, skills 0.75, seniority 1.00, same-role 0.88' — machine-made, read by people. */
export function describeFactors(match: Pick<ProfileMatch, 'factors'>): string {
  return (Object.keys(MATCH_WEIGHTS) as Factor[])
    .filter((factor) => match.factors[factor] !== undefined)
    .map((factor) => `${FACTOR_WORDS[factor]} ${match.factors[factor]!.toFixed(2)}`)
    .join(', ')
}

/** Read Jev's answers for every profile and pick the best. Highest score wins; ties go to the earlier profile. */
export function readMatch(
  profiles: TargetProfile[],
  questions: Record<string, JevQuestion>,
  answers: Record<string, unknown>,
): JobMatch {
  const all: ProfileMatch[] = profiles.map((profile, index) => {
    const key = profileKey(index)
    const factors: Partial<Record<Factor, { value: number; confidence: number }>> = {}
    for (const factor of ['title', 'skills', 'seniority'] as const) {
      const question = questions[`${factor}_${key}`]
      const answer = answers[`${factor}_${key}`] as ScoreAnswer | undefined
      if (question?.type === 'score' && answer && typeof answer.score === 'number') {
        factors[factor] = { value: scoreValue(answer, question), confidence: answer.confidence ?? 0 }
      }
    }
    const same = answers[`same_${key}`] as NoulAnswer | undefined
    if (same && typeof same.noul === 'number') factors.same = { value: same.noul, confidence: noulConfidence(same) }
    return combine(profile.id, factors)
  })
  const best = all.reduce<ProfileMatch | null>((top, entry) => (!top || entry.score > top.score ? entry : top), null)
  const name = best ? profiles.find((profile) => profile.id === best.profileId)?.name : ''
  return { best, all, reason: best ? `${describeFactors(best)}${name ? ` (${name})` : ''}` : '' }
}

export type MatchVerdict = { ok: true } | { ok: false; code: 'below_match' | 'low_confidence'; reason: string }

/** Is the best profile's match good enough to apply? */
export function acceptMatch(match: ProfileMatch | null, minMatch: number, minConfidence = MIN_CONFIDENCE): MatchVerdict {
  if (!match) return { ok: false, code: 'below_match', reason: 'no profile scored' }
  if (match.confidence < minConfidence) {
    return { ok: false, code: 'low_confidence', reason: `match ${match.score.toFixed(2)} at confidence ${match.confidence.toFixed(2)} (needs ${minConfidence})` }
  }
  if (match.score < minMatch) {
    return { ok: false, code: 'below_match', reason: `match ${match.score.toFixed(2)} under your minimum ${minMatch.toFixed(2)}` }
  }
  return { ok: true }
}

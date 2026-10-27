import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { DEFAULT_SETTINGS, type AutopilotSettings } from './settings.js'
import type { AgentAnswerRecord } from './store/types.js'
import type { ApplicationProfile, ApplyContext, JobRow, ProfileTargeting, ResumeFacts } from './types.js'

/**
 * The person applying: what they have on file, the CV that gets attached,
 * and their settings. This is the only source of factual answers.
 */
export interface Applicant {
  userId: string
  profile: ApplicationProfile
  /** The CV as structured facts: what the resolver reads and the drafter writes from. */
  resume: ResumeFacts | null
  /** The CV as it is attached. */
  resumePdf: Buffer
  resumeFileName: string
  coverLetterText: string
  /** Values a resume profile sets for this application, by canonical field key. */
  overrides: Record<string, string | boolean | number | string[]>
  /**
   * Names this CV and letter. The `documents_attached` gate checks that the
   * application carries one and that the file on the form is this CV.
   */
  documentId: string
  /** The resume profile's name, for the receipt. */
  profileName: string | null
  settings: AutopilotSettings
  /** What to look for, per resume profile (src/selection/). */
  targeting: Array<{ id: string; name: string } & ProfileTargeting>
}

/**
 * The profile file the CLI reads. Everything but `profile.email` and
 * `profile.full_name` is optional; anything missing is "not on file", and a
 * question that needs it is asked, never invented.
 */
export interface ProfileFile {
  id?: string
  profile: Partial<ApplicationProfile>
  resume?: ResumeFacts
  coverLetter?: string
  overrides?: Applicant['overrides']
  settings?: Partial<AutopilotSettings>
  targeting?: Array<{ id?: string; name?: string } & Partial<ProfileTargeting>>
  profileName?: string
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A profile as the resolver reads it. Blank where the file says nothing. */
export function profileFrom(userId: string, raw: Partial<ApplicationProfile>): ApplicationProfile {
  return {
    ...raw,
    client_key: userId,
    full_name: text(raw.full_name),
    email: text(raw.email),
    phone: text(raw.phone),
    location: text(raw.location),
    linkedin_url: text(raw.linkedin_url),
    portfolio_url: text(raw.portfolio_url),
    github_url: text(raw.github_url),
    work_authorization: text(raw.work_authorization),
    requires_sponsorship: raw.requires_sponsorship ?? null,
    notice_period_days: raw.notice_period_days ?? null,
    desired_salary: raw.desired_salary ?? null,
    desired_salary_currency: raw.desired_salary_currency || 'USD',
    earliest_start_date: raw.earliest_start_date ?? null,
    custom_answers: raw.custom_answers ?? {},
    eeo: raw.eeo ?? {},
    country: text(raw.country).toUpperCase(),
    citizenship: Array.isArray(raw.citizenship) ? raw.citizenship.map((code) => String(code).toUpperCase()) : [],
    work_authorizations: (raw.work_authorizations ?? []).map((row) => ({ ...row, region: String(row.region).toUpperCase() })),
  }
}

function targetingFrom(raw: ProfileFile['targeting']): Applicant['targeting'] {
  return (raw ?? []).map((entry, index) => ({
    id: entry.id ?? `profile-${index + 1}`,
    name: entry.name ?? `Profile ${index + 1}`,
    targetTitles: entry.targetTitles ?? [],
    mustHaveSkills: entry.mustHaveSkills ?? [],
    niceToHaveSkills: entry.niceToHaveSkills ?? [],
    seniority: entry.seniority ?? '',
    remotePreference: entry.remotePreference ?? 'any',
    locations: entry.locations ?? [],
    salaryFloor: entry.salaryFloor ?? null,
    salaryFloorCurrency: entry.salaryFloorCurrency ?? 'USD',
    excludedCompanies: entry.excludedCompanies ?? [],
    excludedKeywords: entry.excludedKeywords ?? [],
  }))
}

export function applicantFrom(file: ProfileFile, cv: { bytes: Buffer; fileName: string }, coverLetter?: string): Applicant {
  if (!file.profile || typeof file.profile !== 'object') throw new Error('the profile file needs a "profile" object')
  const userId = file.id?.trim() || 'me'
  const profile = profileFrom(userId, file.profile)
  if (!profile.email || !profile.full_name) throw new Error('the profile needs at least "full_name" and "email"')
  const letter = coverLetter ?? file.coverLetter ?? ''
  return {
    userId,
    profile,
    resume: file.resume ?? null,
    resumePdf: cv.bytes,
    resumeFileName: cv.fileName,
    coverLetterText: letter,
    overrides: file.overrides ?? {},
    documentId: createHash('sha256').update(cv.bytes).update(letter).digest('hex').slice(0, 16),
    profileName: file.profileName ?? null,
    settings: { ...DEFAULT_SETTINGS, ...file.settings },
    targeting: targetingFrom(file.targeting),
  }
}

/** Read a profile JSON file, a CV PDF and, optionally, a letter. */
export function loadApplicant(paths: { profile: string; cv: string; coverLetter?: string }): Applicant {
  const file = JSON.parse(readFileSync(paths.profile, 'utf8')) as ProfileFile
  const bytes = readFileSync(paths.cv)
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`${paths.cv} is not a PDF`)
  const letter = paths.coverLetter ? readFileSync(paths.coverLetter, 'utf8') : undefined
  return applicantFrom(file, { bytes, fileName: basename(paths.cv) }, letter)
}

/**
 * The applicant's answer bank with the agent's reviewed drafts in it. A draft
 * the applicant approved or corrected is their word now, and the resolver
 * answers from it like any other banked answer; one still pending is never
 * evidence for anything.
 */
export function withReviewedAnswers(profile: ApplicationProfile, reviewed: AgentAnswerRecord[]): ApplicationProfile {
  const custom = { ...profile.custom_answers }
  const meta = { ...(profile.answer_meta ?? {}) }
  for (const row of reviewed) {
    if (row.reviewState === 'pending') continue
    custom[row.fingerprint] = row.answer
    meta[row.fingerprint] = { source: 'agent', fieldKey: row.fieldKey, jobId: row.jobId, reviewState: row.reviewState }
  }
  return { ...profile, custom_answers: custom, answer_meta: meta }
}

/** Everything one application is built from. */
export function applyContext(applicant: Applicant, job: JobRow, reviewed: AgentAnswerRecord[] = []): ApplyContext {
  return {
    job,
    profile: withReviewedAnswers(applicant.profile, reviewed),
    resumePdf: applicant.resumePdf,
    coverLetterText: applicant.coverLetterText,
    resumeFileName: applicant.resumeFileName,
    resume: applicant.resume,
    overrides: applicant.overrides,
  }
}

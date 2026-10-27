import type { AnswerMeta, ApplicationProfile, ResumeFacts, WorkAuthorization } from '../types.js'
import { classifyQuestion, type Classification, type QuestionShape } from './classify.js'
import {
  ageOn,
  currentJob,
  degreeAtLeast,
  fieldOfStudy,
  graduationYear,
  highestDegree,
  jobsNewestFirst,
  MONTH_NAMES,
  parseCvDate,
  parsePhone,
  schoolsNewestFirst,
  splitName,
  yearsOfExperience,
  type DegreeLevel,
} from './computed.js'
import { countryByCode, countryFromLocation, detectRegion, EU_MEMBERS, regionInText } from './countries.js'
import { EEO_DECLINE, effectiveMode, fieldByKey, type AutofillMode, type CanonicalField } from './registry.js'
import { salaryForQuestion } from './salary.js'
import { findDeclineOption, fingerprintQuestion, jobFingerprint, namesCompany } from './text.js'

/**
 * Where an answer to one form question comes from.
 *
 * Lookup order, first hit wins:
 *
 *   1. job        — answered for this application already (the attempt holds it)
 *   2. question   — the user's own answer to this exact wording, from the bank
 *   3. override   — a resume-profile override (not built yet; the slot is here)
 *   4. identity   — application_profile, as the user filled it in
 *   5. computed   — derived from identity (first name, E.164 phone, age, …)
 *   6. resume     — read off the CV (current employer, degree, years of experience)
 *   7. answer_bank — a remembered answer to the same canonical field, then a
 *                   near-identical wording (fuzzy)
 *   8. agent      — an open-ended answer drafted by the agent pass from the
 *                   user's data (fields/agent.ts; async, so not in this module).
 *                   Factual and legal questions never get here: they are
 *                   answered from a stored value or asked.
 *   9. ask        — needs_input
 *
 * (2) sits above the profile because the user typed it for this question
 * specifically — "30 days" beats a bare 30 in the notice-period column. Only
 * the user's own wording-level answers get there; the agent's sit at (7)
 * until the user approves or corrects them.
 *
 * Every step respects the field's autofill mode, and the two kinds of
 * question that are the applicant's alone — EEO and consent — are never
 * answered from inference: EEO only with what the user stated in the Field
 * Mapper (declining by default once they have set it up), consent never.
 *
 * Synchronous and free of I/O: the adapters call it while preparing, the
 * planner while filling a page, the coverage score over 455 questions.
 */

export type ResolutionLayer = 'job' | 'question' | 'override' | 'identity' | 'computed' | 'resume' | 'answer_bank' | 'agent'

export type RawValue = string | boolean | number | string[]

export interface ResolveContext {
  profile: ApplicationProfile
  company: string
  /** `foundOn`: the job board the applicant found the posting on, when they did. */
  job?: { id?: string; location?: string | null; foundOn?: string | null } | null
  resume?: ResumeFacts | null
  /** Whether a tailored CV / letter exists for the documents fields. */
  documents?: { resume?: boolean; coverLetter?: boolean }
  /**
   * The resume-profile layer: values the chosen profile sets for this
   * application, from fields/overrides.ts `loadProfileOverrides`. Empty when
   * no profile applies.
   */
  overrides?: Record<string, RawValue>
  today?: Date
}

export type UnresolvedReason =
  /** No registry field matches the question. */
  | 'unmapped'
  /** Mapped, but nothing on file answers it. */
  | 'no_data'
  /** The user asked to be asked. */
  | 'mode_ask'
  /** The user chose to leave it blank. */
  | 'mode_blank'
  /** A consent: always the applicant's to give. */
  | 'consent'
  /** An EEO question the user has not set up in the Field Mapper. */
  | 'eeo_unset'

export interface Resolution {
  classification: Classification | null
  value: RawValue | null
  layer: ResolutionLayer | null
  /** EEO: pick the form's decline option. */
  decline?: boolean
  /** Per-region fields: the region the question was read as being about. */
  region?: string | null
  /** For country-valued fields, so a dropdown can be matched by code. */
  countryCode?: string
  reason?: UnresolvedReason
  /** The bank entry used, when the answer came from the bank. */
  bankKey?: string
}

const none = (classification: Classification | null, reason: UnresolvedReason, extra: Partial<Resolution> = {}): Resolution => ({
  classification,
  value: null,
  layer: null,
  reason,
  ...extra,
})

const present = (value: unknown): value is RawValue =>
  value != null && value !== '' && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'number' && Number.isNaN(value))

// ── The answer bank ───────────────────────────────────────────────────────

const FUZZY_MATCH_THRESHOLD = 0.85
const FUZZY_MIN_TOKENS = 3
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'you', 'your', 'yours',
  'we', 'us', 'our', 'i', 'me', 'my', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or',
  'this', 'that', 'these', 'those', 'please', 'if', 'any', 'have', 'has', 'had', 'would', 'will',
])

function contentTokens(fingerprint: string): Set<string> {
  return new Set(fingerprint.split(' ').filter((token) => token.length > 1 && !STOP_WORDS.has(token)))
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * The closest stored answer to this question, or null when nothing is close
 * enough. The threshold is set high on purpose — the failure mode is a wrong
 * answer submitted to a real employer, so this only ever bridges
 * near-identical wordings ("work at" / "work for"), never merely related
 * ones. Below three content words a fingerprint is too short to compare:
 * "do you have a visa" and "will you need a visa" are both {visa}.
 */
export function findSimilarAnswer(
  fingerprint: string,
  stored: Record<string, string>,
): { key: string; value: string; score: number } | null {
  const tokens = contentTokens(fingerprint)
  if (tokens.size < FUZZY_MIN_TOKENS) return null

  let best: { key: string; value: string; score: number } | null = null
  for (const [key, value] of Object.entries(stored)) {
    // Job-scoped and Field Mapper entries are not wordings to compare against.
    if (!value || key.includes('#') || key.startsWith('field:')) continue
    const candidate = contentTokens(key)
    if (candidate.size < FUZZY_MIN_TOKENS) continue
    const score = similarity(tokens, candidate)
    if (score >= FUZZY_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { key, value, score }
    }
  }
  return best
}

/** True when a bank entry may be offered for this job. */
function usableHere(meta: AnswerMeta | undefined, field: CanonicalField | undefined, jobId: string | undefined): boolean {
  if (meta?.jobId) return Boolean(jobId) && meta.jobId === jobId
  // An answer that depends on the employer is never carried to another one.
  return !field?.perEmployer
}

/** The user's own words, or an agent answer they have since approved or corrected. */
function userOwned(meta: AnswerMeta | undefined): boolean {
  return !meta || meta.source !== 'agent' || meta.reviewState === 'approved' || meta.reviewState === 'corrected'
}

function bankByField(ctx: ResolveContext, field: CanonicalField): { key: string; value: string } | null {
  const bank = ctx.profile.custom_answers ?? {}
  const meta = ctx.profile.answer_meta ?? {}
  let best: { key: string; value: string; owned: boolean } | null = null
  for (const [key, value] of Object.entries(bank)) {
    const entry = meta[key]
    if (!value || entry?.fieldKey !== field.key) continue
    if (!usableHere(entry, field, ctx.job?.id ?? undefined)) continue
    const owned = userOwned(entry)
    // The user's own answers beat the agent's; a job-scoped one beats both.
    if (!best || (owned && !best.owned) || entry?.jobId) best = { key, value, owned }
  }
  return best
}

// ── Work authorization, per region ────────────────────────────────────────

type AuthAttribute = 'authorized' | 'needs_sponsorship' | 'open_to_contractor_eor'

function rowFor(rows: WorkAuthorization[], region: string): WorkAuthorization | undefined {
  const exact = rows.find((row) => row.region.toUpperCase() === region)
  if (exact) return exact
  // An EU-wide answer covers each member state.
  if (EU_MEMBERS.has(region)) return rows.find((row) => row.region.toUpperCase() === 'EU')
  return undefined
}

function authAttribute(
  ctx: ResolveContext,
  region: string | null,
  attribute: AuthAttribute,
): { value: boolean; layer: ResolutionLayer } | null {
  const rows = ctx.profile.work_authorizations ?? []
  if (region) {
    const row = rowFor(rows, region)
    // Only the row the user filled in. Work authorisation is a legal answer:
    // it is never derived — not from citizenship, not from a similar country.
    const stated = row?.[attribute]
    return stated != null ? { value: stated, layer: 'identity' } : null
  }
  // A question that names no country, for a job that names none either: only
  // answerable when every region the user listed gives the same answer.
  const stated = rows.map((row) => row[attribute]).filter((value): value is boolean => value != null)
  if (stated.length > 0 && stated.length === rows.length && stated.every((value) => value === stated[0])) {
    return { value: stated[0], layer: 'identity' }
  }
  return null
}

// ── Values per field ──────────────────────────────────────────────────────

const DEGREE_LABELS: Record<DegreeLevel, string> = {
  high_school: 'High school',
  associate: "Associate's degree",
  bachelor: "Bachelor's degree",
  master: "Master's degree",
  doctorate: 'Doctorate',
}

type Direct = { value: RawValue; layer: ResolutionLayer; countryCode?: string; region?: string | null } | null

function column(value: unknown, layer: ResolutionLayer = 'identity'): Direct {
  return present(value) ? { value: value as RawValue, layer } : null
}

/**
 * "How did you hear about this job?" for a posting the applicant found on a
 * job board (`job.foundOn`, a stored fact about this application): the
 * board's own option if the form lists it, else the form's job-board choice,
 * else "Other" (the truth, if not its label), else — a free-text box — the
 * board's name. A listed "LinkedIn" or "Company website" that is not where
 * they found it would be a guess, so it is never picked.
 */
export function boardReferral(options: string[] | undefined, foundOn: string): string {
  const choices = Array.isArray(options) ? options.filter((option) => typeof option === 'string') : []
  const named = `Job board (${foundOn})`
  if (choices.length === 0) return named
  const same = choices.find((option) => option.trim().toLowerCase() === foundOn.trim().toLowerCase())
  if (same) return same
  const board = choices.find((option) => /\bjob[\s-]*(?:board|site|portal|listing|search|aggregator)s?\b/i.test(option))
  if (board) return board
  const other = choices.find((option) => /^\s*other\b/i.test(option)) ?? choices.find((option) => /\bother\b/i.test(option))
  return other ?? named
}

function homeCountry(profile: ApplicationProfile): string | null {
  return (profile.country || countryFromLocation(profile.location) || '').toUpperCase() || null
}

function phoneParts(profile: ApplicationProfile) {
  return parsePhone(profile.phone, { countryCode: profile.phone_country_code, homeCountry: homeCountry(profile) })
}

function countryValue(code: string | null | undefined, layer: ResolutionLayer): Direct {
  const country = countryByCode(code)
  return country ? { value: country.name, layer, countryCode: country.code } : null
}

function directValue(field: CanonicalField, ctx: ResolveContext, question: QuestionShape, entryIndex: number): Direct {
  const p = ctx.profile
  const today = ctx.today ?? new Date()
  const resume = ctx.resume
  const name = splitName(p.full_name ?? '')
  const text = `${question.label} ${question.description ?? ''}`

  switch (field.key) {
    // Personal
    case 'full_name':
      return column(p.full_name)
    case 'first_name':
      return column(p.first_name) ?? column(name.first, 'computed')
    case 'last_name':
      return column(p.last_name) ?? column(name.last, 'computed')
    case 'middle_name':
      return column(p.middle_name)
    case 'preferred_name':
      return column(p.preferred_name)
    case 'preferred_last_name':
      return column(p.preferred_last_name)
    case 'email':
      return column(p.email)
    case 'phone':
      return column(p.phone)
    case 'phone_e164':
      return column(phoneParts(p)?.e164, 'computed')
    case 'phone_country_code':
      return column(p.phone_country_code) ?? column(phoneParts(p)?.countryCode, 'computed')
    case 'phone_national':
      return column(p.phone_national) ?? column(phoneParts(p)?.national, 'computed')
    case 'phone_country':
      return countryValue(phoneParts(p)?.country?.code, 'computed')
    case 'date_of_birth':
      return column(p.date_of_birth)
    case 'age': {
      const age = ageOn(p.date_of_birth, today)
      return age == null ? null : { value: age, layer: 'computed' }
    }
    case 'over_18':
    case 'over_21': {
      const age = ageOn(p.date_of_birth, today)
      return age == null ? null : { value: age >= (field.key === 'over_18' ? 18 : 21), layer: 'computed' }
    }
    case 'eeo_age_range': {
      const age = ageOn(p.date_of_birth, today)
      return age == null ? null : { value: age, layer: 'computed' }
    }
    case 'pronouns':
      return column(p.pronouns)
    case 'name_and_pronouns': {
      // "Feel free to share your preferred name and pronouns": what they set, nothing more.
      const called = p.preferred_name?.trim() || ''
      const pronouns = p.pronouns?.trim() || ''
      if (!called && !pronouns) return null
      return { value: [called || name.first, pronouns ? `(${pronouns})` : ''].filter(Boolean).join(' '), layer: 'computed' }
    }

    // Location
    case 'address_line1':
      return column(p.address_line1)
    case 'address_line2':
      return column(p.address_line2)
    case 'postal_code':
      return column(p.postal_code)
    case 'region':
      return column(p.region)
    case 'city':
      return column(p.city) ?? column(p.location?.split(',')[0]?.trim(), 'computed')
    case 'full_address': {
      if (!p.address_line1?.trim()) return null
      const country = countryByCode(p.country)?.name
      const parts = [p.address_line1, p.address_line2, p.city, [p.region, p.postal_code].filter(Boolean).join(' '), country]
      return column(parts.map((part) => part?.trim()).filter(Boolean).join(', '), 'computed')
    }
    case 'current_location': {
      if (present(p.location)) return column(p.location)
      const composed = [p.city, p.region, countryByCode(p.country)?.name].filter((part) => part?.trim()).join(', ')
      return column(composed, 'computed')
    }
    case 'country_of_residence':
      return p.country ? countryValue(p.country, 'identity') : countryValue(countryFromLocation(p.location), 'computed')
    case 'located_in_region': {
      // "Are you located in the US?" / "Do you reside in one of: BC, Alberta…"
      const asked = regionInText(text)
      const home = homeCountry(p)
      if (asked && home) {
        const inside = asked === home || (asked === 'EU' && EU_MEMBERS.has(home))
        return { value: inside, layer: 'computed' }
      }
      const places = [p.region, p.city].map((place) => place?.trim()).filter((place): place is string => Boolean(place && place.length > 2))
      if (places.some((place) => new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) {
        return { value: true, layer: 'computed' }
      }
      return null
    }

    // Documents
    case 'resume':
      return ctx.documents?.resume ? { value: 'resume', layer: 'resume' } : null
    case 'cover_letter':
      return ctx.documents?.coverLetter ? { value: 'cover-letter', layer: 'resume' } : null

    // Education
    case 'education_school':
    case 'education_degree':
    case 'education_field':
    case 'education_end_year': {
      const school = schoolsNewestFirst(resume?.education ?? [])[entryIndex]
      if (!school) return null
      if (field.key === 'education_school') return column(school.school, 'resume')
      if (field.key === 'education_degree') return column(school.degree, 'resume')
      if (field.key === 'education_field') return column(fieldOfStudy(school.degree), 'resume')
      const year = graduationYear(school)
      return year == null ? null : { value: String(year), layer: 'resume' }
    }
    case 'highest_education': {
      const level = highestDegree(resume?.education ?? [])
      return level ? { value: DEGREE_LABELS[level], layer: 'computed' } : null
    }
    case 'has_high_school_diploma': {
      // Any degree past school implies the diploma; nothing on the CV says nothing.
      const level = highestDegree(resume?.education ?? [])
      return degreeAtLeast(level, 'high_school') ? { value: true, layer: 'computed' } : null
    }
    case 'has_bachelors': {
      const level = highestDegree(resume?.education ?? [])
      return degreeAtLeast(level, 'bachelor') ? { value: true, layer: 'computed' } : null
    }

    // Experience
    case 'employment_company':
    case 'employment_title':
    case 'employment_start_month':
    case 'employment_start_year':
    case 'employment_end_month':
    case 'employment_end_year':
    case 'employment_current': {
      const job = jobsNewestFirst(resume?.experience ?? [], today)[entryIndex]
      if (!job) return null
      if (field.key === 'employment_company') return column(job.company, 'resume')
      if (field.key === 'employment_title') return column(job.jobTitle, 'resume')
      const end = parseCvDate(job.endDate)
      if (field.key === 'employment_current') return { value: end === 'present' || (!job.endDate?.trim() && Boolean(parseCvDate(job.startDate))), layer: 'resume' }
      const date = field.key.startsWith('employment_start') ? parseCvDate(job.startDate) : end
      if (!date || date === 'present') return null
      if (field.key.endsWith('_year')) return { value: String(date.year), layer: 'resume' }
      return date.month ? { value: MONTH_NAMES[date.month - 1], layer: 'resume' } : null
    }
    case 'current_employer':
      return column(currentJob(resume?.experience ?? [], today)?.company, 'resume')
    case 'current_title':
      return column(currentJob(resume?.experience ?? [], today)?.jobTitle, 'resume')
    case 'years_experience': {
      const years = yearsOfExperience(resume?.experience ?? [], today)
      return years == null ? null : { value: years, layer: 'computed' }
    }
    case 'skills':
      return column(resume?.skills, 'resume')
    case 'languages_spoken':
      return resume?.languages?.length ? { value: resume.languages.join(', '), layer: 'resume' } : null
    case 'professional_summary':
      return column(resume?.summary, 'resume')
    case 'previously_employed_here': {
      // Only a yes is read off the CV: a CV that does not list the employer
      // is not proof the applicant never worked there.
      const worked = (resume?.experience ?? []).some((job) => job.company && namesCompany(job.company, ctx.company))
      return worked ? { value: true, layer: 'resume' } : null
    }
    case 'notice_period':
      return p.notice_period_days == null ? null : { value: String(p.notice_period_days), layer: 'identity' }
    case 'earliest_start_date':
      return column(p.earliest_start_date)
    case 'desired_salary':
      return p.desired_salary == null ? null : { value: `${p.desired_salary} ${p.desired_salary_currency}`, layer: 'identity' }

    // Work authorization
    case 'work_authorized':
    case 'requires_sponsorship':
    case 'work_authorized_without_sponsorship':
    case 'open_to_contractor': {
      const { region } = detectRegion(text, ctx.job?.location)
      const attribute: AuthAttribute =
        field.key === 'requires_sponsorship' ? 'needs_sponsorship' : field.key === 'open_to_contractor' ? 'open_to_contractor_eor' : 'authorized'
      if (field.key === 'work_authorized_without_sponsorship') {
        const authorized = authAttribute(ctx, region, 'authorized')
        const needs = authAttribute(ctx, region, 'needs_sponsorship')
        if (authorized?.value === false || needs?.value === true) return { value: false, layer: 'identity', region }
        if (authorized?.value === true && needs?.value === false) return { value: true, layer: authorized.layer, region }
        return null
      }
      const found = authAttribute(ctx, region, attribute)
      if (found) return { ...found, region }
      // Before the per-country table: the single profile answer, but only for
      // a question that names no country — "do you need sponsorship" asked of
      // the one place the user once answered for.
      const rows = ctx.profile.work_authorizations ?? []
      if (!region && rows.length === 0) {
        if (field.key === 'requires_sponsorship' && p.requires_sponsorship != null) return { value: p.requires_sponsorship, layer: 'identity', region }
        if (field.key === 'work_authorized') return column(p.work_authorization)
      }
      return null
    }
    case 'citizenship': {
      const codes = p.citizenship ?? []
      if (codes.length === 1) return countryValue(codes[0], 'identity')
      const names = codes.map((code) => countryByCode(code)?.name).filter(Boolean) as string[]
      return names.length ? { value: names.join(', '), layer: 'identity' } : null
    }

    // Links
    case 'linkedin_url':
      return column(p.linkedin_url)
    case 'github_url':
      return column(p.github_url)
    case 'portfolio_url':
      return column(p.portfolio_url)
    case 'twitter_url':
      return column(p.twitter_url)
    case 'other_website':
      return column(p.other_url)

    default:
      return null
  }
}

// ── EEO ───────────────────────────────────────────────────────────────────

function resolveEeo(field: CanonicalField, ctx: ResolveContext, classification: Classification, question: QuestionShape, mode: AutofillMode): Resolution {
  const stated = ctx.profile.eeo_answers?.[field.key]
  // The age range is computed, but only offered once the user switched it on.
  if (field.key === 'eeo_age_range' && mode === 'autofill') {
    const direct = directValue(field, ctx, question, 0)
    if (direct) return { classification, value: direct.value, layer: 'computed' }
  }
  if (stated == null) {
    // Never set up: the user answers it, on the form, themselves.
    return none(classification, 'eeo_unset')
  }
  if (stated === EEO_DECLINE || mode !== 'autofill') {
    // Declining means choosing the form's own "decline" option. A form that
    // offers none (or a typeahead whose list is not known yet) is left blank,
    // which on an optional question is the same thing.
    const decline = findDeclineOption(question.options)
    return decline
      ? { classification, value: decline, layer: 'identity', decline: true }
      : none(classification, 'mode_blank', { decline: true })
  }
  return { classification, value: stated, layer: 'identity' }
}

// ── The resolver ──────────────────────────────────────────────────────────

/**
 * Resolve one question to a value from the user's data, or say why not.
 * The value is raw — `coerceToQuestion` fits it to the control.
 */
export function resolveQuestion(
  question: QuestionShape & { eeo?: boolean; consent?: boolean },
  ctx: ResolveContext,
  /** A classification made elsewhere — the agent pass's cache or model. */
  forced?: Classification | null,
): Resolution {
  const classification = forced ?? classifyQuestion(question, ctx.company)
  const field = classification?.field
  const fingerprint = fingerprintQuestion(question.label, ctx.company)
  const jobId = ctx.job?.id ?? undefined

  if (question.consent || field?.sensitivity === 'consent') return none(classification, 'consent')
  const mode = field ? effectiveMode(field, ctx.profile.field_modes) : 'autofill'

  if (field?.sensitivity === 'eeo' || question.eeo) {
    if (!field || field.sensitivity !== 'eeo') return none(classification, 'eeo_unset')
    return resolveEeo(field, ctx, classification!, question, mode)
  }

  // What the applicant once wrote about another employer stays there.
  const namesEmployer = namesCompany(question.label, ctx.company)
  const bank = namesEmployer ? {} : (ctx.profile.custom_answers ?? {})
  const meta = ctx.profile.answer_meta ?? {}

  if (mode === 'ask') return none(classification, 'mode_ask')
  if (mode === 'decline_or_blank') {
    // Still honour what the user wrote for this exact question: blank means
    // "don't make something up", not "ignore what I told you".
    const own = bank[fingerprint]
    if (own && userOwned(meta[fingerprint]) && usableHere(meta[fingerprint], field, jobId)) {
      return { classification, value: own, layer: 'question', bankKey: fingerprint }
    }
    return none(classification, 'mode_blank')
  }

  // 1b. An answer kept for this job alone (it names the employer, or the
  // field depends on it) — given earlier in this application's life.
  const fullBank = ctx.profile.custom_answers ?? {}
  const scopedKey = jobId ? jobFingerprint(fingerprint, jobId) : null
  if (scopedKey && fullBank[scopedKey]) {
    return { classification, value: fullBank[scopedKey], layer: userOwned(meta[scopedKey]) ? 'question' : 'answer_bank', bankKey: scopedKey }
  }

  // 2. The user's own answer to this exact wording.
  const own = bank[fingerprint]
  if (own && userOwned(meta[fingerprint]) && usableHere(meta[fingerprint], field, jobId)) {
    return { classification, value: own, layer: 'question', bankKey: fingerprint }
  }

  if (field) {
    // 3. A resume profile's override.
    // A salary is restated in the period the form asks for (monthly → annual).
    const asked = `${question.label} ${question.description ?? ''}`
    const inPeriod = (value: RawValue): RawValue => (field.key === 'desired_salary' && typeof value === 'string' ? salaryForQuestion(value, asked) : value)
    const override = ctx.overrides?.[field.key]
    if (present(override)) return { classification, value: inPeriod(override), layer: 'override' }

    // 4–6. Identity, computed, resume.
    const direct = directValue(field, ctx, question, classification!.entryIndex ?? 0)
    if (direct) {
      return {
        classification,
        value: inPeriod(direct.value),
        layer: direct.layer,
        ...(direct.countryCode ? { countryCode: direct.countryCode } : {}),
        ...(field.perRegion ? { region: direct.region ?? detectRegion(`${question.label} ${question.description ?? ''}`, ctx.job?.location).region } : {}),
      }
    }

    // 7a. The bank, by canonical field. A question naming the employer may
    // still take a field-level answer ("How did you hear about Acme?" →
    // "LinkedIn"): per-employer fields only ever match their own job's entry.
    const byField = bankByField(ctx, field)
    if (byField) return { classification, value: byField.value, layer: 'answer_bank', bankKey: byField.key }

    // 7a'. Nothing stored for "how did you hear", but the application says
    // which board the posting was found on: say so — the honest choice the
    // form offers, never a made-up one. Without it, the question is asked.
    if (field.key === 'referral_source' && ctx.job?.foundOn) {
      return { classification, value: boardReferral(question.options, ctx.job.foundOn), layer: 'computed' }
    }
  }

  // 7b. The bank, by near-identical wording. An agent answer still waiting for
  // review is offered here too: it is the user's data until they say otherwise.
  const exactAgent = bank[fingerprint]
  if (exactAgent && usableHere(meta[fingerprint], field, jobId)) {
    return { classification, value: exactAgent, layer: 'answer_bank', bankKey: fingerprint }
  }
  if (!field?.perEmployer) {
    const similar = findSimilarAnswer(fingerprint, bank)
    if (similar) return { classification, value: similar.value, layer: 'answer_bank', bankKey: similar.key }
  }

  return none(classification, field ? 'no_data' : 'unmapped', field?.perRegion ? { region: detectRegion(`${question.label} ${question.description ?? ''}`, ctx.job?.location).region } : {})
}

/** The registry field for a key, for callers holding a key from storage. */
export const registryField = fieldByKey

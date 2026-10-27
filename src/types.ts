/** The posting being applied to. */
export interface JobRow {
  id: string
  company: string
  role: string
  location: string
  apply_url: string
  source_id: string | null
  /** 'greenhouse' | 'ashby' | 'lever' when the fill engine has a driver for its form; '' otherwise. */
  ats: string
  /** '<board slug>:<posting id>'. */
  ats_job_id: string
  /** The job board the applicant found it on, when they did. Answers "How did you hear about us?". */
  found_on?: string | null
}

/** Everything the applicant has on file, as the resolver reads it. */
export interface ApplicationProfile {
  client_key: string
  full_name: string
  email: string
  phone: string
  location: string
  linkedin_url: string
  portfolio_url: string
  github_url: string
  work_authorization: string
  requires_sponsorship: boolean | null
  notice_period_days: number | null
  desired_salary: number | null
  desired_salary_currency: string
  earliest_start_date: string | null
  custom_answers: Record<string, string>
  eeo: Record<string, string>

  // All optional: every resolver path treats a missing one as "not on file".
  first_name?: string
  middle_name?: string
  last_name?: string
  preferred_name?: string
  preferred_last_name?: string
  /** YYYY-MM-DD. */
  date_of_birth?: string | null
  /** As the user stated them; never inferred. */
  pronouns?: string
  address_line1?: string
  address_line2?: string
  city?: string
  region?: string
  postal_code?: string
  /** ISO 3166-1 alpha-2 country of residence. */
  country?: string
  /** '+62'. */
  phone_country_code?: string
  phone_national?: string
  /** ISO 3166-1 alpha-2 codes. */
  citizenship?: string[]
  twitter_url?: string
  other_url?: string
  /** One row per country or region (ISO2, or 'EU'). */
  work_authorizations?: WorkAuthorization[]
  /** Explicit EEO answers, keyed by registry category. 'decline' is a real
   * answer. A category with no entry was never set up and is left to the user. */
  eeo_answers?: Record<string, string>
  /** Per-field autofill mode, keyed by canonical field key. */
  field_modes?: Record<string, 'autofill' | 'ask' | 'decline_or_blank'>
  /** Where each answer-bank entry came from, keyed by fingerprint. Entries
   * absent here were typed by the user. */
  answer_meta?: Record<string, AnswerMeta>
}

export interface WorkAuthorization {
  /** ISO 3166-1 alpha-2, or 'EU'. */
  region: string
  authorized: boolean | null
  needs_sponsorship: boolean | null
  open_to_contractor_eor: boolean | null
}

export interface AnswerMeta {
  source: 'user' | 'profile' | 'agent'
  /** The canonical field the answered question mapped to. */
  fieldKey?: string | null
  /** Set for an answer that belongs to one job only. */
  jobId?: string | null
  /** Agent answers: waiting for the user, or seen by them. */
  reviewState?: 'pending' | 'approved' | 'corrected' | null
}

/** What the resolver reads off the CV the application is built on. */
export interface ResumeFacts {
  summary: string
  skills: string
  experience: Array<{ company: string; jobTitle: string; startDate?: string; endDate?: string; isVisible?: boolean; bullets?: string[] }>
  education: Array<{ school: string; degree: string; year?: string; details?: string; isVisible?: boolean }>
  languages: string[]
}

export interface ApplyContext {
  job: JobRow
  profile: ApplicationProfile
  /** Rendered from the tailored resume. */
  resumePdf: Buffer
  coverLetterText: string
  resumeFileName: string
  /** The CV behind resumePdf, read for the fields a form asks of it. */
  resume?: ResumeFacts | null
  /** Values the chosen resume profile sets, by canonical key (fields/registry.ts). */
  overrides?: Record<string, string | boolean | number | string[]>
}

export type ApplyQuestionType = 'text' | 'textarea' | 'select' | 'multiselect' | 'boolean' | 'file' | 'date'

/**
 * What a question is about, set only where the form's own structure says so —
 * Greenhouse marks its equal-opportunity survey and its data-protection
 * consents as separate blocks. Nothing here is inferred from wording.
 *
 * Both kinds are the applicant's alone to answer: they are never pre-filled
 * from the profile or the answer bank.
 */
export type ApplyQuestionKind = 'eeo' | 'consent'

export interface ApplyQuestion {
  /** The form's own field id. */
  id: string
  label: string
  type: ApplyQuestionType
  required: boolean
  options?: string[]
  /** Set when we matched this to a stored answer. */
  answer?: string | string[] | boolean | null
  /** Help text shown under the label. On some forms it carries the actual
   * question, or an instruction such as "do not tick this box". */
  description?: string
  kind?: ApplyQuestionKind
  /** A question only the applicant can answer, in person (a recorded video):
   * never filled or drafted, and while required it blocks submission. */
  manual?: boolean
  /** `eeo` only: the option that declines to answer, when the form offers one. */
  declineOption?: string
}

/**
 * Who carries an application to the employer.
 * - `api`: an ATS endpoint (not part of this package).
 * - `extension`: the applicant's own browser, filled by an extension; they press submit.
 * - `browser`: a browser driven by the agent.
 * - `assisted`: the applicant, by hand, with the agent's answers to copy.
 */
export type ApplyExecutor = 'api' | 'extension' | 'browser' | 'assisted'

export type AttemptStatus =
  | 'queued'
  | 'preparing'
  | 'needs_input'
  | 'awaiting_approval'
  /** Every gate passed; waiting for an executor to pick it up. */
  | 'ready'
  | 'submitting'
  /** Handed to the applicant to finish: a bot check, or another reason in blocked_reason. */
  | 'blocked'
  /** Submit was pressed and the page never confirmed either way. */
  | 'unconfirmed'
  | 'submitted'
  | 'failed'
  | 'abandoned'

/** Split '<board slug>:<posting id>'. Null when it is empty or malformed. */
export function splitAtsJobId(value: string): { board: string; jobId: string } | null {
  const index = value.indexOf(':')
  if (index <= 0) return null
  const board = value.slice(0, index)
  const jobId = value.slice(index + 1)
  if (!board || !jobId) return null
  return { board, jobId }
}

// ── Targeting (what Autopilot looks for, per resume profile) ────────────────

export const SENIORITIES = ['', 'junior', 'mid', 'senior', 'lead', 'principal'] as const
export type Seniority = (typeof SENIORITIES)[number]

export const REMOTE_PREFERENCES = ['any', 'remote', 'hybrid', 'onsite'] as const
export type RemotePreference = (typeof REMOTE_PREFERENCES)[number]

export interface ProfileTargeting {
  targetTitles: string[]
  mustHaveSkills: string[]
  niceToHaveSkills: string[]
  seniority: Seniority
  remotePreference: RemotePreference
  locations: string[]
  salaryFloor: number | null
  salaryFloorCurrency: string
  excludedCompanies: string[]
  excludedKeywords: string[]
}

import { COUNTRIES, countryByCode, type Country } from './countries.js'

/**
 * Values derived from other values: a first name from a full name, an
 * international phone number from a local one, an age from a birth date,
 * years of experience from the dates on a CV.
 *
 * Every function here answers only from what it is given and returns null
 * when that is not enough. A guess presented as a derivation is still a
 * guess, and it is the applicant who is caught out by it.
 */

// ── Names ─────────────────────────────────────────────────────────────────

/** "Ada King Lovelace" → first "Ada", middle "King", last "Lovelace". A
 * one-word name has no last name, rather than repeating the first. */
export function splitName(fullName: string): { first: string; middle: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', middle: '', last: '' }
  if (parts.length === 1) return { first: parts[0], middle: '', last: '' }
  return { first: parts[0], middle: parts.slice(1, -1).join(' '), last: parts[parts.length - 1] }
}

// ── Phone ─────────────────────────────────────────────────────────────────

export interface PhoneParts {
  /** '+6281234567890' */
  e164: string
  /** '+62' */
  countryCode: string
  /** '81234567890', without the trunk 0. */
  national: string
  /** The country the code belongs to, when only one country uses it. */
  country: Country | null
}

const DIALS = [...new Set(COUNTRIES.map((country) => country.dial))].sort((a, b) => b.length - a.length)

/** Countries sharing +1 or +7 are told apart only by the user saying which. */
function countryForDial(dial: string, preferred?: string | null): Country | null {
  const matches = COUNTRIES.filter((country) => country.dial === dial)
  const chosen = preferred ? matches.find((country) => country.code === preferred.toUpperCase()) : undefined
  if (chosen) return chosen
  if (dial === '1') return matches.find((country) => country.code === 'US') ?? null
  return matches.length === 1 ? matches[0] : null
}

/**
 * Split a phone number into its international parts.
 *
 * A number written with its "+code" says its own country. One written
 * locally ("0812 3456 7890") needs the country the user lives in to be read
 * at all — without it, this returns null rather than assuming one.
 */
export function parsePhone(
  raw: string,
  options: { countryCode?: string | null; homeCountry?: string | null } = {},
): PhoneParts | null {
  const text = raw.trim()
  if (!text) return null
  const digits = text.replace(/[^\d+]/g, '')

  let international = ''
  if (digits.startsWith('+')) international = digits.slice(1)
  else if (digits.startsWith('00')) international = digits.slice(2)

  if (international) {
    const explicit = options.countryCode?.replace(/\D/g, '')
    const dial = explicit && international.startsWith(explicit) ? explicit : DIALS.find((code) => international.startsWith(code))
    if (!dial) return null
    const national = international.slice(dial.length).replace(/^0/, '')
    if (national.length < 4) return null
    return { e164: `+${dial}${national}`, countryCode: `+${dial}`, national, country: countryForDial(dial, options.homeCountry) }
  }

  const dial = options.countryCode?.replace(/\D/g, '') || countryByCode(options.homeCountry)?.dial
  if (!dial) return null
  const national = digits.replace(/^0+/, '')
  if (national.length < 4) return null
  return { e164: `+${dial}${national}`, countryCode: `+${dial}`, national, country: countryForDial(dial, options.homeCountry) }
}

// ── Age ───────────────────────────────────────────────────────────────────

/** Whole years between a YYYY-MM-DD birth date and `today`, or null. */
export function ageOn(dateOfBirth: string | null | undefined, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth ?? '')
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  let age = today.getUTCFullYear() - year
  const beforeBirthday =
    today.getUTCMonth() + 1 < month || (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)
  if (beforeBirthday) age -= 1
  return age >= 0 && age < 130 ? age : null
}

// ── CV dates ──────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** A month on a CV: { year, month 1–12 }. `month` is null when only the year
 * is written. `present` for "Present", "Current", "Now". */
export type CvDate = { year: number; month: number | null } | 'present'

/** Read "Jan 2020", "January 2020", "2020-01", "01/2020", "2020" or "Present". */
export function parseCvDate(raw: string | null | undefined): CvDate | null {
  const text = (raw ?? '').trim().toLowerCase()
  if (!text) return null
  if (/^(present|current|now|today|ongoing)$/.test(text)) return 'present'

  let match = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(text)
  if (match) return validMonth(Number(match[1]), Number(match[2]))
  match = /^(\d{1,2})[-/.](\d{4})$/.exec(text)
  if (match) return validMonth(Number(match[2]), Number(match[1]))
  match = /^([a-z]{3,9})\.?,?\s+(\d{4})$/.exec(text)
  if (match) {
    const month = MONTHS.indexOf(match[1].slice(0, 3)) + 1
    return month > 0 ? validMonth(Number(match[2]), month) : null
  }
  match = /^(\d{4})$/.exec(text)
  if (match) return { year: Number(match[1]), month: null }
  return null
}

function validMonth(year: number, month: number): CvDate | null {
  return month >= 1 && month <= 12 && year > 1900 ? { year, month } : null
}

/** Months since year 0, rounding a year-only start to January and a
 * year-only end to December, so "2019 – 2020" counts as two years. */
function monthIndex(date: CvDate, today: Date, edge: 'start' | 'end'): number {
  if (date === 'present') return today.getUTCFullYear() * 12 + today.getUTCMonth()
  const month = date.month ?? (edge === 'start' ? 1 : 12)
  return date.year * 12 + (month - 1)
}

// ── Experience from the CV ────────────────────────────────────────────────

export interface CvJob {
  company: string
  jobTitle: string
  startDate?: string
  endDate?: string
  isVisible?: boolean
}

export interface CvSchool {
  school: string
  degree: string
  year?: string
  details?: string
  isVisible?: boolean
}

/**
 * Total years of work, counting overlapping jobs once. Only jobs with a
 * readable start date count; one with no end date is taken to be over at its
 * start (we do not stretch it to today). Null when no job has dates at all.
 */
export function yearsOfExperience(jobs: CvJob[], today: Date): number | null {
  const spans: Array<[number, number]> = []
  for (const job of jobs) {
    const start = parseCvDate(job.startDate)
    if (!start || start === 'present') continue
    const end = parseCvDate(job.endDate) ?? start
    const from = monthIndex(start, today, 'start')
    const to = monthIndex(end, today, 'end')
    if (to >= from) spans.push([from, to + 1])
  }
  if (spans.length === 0) return null
  spans.sort((a, b) => a[0] - b[0])
  let months = 0
  let [current, until] = spans[0]
  for (const [from, to] of spans.slice(1)) {
    if (from <= until) until = Math.max(until, to)
    else {
      months += until - current
      ;[current, until] = [from, to]
    }
  }
  months += until - current
  return Math.floor(months / 12)
}

/** The job a form means by "current or most recent": an ongoing one if any,
 * else the one that ended last, else the first listed (CVs list newest first). */
export function currentJob(jobs: CvJob[], today: Date): CvJob | null {
  const real = jobs.filter((job) => job.isVisible !== false && (job.company.trim() || job.jobTitle.trim()))
  if (real.length === 0) return null
  const ongoing = real.find((job) => parseCvDate(job.endDate) === 'present' || (!job.endDate?.trim() && parseCvDate(job.startDate)))
  if (ongoing) return ongoing
  const dated = real
    .map((job) => ({ job, end: parseCvDate(job.endDate) }))
    .filter((entry): entry is { job: CvJob; end: Exclude<CvDate, 'present'> } => Boolean(entry.end) && entry.end !== 'present')
    .sort((a, b) => monthIndex(b.end, today, 'end') - monthIndex(a.end, today, 'end'))
  return dated[0]?.job ?? real[0]
}

/** Jobs newest first, the order employment-history blocks are filled in. */
export function jobsNewestFirst(jobs: CvJob[], today: Date): CvJob[] {
  const real = jobs.filter((job) => job.isVisible !== false && (job.company.trim() || job.jobTitle.trim()))
  return real
    .map((job, index) => ({ job, index, start: parseCvDate(job.startDate) }))
    .sort((a, b) => {
      const as = a.start ? monthIndex(a.start, today, 'start') : -1
      const bs = b.start ? monthIndex(b.start, today, 'start') : -1
      return bs - as || a.index - b.index
    })
    .map((entry) => entry.job)
}

export type DegreeLevel = 'high_school' | 'associate' | 'bachelor' | 'master' | 'doctorate'

const DEGREE_LEVELS: Array<{ level: DegreeLevel; pattern: RegExp }> = [
  { level: 'doctorate', pattern: /\b(ph\.?\s?d|doctor(ate)?|d\.?phil|ed\.?d)\b/i },
  { level: 'master', pattern: /\b(master'?s?|m\.?sc?|m\.?a\.?|mba|m\.?eng|m\.?tech|meng|mphil|magister|s2)\b/i },
  { level: 'bachelor', pattern: /\b(bachelor'?s?|b\.?sc?|b\.?a\.?|b\.?eng|b\.?tech|beng|btech|licenciatura|sarjana|s1|undergraduate degree)\b/i },
  { level: 'associate', pattern: /\b(associate'?s?|a\.?a\.?s?|diploma|d3)\b/i },
  { level: 'high_school', pattern: /\b(high school|secondary school|ged|sma|smk|a[- ]levels?)\b/i },
]
const RANK: Record<DegreeLevel, number> = { high_school: 1, associate: 2, bachelor: 3, master: 4, doctorate: 5 }

export function degreeLevel(degree: string): DegreeLevel | null {
  return DEGREE_LEVELS.find(({ pattern }) => pattern.test(degree))?.level ?? null
}

/** The highest degree level on the CV, or null when none can be read. */
export function highestDegree(schools: CvSchool[]): DegreeLevel | null {
  let best: DegreeLevel | null = null
  for (const school of schools) {
    const level = degreeLevel(`${school.degree} ${school.details ?? ''}`)
    if (level && (!best || RANK[level] > RANK[best])) best = level
  }
  return best
}

export function degreeAtLeast(level: DegreeLevel | null, floor: DegreeLevel): boolean {
  return level != null && RANK[level] >= RANK[floor]
}

/** Schools newest first, by graduation year where given. */
export function schoolsNewestFirst(schools: CvSchool[]): CvSchool[] {
  const real = schools.filter((school) => school.isVisible !== false && (school.school.trim() || school.degree.trim()))
  return real
    .map((school, index) => ({ school, index, year: graduationYear(school) ?? -1 }))
    .sort((a, b) => b.year - a.year || a.index - b.index)
    .map((entry) => entry.school)
}

/** The last four-digit year in "2016 – 2020" or "2020". */
export function graduationYear(school: Pick<CvSchool, 'year'>): number | null {
  const years = (school.year ?? '').match(/\b(19|20)\d{2}\b/g)
  return years ? Number(years[years.length - 1]) : null
}

/** "BSc Computer Science" → "Computer Science"; "Bachelor of Arts in History" → "History". */
export function fieldOfStudy(degree: string): string {
  const of = /\b(?:in|of)\s+([A-Z][\w &,-]+)$/.exec(degree.trim())
  if (of && !/^(arts|science|engineering|technology|business administration)$/i.test(of[1].trim())) return of[1].trim()
  const after = /^(?:b\.?sc?|m\.?sc?|b\.?a|m\.?a|b\.?eng|m\.?eng|b\.?tech|m\.?tech|mba|ph\.?d|s1|s2)\.?\s+(.+)$/i.exec(degree.trim())
  return after ? after[1].trim() : ''
}

// ── Numeric options ───────────────────────────────────────────────────────

/**
 * The option a number falls in: "6-9 years" for 7, "10+ years" for 12,
 * "Less than 2 years" for 1, "Under 30" / "60 or older" for ages.
 * Null when no option reads as a range, or more than one contains the number.
 */
export function numericOption(options: string[], value: number): string | null {
  const hits = options.filter((option) => {
    const text = option.toLowerCase().replace(/,/g, '')
    let match = /(\d+)\s*(?:-|–|to)\s*(\d+)/.exec(text)
    if (match) return value >= Number(match[1]) && value <= Number(match[2])
    match = /(\d+)\s*\+|(\d+)\s*(?:years? )?(?:or|and) (?:more|older|above|over)|(?:more than|over|above|at least)\s*(\d+)/.exec(text)
    if (match) {
      const floor = Number(match[1] ?? match[2] ?? match[3])
      return /more than|over|above/.test(text) && !/or more|or older|and above|and over/.test(text) ? value > floor : value >= floor
    }
    match = /(?:less than|under|fewer than|below)\s*(\d+)/.exec(text)
    if (match) return value < Number(match[1])
    match = /^(\d+)(?:\s*years?)?$/.exec(text.trim())
    if (match) return value === Number(match[1])
    return false
  })
  return hits.length === 1 ? hits[0] : null
}

import type { PostingRef } from 'ats-form-fill'

/**
 * Where an apply link leads, read from its address alone. Pure, so the
 * selection planner and the executor decide the same way, and neither
 * of them pays for a browser to learn what the URL already says.
 *
 * The agent route is every posting with no fill-engine form. Measured in
 * Arkoo on 2026-10-21 (6,230 active postings): about two thirds were YC Work
 * at a Startup and HN threads, 16% aggregator copies behind the aggregator's
 * own login (LinkedIn, ZipRecruiter, Indeed), 6% remote boards that link out,
 * and about 10% large employers' careers sites, which put Workday's or
 * Oracle's per-employer account in front of the form.
 *
 * - `fill`: the address is a form our fill engine opens (Greenhouse, Lever,
 *   Ashby): carried by the normal executor run.
 * - `account`: the employer's ATS wants an account per employer before the
 *   form (Workday, Oracle Recruiting Cloud, Taleo, iCIMS, SuccessFactors).
 *   Autopilot does not create accounts: handed back.
 * - `login`: a site that wants the applicant's own login there (an
 *   aggregator, YC's Work at a Startup). Handed back.
 * - `listing`: a page that describes the job and links elsewhere to apply (a
 *   remote board, an HN thread). Worth following.
 * - `open`: anything else, usually the employer's own careers page. Worth
 *   opening; what it shows decides.
 */
export type ApplyTarget =
  | { kind: 'fill'; ref: PostingRef; host: string }
  | { kind: 'account'; system: AccountSystem; host: string }
  | { kind: 'login'; site: string; host: string }
  | { kind: 'listing'; site: string; host: string }
  | { kind: 'open'; host: string }
  | { kind: 'invalid'; host: '' }

export type AccountSystem = 'workday' | 'oracle' | 'taleo' | 'icims' | 'successfactors' | 'brassring'

/** Host suffixes of ATSs that put a per-employer account before the form. */
const ACCOUNT_HOSTS: Array<[RegExp, AccountSystem]> = [
  [/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)workday\.com$/, 'workday'],
  [/(^|\.)oraclecloud\.com$/, 'oracle'],
  [/(^|\.)taleo\.net$/, 'taleo'],
  [/(^|\.)icims\.com$/, 'icims'],
  [/(^|\.)successfactors\.(com|eu)$|^jobs\.sap\.com$/, 'successfactors'],
  [/(^|\.)brassring\.com$/, 'brassring'],
]

/** Sites whose apply step wants the applicant's own login there. */
const LOGIN_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)ziprecruiter\.(com|co\.uk)$/, 'ziprecruiter'],
  [/(^|\.)indeed\.com$/, 'indeed'],
  [/(^|\.)glassdoor\.(com|co\.uk)$/, 'glassdoor'],
  [/(^|\.)workatastartup\.com$/, 'workatastartup'],
  [/(^|\.)wellfound\.com$|(^|\.)angel\.co$/, 'wellfound'],
  [/(^|\.)dice\.com$/, 'dice'],
  [/(^|\.)monster\.com$/, 'monster'],
  [/(^|\.)clearancejobs\.com$/, 'clearancejobs'],
]

/** Pages that describe a job and link elsewhere to apply. */
const LISTING_HOSTS: Array<[RegExp, string]> = [
  [/^news\.ycombinator\.com$/, 'hn'],
  [/(^|\.)weworkremotely\.com$/, 'weworkremotely'],
  [/(^|\.)remoteok\.(com|io)$/, 'remoteok'],
  [/(^|\.)remotive\.(com|io)$/, 'remotive'],
  [/(^|\.)himalayas\.app$/, 'himalayas'],
  [/(^|\.)bebee\.com$/, 'bebee'],
  [/(^|\.)jobleads\.com$/, 'jobleads'],
  [/(^|\.)arbeitnow\.(com|fr)$/, 'arbeitnow'],
  [/(^|\.)jobicy\.com$/, 'jobicy'],
  [/(^|\.)learn4good\.com$/, 'learn4good'],
  [/(^|\.)trabajo\.org$/, 'trabajo'],
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The fill-engine form an address points at, or null. Understands the shapes
 * the boards publish: Greenhouse's board and embed URLs, Lever's and Ashby's
 * posting and apply pages.
 */
export function refFromUrl(url: string): PostingRef | null {
  const parsed = parse(url)
  if (!parsed) return null
  const host = parsed.hostname.toLowerCase()
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))

  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (parts[0] === 'embed') {
      const board = parsed.searchParams.get('for') ?? ''
      const token = parsed.searchParams.get('token') ?? ''
      return board && /^\d+$/.test(token) ? { ats: 'greenhouse', board, jobId: token, applyUrl: url } : null
    }
    // /{board}/jobs/{id}
    if (parts.length >= 3 && parts[1] === 'jobs' && /^\d+$/.test(parts[2])) {
      return { ats: 'greenhouse', board: parts[0], jobId: parts[2], applyUrl: url }
    }
    return null
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    return parts.length >= 2 && UUID.test(parts[1]) ? { ats: 'lever', board: parts[0], jobId: parts[1], applyUrl: url } : null
  }
  if (host === 'jobs.ashbyhq.com') {
    return parts.length >= 2 && UUID.test(parts[1]) ? { ats: 'ashby', board: parts[0], jobId: parts[1], applyUrl: url } : null
  }
  return null
}

export function classifyApplyTarget(url: string): ApplyTarget {
  const parsed = parse(url)
  if (!parsed) return { kind: 'invalid', host: '' }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const ref = refFromUrl(url)
  if (ref) return { kind: 'fill', ref, host }
  for (const [pattern, system] of ACCOUNT_HOSTS) if (pattern.test(host)) return { kind: 'account', system, host }
  for (const [pattern, site] of LOGIN_HOSTS) if (pattern.test(host)) return { kind: 'login', site, host }
  for (const [pattern, site] of LISTING_HOSTS) if (pattern.test(host)) return { kind: 'listing', site, host }
  return { kind: 'open', host }
}

/** A target nothing in Autopilot can carry hands-free: the applicant files it. */
export function isWalled(target: ApplyTarget): target is Extract<ApplyTarget, { kind: 'account' | 'login' | 'invalid' }> {
  return target.kind === 'account' || target.kind === 'login' || target.kind === 'invalid'
}

/** The blocked_reason code for a walled target. */
export function wallCode(target: Extract<ApplyTarget, { kind: 'account' | 'login' | 'invalid' }>): 'account_required' | 'login_required' | 'unsupported' {
  if (target.kind === 'account') return 'account_required'
  if (target.kind === 'login') return 'login_required'
  return 'unsupported'
}

const SYSTEM_NAMES: Record<AccountSystem, string> = {
  workday: 'Workday',
  oracle: 'Oracle',
  taleo: 'Taleo',
  icims: 'iCIMS',
  successfactors: 'SuccessFactors',
  brassring: 'BrassRing',
}

const SITE_NAMES: Record<string, string> = {
  linkedin: 'LinkedIn',
  ziprecruiter: 'ZipRecruiter',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
  workatastartup: "YC's Work at a Startup",
  wellfound: 'Wellfound',
  dice: 'Dice',
  monster: 'Monster',
  clearancejobs: 'ClearanceJobs',
}

/** The hand-back sentence for a walled target, as the attempt's `error`. */
export function wallSentence(target: Extract<ApplyTarget, { kind: 'account' | 'login' | 'invalid' }>): string {
  if (target.kind === 'account') {
    return `This employer's ${SYSTEM_NAMES[target.system]} site wants you to create an account before applying, so Autopilot left it for you.`
  }
  if (target.kind === 'login') {
    return `This posting is applied to through ${SITE_NAMES[target.site] ?? target.host}, which needs you signed in there, so Autopilot left it for you.`
  }
  return 'This posting has no apply link Autopilot can open. Finish it yourself.'
}

/**
 * The best place to start from: a fill-engine form or the employer's own
 * page linked from the description beats an aggregator's copy. `candidates`
 * are the posting's apply_url first, then links found in its description.
 */
export function bestStart(candidates: string[]): { url: string; target: ApplyTarget } | null {
  const RANK: Record<ApplyTarget['kind'], number> = { fill: 0, open: 1, listing: 2, account: 3, login: 4, invalid: 5 }
  let best: { url: string; target: ApplyTarget } | null = null
  for (const url of candidates) {
    const target = classifyApplyTarget(url)
    if (target.kind === 'invalid') continue
    if (!best || RANK[target.kind] < RANK[best.target.kind]) best = { url, target }
  }
  return best
}

const LINK = /https?:\/\/[^\s"'<>()\]]+/gi

/** Links in a description that lead to a fill-engine form: the cheap resolution. */
export function formLinksIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.replace(/&#x2F;/gi, '/').replace(/&amp;/g, '&').matchAll(LINK)) {
    const url = match[0].replace(/[.,;:!?]+$/, '')
    if (refFromUrl(url)) found.add(url)
    if (found.size >= 5) break
  }
  return [...found]
}

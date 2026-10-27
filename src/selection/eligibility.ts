import type { NoulQuestion } from '../ai/decide.js'
import { countryByCode, EU_MEMBERS } from '../fields/countries.js'
import type { WorkAuthorization } from '../types.js'
import { countryOffsets, regionsInText } from './regions.js'

/**
 * Can this user actually be hired for this job? Selection's first gate, ahead
 * of any scoring: an application a company is not allowed to accept wastes
 * the user's time and their name with that employer.
 *
 * Two halves, both pure:
 *
 *   parseRestrictions(job)       what the posting says about where its hire
 *                                may live, be authorised, and work hours —
 *                                from the location field first, then the
 *                                description's own sentences
 *   evaluateEligibility(r, user) that against the user's country, their
 *                                per-country work-authorization rows (Field
 *                                Mapper) and their citizenship
 *
 * Regex and tables decide everything they can. What they cannot read — a
 * bare "Remote" with no word on where, or a sentence that sounds like a
 * restriction but names nothing we know — is `unknown` with `needsJev`, and
 * the planner may ask Jev one yes/no question about it (eligibilityQuestion),
 * cached per job and country.
 *
 * The rule throughout: never guess in the user's favour. A restriction we
 * cannot rule out is `unknown`, and unknown is never hands-free (it may be
 * shown for review). Work authorization is a legal answer, taken only from a
 * row the user filled in — never from where they live or their passport —
 * except where a posting asks for citizenship itself.
 */

export type Verdict = 'eligible' | 'ineligible' | 'unknown'

/** One place a posting says the work can be done from. */
export interface LocationOption {
  remote: boolean
  /** null = it doesn't say where (a bare "Remote"); 'anywhere' = worldwide. */
  countries: Set<string> | 'anywhere' | null
  label: string
}

export interface TimezoneRule {
  /** Allowed UTC offsets for the hire, in hours, inclusive. */
  min: number
  max: number
  label: string
}

export interface Restrictions {
  options: LocationOption[]
  /** The description says where the hire must be based (applies to remote options). */
  basedIn: { countries: Set<string>; label: string } | null
  /** The description says the job hires from anywhere. */
  worldwide: boolean
  /** "must be authorised to work in X": each entry is one demand, any country in it satisfies it. */
  workAuthIn: Array<{ countries: Set<string>; label: string }>
  /** The demand is for the job's own country ("in the country where this role is based"). */
  workAuthInJobCountry: boolean
  noSponsorship: boolean
  /** "US citizens only", security clearance, ITAR. */
  citizenship: Array<{ countries: Set<string>; label: string }>
  timezone: TimezoneRule | null
  /** Sentences that sound like a restriction but could not be read. Sent to Jev. */
  unparsed: string[]
  /** What each rule was read from, for the reason line. */
  evidence: string[]
}

export interface EligibilityJob {
  location: string
  is_remote: boolean
  /** Plain text or HTML; either is fine. */
  description?: string | null
  short_description?: string | null
}

export interface Applicant {
  /** ISO2 country of residence; null when unknown. */
  country: string | null
  citizenship: string[]
  workAuthorizations: WorkAuthorization[]
}

export interface EligibilityResult {
  verdict: Verdict
  /** Short, machine-made: 'remote US only; you are in ID'. */
  reasons: string[]
  /** Unknown, and Jev might settle it from the posting's text. */
  needsJev: boolean
  /** The rule that decided it, for the skip reason. */
  code:
    | 'anywhere'
    | 'in_region'
    | 'outside_region'
    | 'onsite_elsewhere'
    | 'onsite_maybe'
    | 'no_location'
    | 'bare_remote'
    | 'work_auth_missing'
    | 'work_auth_denied'
    | 'needs_sponsorship'
    | 'citizenship'
    | 'timezone_outside'
    | 'timezone_unknown'
    | 'country_unknown'
    | 'unparsed'
    | 'jev'
}

// ── Text helpers ─────────────────────────────────────────────────────────────

/** HTML to plain sentences. */
export function plainText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|br|tr)>|<br\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&[a-z]+;/g, ' ')
    // Dotted abbreviations would end a sentence half-way through a place.
    .replace(/\bU\.S\.A\.?(?![A-Za-z])/g, 'USA')
    .replace(/\bU\.S\.(?![A-Za-z])/g, 'US')
    .replace(/\bU\.K\.(?![A-Za-z])/g, 'UK')
    .replace(/\bE\.U\.(?![A-Za-z])/g, 'EU')
    .replace(/\s+/g, ' ')
    .trim()
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9"'(•·-])|\s+[•·]\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 3)
}

const label = (countries: Set<string>, fallback: string) =>
  countries.size > 0 && countries.size <= 3 ? [...countries].join('/') : fallback

// ── Location field ───────────────────────────────────────────────────────────

const REMOTE = /\b(?:remote|work from home|wfh|home[- ]based|telecommute|distributed|anywhere)\b/i
const WORLDWIDE = /\b(?:anywhere|worldwide|world[- ]?wide|global(?:ly)?|international|all countries|any location|location[- ]independent|fully distributed)\b/i
const NOT_A_PLACE = /^(?:remote|hybrid|on-?site|in[- ]office|office|flexible|multiple locations?|various|tbd|n\/?a|-|—)$/i

/** The location field, one option per place it lists. */
export function parseLocationField(location: string, isRemote: boolean): LocationOption[] {
  const parts = (location || '')
    .split(/\s*(?:\||;|\/(?!\s*hybrid)|·|\n|\bor\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean)
  const options: LocationOption[] = []
  for (const part of parts) {
    const mentioned = regionsInText(part)
    const saysRemote = REMOTE.test(part)
    const hybrid = /\bhybrid\b/i.test(part)
    const remote = !hybrid && (saysRemote || (isRemote && !/\b(?:on-?site|in[- ]office)\b/i.test(part)))
    if (mentioned.countries.size > 0) {
      options.push({ remote, countries: mentioned.countries, label: `${remote ? 'remote ' : ''}${label(mentioned.countries, mentioned.labels.join('/'))}` })
    } else if (WORLDWIDE.test(part) && !hybrid) {
      options.push({ remote: true, countries: 'anywhere', label: 'remote worldwide' })
    } else if (remote) {
      options.push({ remote: true, countries: null, label: 'remote' })
    } else if (!NOT_A_PLACE.test(part)) {
      // A place we don't know ("Springfield"): somewhere specific, but where?
      options.push({ remote: false, countries: null, label: part.slice(0, 40) })
    }
  }
  if (options.length === 0 && isRemote) options.push({ remote: true, countries: null, label: 'remote' })
  return options
}

// ── Description ──────────────────────────────────────────────────────────────

const PLACE_TAIL = String.raw`(?:the\s+)?([^.;:!?()\n]{2,90})`

const BASED_IN: RegExp[] = [
  new RegExp(String.raw`\b(?:must|should|need to|needs to|required to|have to|will need to|are required to)\s+(?:be\s+)?(?:currently\s+|physically\s+|permanently\s+)?(?:based|located|living|residing|reside|live|resident)\s+(?:in|within|inside)\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:only|exclusively)\s+(?:hiring|hire|recruiting|accepting|considering|open to|consider|accept)\s+(?:applications\s+from\s+|candidates\s+|applicants\s+|people\s+|talent\s+|residents\s+)?(?:who\s+(?:are|live)\s+)?(?:based\s+|located\s+|living\s+|residing\s+)?(?:in|within|from)\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:open|available)\s+(?:only\s+)?to\s+(?:candidates|applicants|residents|people|those|individuals)\s+(?:who\s+(?:are|live)\s+)?(?:based\s+|located\s+|living\s+|residing\s+)?(?:in|within|from)\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:candidates|applicants)\s+(?:must|should|need to)\s+(?:be\s+)?(?:based|located|living|residing)\s+(?:in|within)\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:fully\s+)?remote\s+(?:position\s+|role\s+|opportunity\s+)?(?:with)?in\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:remote|work)\s+from\s+anywhere\s+(?:with)?in\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:anywhere|any\s*where)\s+in\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:legal\s+)?residents?\s+of\s+${PLACE_TAIL}`, 'i'),
  new RegExp(String.raw`\b(?:this|the)\s+(?:role|position|job|opportunity)\s+is\s+(?:only\s+)?(?:open|available)\s+(?:to\s+candidates\s+)?(?:in|within)\s+${PLACE_TAIL}`, 'i'),
]
const BASED_ABBREV = /(?:^|[^A-Za-z])(US|U\.S\.|USA|UK|EU|EMEA|LATAM|APAC|Canada|Europe|India|Brazil)[- ]based\s+(?:candidates|applicants|only|remote|role|position|team members|talent|engineers?|developers?)\b/

const WORK_AUTH = new RegExp(
  String.raw`\b(?:authori[sz]ed|authori[sz]ation|eligible|eligibility|permitted|entitled|allowed|legally able|right)\s+to\s+work\s+(?:in|within|for)\s+${PLACE_TAIL}`,
  'i',
)
const WORK_AUTH_OTHER = new RegExp(String.raw`\bvalid\s+work\s+(?:permit|visa|authori[sz]ation)\s+(?:for|in)\s+${PLACE_TAIL}`, 'i')
const JOB_COUNTRY_TAIL = /^(?:the\s+)?(?:country|countries|location|region|place)\s+(?:where|in which|of)|^(?:this|that|your|the)\s+(?:country|location|region|role'?s?)\b|^where\s+(?:the|this)\s+(?:job|role|position)/i

const NO_SPONSOR = /\b(?:not|unable to|cannot|can't|won't|will not|do not|does not|don't|doesn't|no|nor|are not able to)\b[^.;]{0,45}\b(?:visa\s+)?sponsor(?:ship|ing|s)?\b|\bwithout\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+|any\s+|employer\s+|company\s+)?(?:visa\s+|employment\s+)?sponsorship\b|\bsponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided|possible)\b/i

const CITIZEN = /\b(US|U\.S\.|USA|United States|American|Canadian|UK|British|EU|Australian|German|French|Indian)\s+citizen(?:s|ship)?\b[^.;]{0,40}\b(?:only|required|must|necessary|mandatory)\b|\b(?:must|need to|required to)\s+(?:be\s+)?(?:a\s+)?(US|U\.S\.|United States|American|Canadian|UK|British|Australian)\s+citizen\b|\bcitizenship\s+(?:in|of)\s+(?:the\s+)?(US|U\.S\.|United States|Canada|UK|United Kingdom)\b[^.;]{0,30}\b(?:required|only|must)\b/i
const CLEARANCE = /\b(?:security\s+clearance|(?:secret|ts\/sci|top secret|public trust)\s+clearance|clearance\s+(?:is\s+)?required|ITAR|export[- ]controlled|U\.?S\.?\s+persons?\b)/i
const NATIONALITY: Record<string, string> = {
  us: 'US', 'u.s.': 'US', usa: 'US', 'united states': 'US', american: 'US', canadian: 'CA', canada: 'CA', uk: 'GB',
  british: 'GB', 'united kingdom': 'GB', australian: 'AU', german: 'DE', french: 'FR', indian: 'IN', eu: 'EU',
}

// Time zones a posting names, and the offsets they span.
const ZONES: Array<{ pattern: RegExp; min: number; max: number; label: string }> = [
  { pattern: /\b(?:US|U\.S\.|North American?|American|Eastern|Pacific|Central|Mountain|EST|EDT|PST|PDT|CST|CDT|MST|MDT|ET|PT|CT|MT)\b/, min: -8, max: -5, label: 'US hours' },
  { pattern: /\bAmericas\b/i, min: -8, max: -3, label: 'Americas hours' },
  { pattern: /\b(?:LATAM|Latin American?|South American?)\b/i, min: -6, max: -3, label: 'LATAM hours' },
  { pattern: /\b(?:UK|GMT|BST|British|London)\b/, min: 0, max: 1, label: 'UK hours' },
  { pattern: /\b(?:European|Europe|EU|CET|CEST|EET|Central European)\b/, min: 0, max: 2, label: 'European hours' },
  { pattern: /\bEMEA\b/, min: -1, max: 4, label: 'EMEA hours' },
  { pattern: /\b(?:APAC|Asian?|Asia[- ]Pacific|Australian|AEST|AEDT|SGT|IST|India)\b/, min: 5, max: 11, label: 'APAC hours' },
]
const ZONE_CONTEXT = /\b(?:time\s?zones?|timezones?|hours|business\s+hours|working\s+hours|work(?:ing)?\s+day)\b/i
const ZONE_DEMAND = /\b(?:overlap|within|in|during|align|aligned|compatible|across|available|work)\b/i

const OFFSET = String.raw`(?:UTC|GMT)\s*([+\-−–]\s*\d{1,2}(?:[:.]\d{2})?)`
const OFFSET_RANGE = new RegExp(String.raw`${OFFSET}\s*(?:to|-|–|—|and|through)\s*(?:UTC|GMT)?\s*([+\-−–]?\s*\d{1,2}(?:[:.]\d{2})?)`, 'i')
const OFFSET_PLUS_MINUS = new RegExp(String.raw`(?:${OFFSET}|\b(UTC|GMT|CET|EST|PST|ET|PT)\b)\s*(?:±|\+\/-|\+-|plus or minus)\s*(\d{1,2})\s*(?:hours?|hrs?|h)?\b`, 'i')
const OVERLAP_HOURS = /\b(?:at least|minimum(?: of)?|min\.?)?\s*(\d)\s*(?:\+\s*)?hours?\s+(?:of\s+)?overlap\b/i

const RESTRICTIONISH = /\b(?:based in|located in|reside|residen(?:t|ts|cy)|time\s?zones?|timezones?|authori[sz]ed to work|right to work|eligible to work|work permit|citizens?(?:hip)?|clearance|hiring (?:in|from)|only hire|countries|must (?:be )?(?:live|living) in)\b/i

function signedHours(raw: string): number {
  const clean = raw.replace(/[−–]/g, '-').replace(/\s+/g, '')
  const match = /^([+-]?)(\d{1,2})(?:[:.](\d{2}))?$/.exec(clean)
  if (!match) return NaN
  const value = Number(match[2]) + (match[3] ? Number(match[3]) / 60 : 0)
  return match[1] === '-' ? -value : value
}

const ZONE_CENTER: Record<string, number> = { UTC: 0, GMT: 0, CET: 1, EST: -5, ET: -5, PST: -8, PT: -8 }

function parseTimezone(sentence: string): TimezoneRule | null {
  const range = OFFSET_RANGE.exec(sentence)
  if (range) {
    const a = signedHours(range[1])
    const b = signedHours(range[2])
    if (Number.isFinite(a) && Number.isFinite(b)) return { min: Math.min(a, b), max: Math.max(a, b), label: range[0].trim() }
  }
  const pm = OFFSET_PLUS_MINUS.exec(sentence)
  if (pm) {
    const center = pm[1] ? signedHours(pm[1]) : (ZONE_CENTER[(pm[2] ?? '').toUpperCase()] ?? NaN)
    const tolerance = Number(pm[3])
    if (Number.isFinite(center) && Number.isFinite(tolerance)) {
      return { min: center - tolerance, max: center + tolerance, label: pm[0].trim() }
    }
  }
  if (!ZONE_CONTEXT.test(sentence) || !ZONE_DEMAND.test(sentence)) return null
  // A named zone: within its span, widened by what "overlap" allows. Eight
  // working hours each side; "4 hours overlap" leaves 4 hours of difference.
  const overlap = OVERLAP_HOURS.exec(sentence)
  const tolerance = overlap ? Math.max(0, 8 - Number(overlap[1])) : 3
  const near = sentence.match(new RegExp(`.{0,40}${ZONE_CONTEXT.source}`, 'i'))?.[0] ?? sentence
  for (const zone of ZONES) {
    if (zone.pattern.test(near)) return { min: zone.min - tolerance, max: zone.max + tolerance, label: zone.label }
  }
  return null
}

function nationalities(...captures: Array<string | undefined>): Set<string> {
  const countries = new Set<string>()
  for (const capture of captures) {
    const code = capture ? NATIONALITY[capture.toLowerCase()] : undefined
    if (code === 'EU') for (const member of EU_MEMBERS) countries.add(member)
    else if (code) countries.add(code)
  }
  return countries
}

/** Everything the posting says about who may be hired. */
export function parseRestrictions(job: EligibilityJob): Restrictions {
  const r: Restrictions = {
    options: parseLocationField(job.location, job.is_remote),
    basedIn: null,
    worldwide: false,
    workAuthIn: [],
    workAuthInJobCountry: false,
    noSponsorship: false,
    citizenship: [],
    timezone: null,
    unparsed: [],
    evidence: [],
  }
  const text = plainText(job.description) || plainText(job.short_description)
  for (const sentence of sentences(text)) {
    let understood = false
    const s = sentence.slice(0, 400)

    for (const pattern of BASED_IN) {
      const match = pattern.exec(s)
      if (!match) continue
      const tail = match[1]
      if (/^(?:the\s+)?(?:world|globe)\b|^any\s+(?:country|location)/i.test(tail)) {
        r.worldwide = true
        understood = true
        break
      }
      const found = regionsInText(tail)
      if (found.countries.size > 0) {
        r.basedIn = r.basedIn
          ? { countries: new Set([...r.basedIn.countries].filter((c) => found.countries.has(c))), label: r.basedIn.label }
          : { countries: found.countries, label: label(found.countries, found.labels.join('/')) }
        r.evidence.push(match[0].trim().slice(0, 120))
        understood = true
        break
      }
    }
    if (!understood) {
      const abbrev = BASED_ABBREV.exec(s)
      if (abbrev) {
        const found = regionsInText(abbrev[1])
        if (found.countries.size > 0) {
          r.basedIn = r.basedIn ?? { countries: found.countries, label: label(found.countries, abbrev[1]) }
          r.evidence.push(abbrev[0].trim())
          understood = true
        }
      }
    }
    if (!understood && /\b(?:work|hire|hiring|remote|recruit)\b[^.]{0,40}\b(?:from\s+anywhere|anywhere\s+in\s+the\s+world|worldwide|globally|regardless\s+of\s+(?:your\s+)?location)\b/i.test(s)) {
      r.worldwide = true
      understood = true
    }

    const auth = WORK_AUTH.exec(s) ?? WORK_AUTH_OTHER.exec(s)
    if (auth) {
      const tail = auth[1]
      if (JOB_COUNTRY_TAIL.test(tail)) {
        r.workAuthInJobCountry = true
        r.evidence.push(auth[0].trim().slice(0, 120))
        understood = true
      } else {
        const found = regionsInText(tail)
        if (found.countries.size > 0) {
          r.workAuthIn.push({ countries: found.countries, label: label(found.countries, found.labels.join('/')) })
          r.evidence.push(auth[0].trim().slice(0, 120))
          understood = true
        }
      }
    }

    if (NO_SPONSOR.test(s)) {
      r.noSponsorship = true
      understood = true
    }

    const citizen = CITIZEN.exec(s)
    if (citizen) {
      const countries = nationalities(citizen[1], citizen[2], citizen[3])
      if (countries.size > 0) {
        r.citizenship.push({ countries, label: `${label(countries, 'national')} citizens` })
        understood = true
      }
    }
    if (CLEARANCE.test(s)) {
      r.citizenship.push({ countries: new Set(['US']), label: 'US clearance/ITAR' })
      understood = true
    }

    const zone = parseTimezone(s)
    if (zone) {
      // Two rules: keep the narrower overlap.
      r.timezone = r.timezone ? { min: Math.max(r.timezone.min, zone.min), max: Math.min(r.timezone.max, zone.max), label: zone.label } : zone
      understood = true
    }

    if (!understood && RESTRICTIONISH.test(s)) r.unparsed.push(s.slice(0, 240))
  }
  r.unparsed = r.unparsed.slice(0, 6)
  return r
}

// ── Verdict ──────────────────────────────────────────────────────────────────

/** Rows covering a country: its own, or an EU-wide one for a member state. */
function rowsFor(rows: WorkAuthorization[], country: string): WorkAuthorization[] {
  const upper = country.toUpperCase()
  return rows.filter((row) => {
    const region = row.region.toUpperCase()
    return region === upper || (region === 'EU' && EU_MEMBERS.has(upper))
  })
}

/**
 * Does the user hold a stated authorization for any of `countries`? 'yes'
 * only from a row that says authorized; 'no' only when every row we have for
 * them says not; otherwise 'unknown'.
 */
function authorizedIn(
  rows: WorkAuthorization[],
  countries: Set<string>,
  noSponsorship: boolean,
): 'yes' | 'no' | 'needs_sponsorship' | 'unknown' {
  const matching = [...countries].flatMap((country) => rowsFor(rows, country))
  if (matching.some((row) => row.authorized === true && (!noSponsorship || row.needs_sponsorship === false))) return 'yes'
  if (noSponsorship && matching.some((row) => row.authorized === true && row.needs_sponsorship === true)) return 'needs_sponsorship'
  if (matching.length > 0 && matching.every((row) => row.authorized === false)) {
    return noSponsorship || matching.every((row) => row.needs_sponsorship !== false) ? 'no' : 'unknown'
  }
  return 'unknown'
}

const countryName = (code: string | null) => (code ? (countryByCode(code)?.name ?? code) : 'unknown')

/** What the user can be hired for, by the rules alone. */
export function evaluateEligibility(r: Restrictions, user: Applicant): EligibilityResult {
  const reasons: string[] = []
  const done = (verdict: Verdict, code: EligibilityResult['code'], reason: string, needsJev = false): EligibilityResult => ({
    verdict,
    code,
    reasons: [...reasons, reason],
    needsJev,
  })
  const country = user.country ? user.country.toUpperCase() : null

  // 1. Citizenship and clearance: hard gates, from the user's stated citizenship.
  for (const demand of r.citizenship) {
    const held = user.citizenship.some((code) => demand.countries.has(code.toUpperCase()))
    if (!held) return done('ineligible', 'citizenship', `${demand.label} required`)
    reasons.push(`${demand.label}: held`)
  }

  // 2. Where the work can be done from.
  const options = r.options
  // The description's "based in X" narrows every remote option; its "work from
  // anywhere" opens a bare "Remote".
  const remoteScope = (option: LocationOption): Set<string> | 'anywhere' | null => {
    let scope = option.countries
    if (scope === null && r.worldwide && !r.basedIn) scope = 'anywhere'
    if (r.basedIn) {
      if (scope === null || scope === 'anywhere') scope = r.basedIn.countries
      else scope = new Set([...scope].filter((c) => r.basedIn!.countries.has(c)))
    }
    return scope
  }

  const place: { verdict: Verdict; code: EligibilityResult['code']; reason: string; needsJev: boolean; remoteOk: boolean } = {
    verdict: 'ineligible',
    code: 'no_location',
    reason: 'the posting does not say where it hires',
    needsJev: true,
    remoteOk: false,
  }
  const rank: Record<Verdict, number> = { eligible: 2, unknown: 1, ineligible: 0 }
  const consider = (verdict: Verdict, code: EligibilityResult['code'], reason: string, jev: boolean, remote: boolean) => {
    // The best option wins; at equal standing the first one read stays.
    if (rank[verdict] > rank[place.verdict] || place.code === 'no_location') {
      place.verdict = verdict
      place.code = code
      place.reason = reason
      place.needsJev = jev
      place.remoteOk = remote && verdict === 'eligible'
    }
  }

  const effective = options.length > 0 ? options : r.basedIn ? [{ remote: true, countries: null, label: 'remote' } as LocationOption] : []
  if (effective.length === 0) {
    place.verdict = 'unknown'
  }
  for (const option of effective) {
    if (option.remote) {
      const scope = remoteScope(option)
      // The posting's own word for the place ("EMEA") where it is still the posting's scope.
      const where = (set: Set<string>) =>
        set === option.countries ? option.label.replace(/^remote /, '') : label(set, r.basedIn?.label ?? 'the named region')
      if (scope === 'anywhere') consider('eligible', 'anywhere', 'remote worldwide', false, true)
      else if (scope === null) consider('unknown', 'bare_remote', `"${option.label}" without saying where it hires`, true, false)
      else if (!country) consider('unknown', 'country_unknown', `remote ${where(scope)}; your country is not on file`, false, false)
      else if (scope.has(country)) consider('eligible', 'in_region', `remote ${where(scope)}, you are in ${country}`, false, true)
      else consider('ineligible', 'outside_region', `remote ${where(scope)} only; you are in ${country}`, false, false)
    } else {
      const scope = option.countries
      if (scope === null || scope === 'anywhere') consider('unknown', 'onsite_maybe', `on-site in ${option.label}`, true, false)
      else if (!country) consider('unknown', 'country_unknown', `on-site in ${label(scope, option.label)}; your country is not on file`, false, false)
      else if (scope.has(country)) consider('eligible', 'in_region', `on-site in ${label(scope, option.label)}, where you live`, false, false)
      else if (authorizedIn(user.workAuthorizations, scope, r.noSponsorship) === 'yes') {
        consider('unknown', 'onsite_maybe', `on-site in ${label(scope, option.label)}: you could work there but live in ${country}`, false, false)
      } else consider('ineligible', 'onsite_elsewhere', `on-site in ${label(scope, option.label)}; you are in ${country}`, false, false)
    }
  }
  if (effective.length === 0) place.reason = 'the posting does not say where it hires'

  if (place.verdict === 'ineligible') return done('ineligible', place.code, place.reason)

  // 3. Work authorization the posting demands in so many words.
  const demands = [...r.workAuthIn]
  if (r.workAuthInJobCountry) {
    const jobCountries = new Set(
      effective.flatMap((option) => (option.countries instanceof Set ? [...option.countries] : [])),
    )
    if (jobCountries.size > 0) demands.push({ countries: jobCountries, label: label(jobCountries, "the job's country") })
    else if (place.verdict === 'eligible' && place.code !== 'anywhere') {
      // "authorised in the country of the role" for a role in an unnamed place.
      return done('unknown', 'work_auth_missing', 'asks for work authorization in an unnamed country', true)
    }
  }
  for (const demand of demands) {
    const held = authorizedIn(user.workAuthorizations, demand.countries, r.noSponsorship)
    if (held === 'no') return done('ineligible', 'work_auth_denied', `must be authorised to work in ${demand.label}; you are not`)
    if (held === 'needs_sponsorship') return done('ineligible', 'needs_sponsorship', `no visa sponsorship for ${demand.label}; you would need it`)
    if (held === 'unknown') {
      // Living elsewhere with nothing on file for that country: the job is
      // done from there, and nothing says the user may work there.
      if (country && !demand.countries.has(country)) {
        return done('ineligible', 'work_auth_missing', `must be authorised to work in ${demand.label}; you live in ${country} and have no authorization there on file`)
      }
      return done('unknown', 'work_auth_missing', `must be authorised to work in ${demand.label}; no answer on file for it`)
    }
    reasons.push(`authorised in ${demand.label}`)
  }
  // "No sponsorship" with nothing named: it means the country the hire works in.
  if (r.noSponsorship && demands.length === 0 && country && place.code !== 'anywhere') {
    const held = authorizedIn(user.workAuthorizations, new Set([country]), true)
    if (held === 'needs_sponsorship') return done('ineligible', 'needs_sponsorship', `no visa sponsorship; you need it in ${country}`)
    if (held !== 'yes' && place.code === 'onsite_maybe') {
      return done('unknown', 'work_auth_missing', 'no visa sponsorship, and your status there is not on file')
    }
  }

  // 4. Working hours.
  if (r.timezone && (place.remoteOk || place.verdict !== 'eligible')) {
    const offsets = countryOffsets(country)
    if (!offsets) return done('unknown', 'timezone_unknown', `${r.timezone.label} required; your time zone is not on file`)
    const [min, max] = offsets
    if (min >= r.timezone.min && max <= r.timezone.max) reasons.push(`${r.timezone.label}: fits ${country}`)
    else if (max < r.timezone.min || min > r.timezone.max) {
      return done('ineligible', 'timezone_outside', `${r.timezone.label} required; ${countryName(country)} is UTC${min >= 0 ? '+' : ''}${min}`)
    } else return done('unknown', 'timezone_unknown', `${r.timezone.label}: only part of ${countryName(country)} fits`)
  }

  // 5. Anything that sounded like a restriction and could not be read.
  if (r.unparsed.length > 0 && place.verdict === 'eligible') {
    return done('unknown', 'unparsed', `${place.reason}, but the posting has a condition we could not read`, true)
  }
  return done(place.verdict, place.code, place.reason, place.verdict === 'unknown' && place.needsJev)
}

/** Rules first, then (separately) Jev for what they leave unknown. */
export function checkEligibility(job: EligibilityJob, user: Applicant): EligibilityResult & { restrictions: Restrictions } {
  const restrictions = parseRestrictions(job)
  return { ...evaluateEligibility(restrictions, user), restrictions }
}

// ── Jev, for what the rules leave open ───────────────────────────────────────

/** Probability bands for Jev's yes/no. Between them, it stays unknown. */
export const JEV_ELIGIBLE_AT = 0.85
export const JEV_INELIGIBLE_AT = 0.25

/**
 * The one question Jev is asked about eligibility: can someone living in
 * `country` be hired? It is about residence only, so its answer can be
 * cached per job and country and shared by every user there; work
 * authorization and citizenship stay with the rules above.
 */
export function eligibilityQuestion(country: string): NoulQuestion {
  const name = countryByCode(country)?.name ?? country
  return {
    type: 'noul',
    instructions:
      `Read the job's location and description. True if the employer would accept a candidate who lives in ${name} ` +
      `and would work from there (remotely, unless the job is in ${name}). False if the posting limits hiring to other ` +
      `countries, regions or time zones, or requires relocating or being on-site elsewhere. If the posting says nothing ` +
      `about where candidates may live, answer from what the location field implies, and lean false when it is unclear.`,
    criteria: {
      true: `A candidate living in ${name} can be hired for this job.`,
      false: `This job is not open to candidates living in ${name}.`,
    },
  }
}

/** Jev's probability as a verdict. */
export function verdictFromJev(probability: number): Verdict {
  if (probability >= JEV_ELIGIBLE_AT) return 'eligible'
  if (probability <= JEV_INELIGIBLE_AT) return 'ineligible'
  return 'unknown'
}

/** The posting text Jev needs for eligibility: location plus the sentences
 * that talk about place, hours or authorization — short, so it costs little. */
export function eligibilityExcerpt(job: EligibilityJob, restrictions: Restrictions): string {
  const text = plainText(job.description) || plainText(job.short_description)
  const relevant = sentences(text).filter((s) => RESTRICTIONISH.test(s) || REMOTE.test(s)).slice(0, 8)
  return [...new Set([...restrictions.unparsed, ...relevant])].join(' ').slice(0, 1200)
}


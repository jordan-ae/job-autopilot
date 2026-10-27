import { COUNTRIES, EU_MEMBERS } from '../fields/countries.js'

/**
 * Where a job may hire from, in words a posting uses: countries, the region
 * groups recruiters write ("EMEA", "LATAM", "Americas"), US states and the
 * cities postings name without a country, and each country's UTC offsets for
 * "must overlap with US hours" restrictions.
 *
 * Pure data and lookups for eligibility.ts. The country list is the
 * Field Mapper's (fields/countries.ts), so "the user's country" and "the
 * job's country" are spelled the same way everywhere.
 */

const set = (codes: string) => new Set(codes.split(/\s+/).filter(Boolean))

const NORTH_AMERICA = set('US CA MX GT HN SV NI CR PA DO JM PR')
const SOUTH_AMERICA = set('AR BO BR CL CO EC PY PE UY VE')
const EUROPE = set(
  'AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT MD MC ME NL MK NO PL PT RO RS SK SI ES SE CH UA GB',
)
const MIDDLE_EAST = set('BH IQ IL JO KW LB OM QA SA AE TR')
const AFRICA = set('DZ AO BJ BW CM CI EG ET GH KE MU MA MZ NG RW SN ZA TZ TN UG ZM ZW')
const ASIA = set('AF BD KH CN HK IN ID JP KZ KR KG LA MO MY MN MM NP PK PH SG LK TW TH UZ VN')
const OCEANIA = set('AU NZ')
const CAUCASUS = set('GE AM AZ RU')

const union = (...sets: Set<string>[]) => new Set(sets.flatMap((s) => [...s]))

/** Region groups by key. Every value is a set of ISO2 codes. */
export const REGION_GROUPS: Record<string, Set<string>> = {
  EU: new Set(EU_MEMBERS),
  EEA: union(new Set(EU_MEMBERS), set('IS LI NO')),
  EUROPE,
  UK_IE: set('GB IE'),
  DACH: set('DE AT CH'),
  NORDICS: set('DK FI IS NO SE'),
  BENELUX: set('BE NL LU'),
  CEE: set('AL BA BG HR CZ EE HU LV LT MD ME MK PL RO RS SK SI UA'),
  EMEA: union(EUROPE, MIDDLE_EAST, AFRICA, CAUCASUS),
  NORTH_AMERICA: set('US CA'),
  US_CA: set('US CA'),
  AMERICAS: union(NORTH_AMERICA, SOUTH_AMERICA),
  LATAM: union(set('MX GT HN SV NI CR PA DO PR'), SOUTH_AMERICA),
  APAC: union(ASIA, OCEANIA),
  ASIA,
  SOUTHEAST_ASIA: set('ID MY SG TH VN PH KH LA MM'),
  AFRICA,
  MIDDLE_EAST,
  OCEANIA,
  ANZ: OCEANIA,
}

/** Words for each group, matched case-insensitively as whole words. Longest first. */
const GROUP_WORDS: Array<{ key: string; pattern: RegExp }> = [
  ['EEA', 'European Economic Area'],
  ['EU', 'European Union'],
  ['EMEA', 'EMEA'],
  ['APAC', 'APAC|Asia[- ]Pacific|APJ'],
  ['LATAM', 'LATAM|LatAm|Latin America|South America|Central America'],
  ['NORTH_AMERICA', 'North America|North American|NORAM|NA region'],
  ['AMERICAS', 'Americas|AMER'],
  ['CEE', 'CEE|Central and Eastern Europe|Eastern Europe|Central Europe'],
  ['EUROPE', 'Europe|European'],
  ['UK_IE', 'UK&I|UK & Ireland|UKI'],
  ['DACH', 'DACH'],
  ['NORDICS', 'Nordics|Nordic countries|Scandinavia'],
  ['BENELUX', 'Benelux'],
  ['SOUTHEAST_ASIA', 'Southeast Asia|South[- ]East Asia|SEA region|ASEAN'],
  ['MIDDLE_EAST', 'Middle East|MENA|GCC'],
  ['AFRICA', 'Africa'],
  ['ASIA', 'Asia'],
  ['ANZ', 'ANZ|Australia and New Zealand|Oceania'],
].map(([key, words]) => ({ key, pattern: new RegExp(`(?:^|[^A-Za-z])(?:${words})(?![A-Za-z])`, 'i') }))

// `EU` alone is case-sensitive: "eu" turns up inside words in other languages.
const EU_ABBREV = /(?:^|[^A-Za-z])(?:EU|E\.U\.)(?![A-Za-z])/

const US_STATES: Array<[string, string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
]
const US_STATE_CODES = new Set(US_STATES.map(([code]) => code))
const CA_PROVINCES = new Set(['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE'])
const CA_PROVINCE_NAMES = /\b(?:Ontario|Quebec|Québec|British Columbia|Alberta|Manitoba|Saskatchewan|Nova Scotia|New Brunswick)\b/i
// Spelled-out states that are not also the names of other places.
// ("Georgia" is a country, "Washington" a city as often as a state.)
const US_STATE_NAMES = new RegExp(
  `\\b(?:${US_STATES.map(([, name]) => name)
    .filter((name) => name !== 'Georgia' && name !== 'Washington' && name !== 'New York')
    .join('|')})\\b`,
  'i',
)

/** Cities postings name without a country. Only places with one meaning. */
const CITIES: Record<string, string> = {
  'san francisco': 'US', 'sf bay area': 'US', 'bay area': 'US', 'new york': 'US', 'nyc': 'US', 'seattle': 'US',
  'austin': 'US', 'boston': 'US', 'los angeles': 'US', 'chicago': 'US', 'denver': 'US', 'atlanta': 'US',
  'miami': 'US', 'palo alto': 'US', 'mountain view': 'US', 'menlo park': 'US', 'san jose': 'US', 'sunnyvale': 'US',
  'san mateo': 'US', 'redwood city': 'US', 'san diego': 'US', 'washington, d.c.': 'US', 'washington dc': 'US',
  'pittsburgh': 'US', 'philadelphia': 'US', 'salt lake city': 'US', 'dallas': 'US', 'houston': 'US', 'portland': 'US',
  'minneapolis': 'US', 'detroit': 'US', 'nashville': 'US', 'raleigh': 'US', 'phoenix': 'US', 'brooklyn': 'US',
  'toronto': 'CA', 'vancouver': 'CA', 'montreal': 'CA', 'montréal': 'CA', 'ottawa': 'CA', 'calgary': 'CA', 'waterloo': 'CA',
  'london': 'GB', 'manchester': 'GB', 'edinburgh': 'GB', 'cambridge, uk': 'GB', 'bristol': 'GB', 'belfast': 'GB',
  'dublin': 'IE', 'berlin': 'DE', 'munich': 'DE', 'münchen': 'DE', 'hamburg': 'DE', 'frankfurt': 'DE', 'cologne': 'DE',
  'amsterdam': 'NL', 'rotterdam': 'NL', 'paris': 'FR', 'lyon': 'FR', 'madrid': 'ES', 'barcelona': 'ES', 'lisbon': 'PT',
  'porto': 'PT', 'milan': 'IT', 'rome': 'IT', 'zurich': 'CH', 'zürich': 'CH', 'geneva': 'CH', 'vienna': 'AT',
  'stockholm': 'SE', 'copenhagen': 'DK', 'oslo': 'NO', 'helsinki': 'FI', 'warsaw': 'PL', 'krakow': 'PL', 'kraków': 'PL',
  'prague': 'CZ', 'budapest': 'HU', 'bucharest': 'RO', 'athens': 'GR', 'brussels': 'BE', 'tallinn': 'EE', 'kyiv': 'UA',
  'tel aviv': 'IL', 'dubai': 'AE', 'abu dhabi': 'AE', 'riyadh': 'SA', 'istanbul': 'TR', 'cairo': 'EG', 'lagos': 'NG',
  'nairobi': 'KE', 'cape town': 'ZA', 'johannesburg': 'ZA', 'bangalore': 'IN', 'bengaluru': 'IN', 'mumbai': 'IN',
  'hyderabad': 'IN', 'pune': 'IN', 'chennai': 'IN', 'gurgaon': 'IN', 'gurugram': 'IN', 'noida': 'IN', 'new delhi': 'IN',
  'delhi': 'IN', 'singapore': 'SG', 'jakarta': 'ID', 'bandung': 'ID', 'surabaya': 'ID', 'bali': 'ID', 'kuala lumpur': 'MY',
  'bangkok': 'TH', 'manila': 'PH', 'ho chi minh': 'VN', 'hanoi': 'VN', 'tokyo': 'JP', 'osaka': 'JP', 'seoul': 'KR',
  'shanghai': 'CN', 'beijing': 'CN', 'shenzhen': 'CN', 'taipei': 'TW', 'sydney': 'AU', 'melbourne': 'AU',
  'brisbane': 'AU', 'perth': 'AU', 'auckland': 'NZ', 'wellington': 'NZ', 'são paulo': 'BR', 'sao paulo': 'BR',
  'rio de janeiro': 'BR', 'buenos aires': 'AR', 'mexico city': 'MX', 'ciudad de méxico': 'MX', 'bogotá': 'CO',
  'bogota': 'CO', 'medellín': 'CO', 'medellin': 'CO', 'santiago': 'CL', 'lima': 'PE', 'montevideo': 'UY',
}
const CITY_PATTERNS = Object.entries(CITIES)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, code]) => ({ code, pattern: new RegExp(`(?:^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu') }))

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every country name and alias. Two-to-five letter abbreviations are case-sensitive ("work with us"). */
const COUNTRY_PATTERNS: Array<{ code: string; pattern: RegExp }> = COUNTRIES.flatMap((country) =>
  [country.name, ...country.aliases].map((name) => ({ code: country.code, name })),
)
  .sort((a, b) => b.name.length - a.name.length)
  .map(({ code, name }) => ({
    code,
    pattern: new RegExp(`(?:^|[^A-Za-z])${escape(name)}(?![A-Za-z])`, /^[A-Z.]{2,5}$/.test(name) ? '' : 'i'),
  }))

export interface RegionMention {
  /** ISO2 codes the text allows. */
  countries: Set<string>
  /** What was matched, for the reason line: 'US', 'EMEA', 'San Francisco'. */
  labels: string[]
}

/**
 * Every place `text` names, as a set of countries. A group ("EMEA") expands to
 * its members. Empty when nothing is recognised.
 */
export function regionsInText(text: string): RegionMention {
  const countries = new Set<string>()
  const labels: string[] = []
  if (!text) return { countries, labels }
  let rest = text

  const take = (pattern: RegExp, codes: Iterable<string>, label: string) => {
    if (!pattern.test(rest)) return
    for (const code of codes) countries.add(code)
    labels.push(label)
    // Blank the match out so "North America" is not read again as "America".
    rest = rest.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), ' ')
  }

  for (const { key, pattern } of GROUP_WORDS) take(pattern, REGION_GROUPS[key], key)
  take(EU_ABBREV, REGION_GROUPS.EU, 'EU')
  for (const { code, pattern } of CITY_PATTERNS) take(pattern, [code], code)
  // States before countries: "New Mexico" is not Mexico.
  take(US_STATE_NAMES, ['US'], 'US')
  take(CA_PROVINCE_NAMES, ['CA'], 'CA')
  for (const { code, pattern } of COUNTRY_PATTERNS) take(pattern, [code], code)

  // "Austin, TX", "Waterloo, ON": a two-letter state or province after a
  // comma. Only when nothing else placed it, or it agrees: "Berlin, DE" is
  // Germany, not Delaware.
  const placed = new Set(countries)
  for (const match of rest.matchAll(/,\s*([A-Z]{2})(?![A-Za-z])/g)) {
    const code = US_STATE_CODES.has(match[1]) ? 'US' : CA_PROVINCES.has(match[1]) ? 'CA' : null
    if (!code || (placed.size > 0 && !placed.has(code))) continue
    countries.add(code)
    labels.push(code)
  }
  return { countries, labels: [...new Set(labels)] }
}

/** Is `country` inside `region` (an ISO2 code or a group key)? */
export function regionCovers(region: string, country: string): boolean {
  const key = region.toUpperCase()
  if (key === country.toUpperCase()) return true
  return REGION_GROUPS[key]?.has(country.toUpperCase()) ?? false
}

/**
 * Standard-time UTC offsets per country, in hours: [min, max] across its
 * zones. Summer time is left out on purpose: the tolerance in each rule is
 * wider than an hour.
 */
const OFFSETS: Record<string, [number, number]> = {}
const offsetTable = `
US -8 -5|CA -8 -3.5|MX -8 -6|GT -6 -6|HN -6 -6|SV -6 -6|NI -6 -6|CR -6 -6|PA -5 -5|DO -4 -4|JM -5 -5|PR -4 -4
AR -3 -3|BO -4 -4|BR -5 -2|CL -4 -4|CO -5 -5|EC -5 -5|PY -4 -3|PE -5 -5|UY -3 -3|VE -4 -4
GB 0 0|IE 0 0|PT 0 0|IS 0 0
AL 1 1|AD 1 1|AT 1 1|BE 1 1|BA 1 1|HR 1 1|CZ 1 1|DK 1 1|FR 1 1|DE 1 1|HU 1 1|IT 1 1|LI 1 1|LU 1 1|MT 1 1|MC 1 1
ME 1 1|NL 1 1|MK 1 1|NO 1 1|PL 1 1|RS 1 1|SK 1 1|SI 1 1|ES 1 1|SE 1 1|CH 1 1
BG 2 2|CY 2 2|EE 2 2|FI 2 2|GR 2 2|LV 2 2|LT 2 2|MD 2 2|RO 2 2|UA 2 2|BY 3 3|RU 2 12|TR 3 3|GE 4 4|AM 4 4|AZ 4 4
BH 3 3|IQ 3 3|IL 2 2|JO 3 3|KW 3 3|LB 2 2|OM 4 4|QA 3 3|SA 3 3|AE 4 4
DZ 1 1|AO 1 1|BJ 1 1|BW 2 2|CM 1 1|CI 0 0|EG 2 2|ET 3 3|GH 0 0|KE 3 3|MU 4 4|MA 0 1|MZ 2 2|NG 1 1|RW 2 2|SN 0 0
ZA 2 2|TZ 3 3|TN 1 1|UG 3 3|ZM 2 2|ZW 2 2
AF 4.5 4.5|BD 6 6|KH 7 7|CN 8 8|HK 8 8|IN 5.5 5.5|ID 7 9|JP 9 9|KZ 5 6|KR 9 9|KG 6 6|LA 7 7|MO 8 8|MY 8 8|MN 7 8
MM 6.5 6.5|NP 5.75 5.75|NZ 12 12|AU 8 10|PK 5 5|PH 8 8|SG 8 8|LK 5.5 5.5|TW 8 8|TH 7 7|UZ 5 5|VN 7 7
`
for (const entry of offsetTable.split(/[|\n]/)) {
  const [code, min, max] = entry.trim().split(/\s+/)
  if (code) OFFSETS[code] = [Number(min), Number(max)]
}

export function countryOffsets(country: string | null | undefined): [number, number] | null {
  return country ? (OFFSETS[country.toUpperCase()] ?? null) : null
}

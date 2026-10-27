/**
 * Countries, dialling codes, and finding which country a question is about.
 *
 * Work authorization is per country: an Indonesian developer may be
 * authorized in Indonesia, open to an employer-of-record contract in the US,
 * and need sponsorship in Germany. A question says which one it means in its
 * own words ("authorized to work in Canada"), or leaves it to the job
 * ("in the country where this job is located"); `detectRegion` reads both, in
 * that order.
 */

// ISO2 | name | dialling code | aliases (;-separated, matched as whole words)
const TABLE = `
AF|Afghanistan|93|
AL|Albania|355|
DZ|Algeria|213|
AD|Andorra|376|
AO|Angola|244|
AR|Argentina|54|
AM|Armenia|374|
AU|Australia|61|
AT|Austria|43|
AZ|Azerbaijan|994|
BH|Bahrain|973|
BD|Bangladesh|880|
BY|Belarus|375|
BE|Belgium|32|
BJ|Benin|229|
BO|Bolivia|591|
BA|Bosnia and Herzegovina|387|Bosnia
BW|Botswana|267|
BR|Brazil|55|Brasil
BG|Bulgaria|359|
KH|Cambodia|855|
CM|Cameroon|237|
CA|Canada|1|Canadian
CL|Chile|56|
CN|China|86|PRC;Mainland China
CO|Colombia|57|
CR|Costa Rica|506|
CI|Cote d'Ivoire|225|Ivory Coast;Côte d'Ivoire
HR|Croatia|385|
CY|Cyprus|357|
CZ|Czechia|420|Czech Republic
DK|Denmark|45|
DO|Dominican Republic|1|
EC|Ecuador|593|
EG|Egypt|20|
SV|El Salvador|503|
EE|Estonia|372|
ET|Ethiopia|251|
FI|Finland|358|
FR|France|33|
GE|Georgia|995|
DE|Germany|49|Deutschland
GH|Ghana|233|
GR|Greece|30|
GT|Guatemala|502|
HN|Honduras|504|
HK|Hong Kong|852|
HU|Hungary|36|
IS|Iceland|354|
IN|India|91|
ID|Indonesia|62|
IQ|Iraq|964|
IE|Ireland|353|
IL|Israel|972|
IT|Italy|39|
JM|Jamaica|1|
JP|Japan|81|
JO|Jordan|962|
KZ|Kazakhstan|7|
KE|Kenya|254|
KR|South Korea|82|Korea;Republic of Korea
KW|Kuwait|965|
KG|Kyrgyzstan|996|
LA|Laos|856|
LV|Latvia|371|
LB|Lebanon|961|
LI|Liechtenstein|423|
LT|Lithuania|370|
LU|Luxembourg|352|
MO|Macau|853|Macao
MY|Malaysia|60|
MT|Malta|356|
MU|Mauritius|230|
MX|Mexico|52|
MD|Moldova|373|
MC|Monaco|377|
MN|Mongolia|976|
ME|Montenegro|382|
MA|Morocco|212|
MZ|Mozambique|258|
MM|Myanmar|95|Burma
NP|Nepal|977|
NL|Netherlands|31|The Netherlands;Holland
NZ|New Zealand|64|
NI|Nicaragua|505|
NG|Nigeria|234|
MK|North Macedonia|389|Macedonia
NO|Norway|47|
OM|Oman|968|
PK|Pakistan|92|
PA|Panama|507|
PY|Paraguay|595|
PE|Peru|51|
PH|Philippines|63|
PL|Poland|48|
PT|Portugal|351|
PR|Puerto Rico|1|
QA|Qatar|974|
RO|Romania|40|
RU|Russia|7|Russian Federation
RW|Rwanda|250|
SA|Saudi Arabia|966|
SN|Senegal|221|
RS|Serbia|381|
SG|Singapore|65|
SK|Slovakia|421|
SI|Slovenia|386|
ZA|South Africa|27|
ES|Spain|34|España
LK|Sri Lanka|94|
SE|Sweden|46|
CH|Switzerland|41|
TW|Taiwan|886|
TZ|Tanzania|255|
TH|Thailand|66|
TN|Tunisia|216|
TR|Turkey|90|Türkiye;Turkiye
UG|Uganda|256|
UA|Ukraine|380|
AE|United Arab Emirates|971|UAE
GB|United Kingdom|44|UK;U.K.;Great Britain;Britain;England;Scotland;Wales;Northern Ireland
US|United States|1|United States of America;USA;U.S.A.;U.S.;US;America
UY|Uruguay|598|
UZ|Uzbekistan|998|
VE|Venezuela|58|
VN|Vietnam|84|Viet Nam
ZM|Zambia|260|
ZW|Zimbabwe|263|
`

export interface Country {
  code: string
  name: string
  dial: string
  aliases: string[]
}

export const COUNTRIES: Country[] = TABLE.trim()
  .split('\n')
  .map((line) => {
    const [code, name, dial, aliases] = line.split('|')
    return { code, name, dial, aliases: aliases ? aliases.split(';').filter(Boolean) : [] }
  })

const BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]))

export function countryByCode(code: string | null | undefined): Country | undefined {
  return code ? BY_CODE.get(code.toUpperCase()) : undefined
}

/** EU member states. An `EU` work-authorization row covers each of them. */
export const EU_MEMBERS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Patterns that name a country, longest first so "United States of America"
 * wins over "America". Two-letter abbreviations ("US", "UK") are matched
 * case-sensitively: "work with us" is not the United States.
 */
const MATCHERS: Array<{ code: string; pattern: RegExp }> = COUNTRIES.flatMap((country) =>
  [country.name, ...country.aliases].map((name) => ({ code: country.code, name })),
)
  .sort((a, b) => b.name.length - a.name.length)
  .map(({ code, name }) => {
    const caseSensitive = /^[A-Z.]{2,5}$/.test(name)
    return {
      code,
      pattern: new RegExp(`(^|[^A-Za-z])${escape(name)}(?![A-Za-z])`, caseSensitive ? '' : 'i'),
    }
  })

const EU_PATTERN = /\b(?:EU|E\.U\.|EEA)\b|\bEuropean (?:Union|Economic Area)\b/

/** The country (ISO2) or `EU` named in `text`, or null. */
export function regionInText(text: string): string | null {
  if (!text) return null
  if (EU_PATTERN.test(text)) return 'EU'
  for (const { code, pattern } of MATCHERS) if (pattern.test(text)) return code
  return null
}

/** True when a question leaves the country to the job: "in the country where
 * the job is located", "in this location". */
export function refersToJobLocation(text: string): boolean {
  return /\b(?:this|the|that) (?:country|location|region)\b|\bwhere (?:the|this) (?:job|role|position)\b|\bthe (?:job|role|position) (?:is )?(?:located|based)\b/i.test(text)
}

/**
 * The region a work-authorization question is about: the one it names, else
 * the job's, else null. A remote job with no country ("Remote") stays null.
 */
export function detectRegion(question: string, jobLocation?: string | null): { region: string | null; via: 'question' | 'job' | null } {
  const named = regionInText(question)
  if (named) return { region: named, via: 'question' }
  const fromJob = jobLocation ? regionInText(jobLocation) : null
  if (fromJob) return { region: fromJob, via: 'job' }
  return { region: null, via: null }
}

/** The country a free-text location ("Jakarta, Indonesia") is in. */
export function countryFromLocation(location: string | null | undefined): string | null {
  const region = regionInText(location ?? '')
  return region && region !== 'EU' ? region : null
}

/** Pick the option naming `code` from a country dropdown. Exact name or alias first. */
export function countryOption(options: string[], code: string): string | null {
  const country = countryByCode(code)
  if (!country) return null
  const names = [country.name, ...country.aliases].map((name) => name.toLowerCase())
  const clean = (option: string) => option.toLowerCase().replace(/\s*\(?\+\d+\)?\s*$/, '').trim()
  const exact = options.filter((option) => names.includes(clean(option)))
  if (exact.length === 1) return exact[0]
  const containing = options.filter((option) => regionInText(option) === country.code)
  return containing.length === 1 ? containing[0] : null
}

/**
 * The canonical field registry: every thing an application form asks for,
 * named once.
 *
 * A form question is matched to one of these keys (by its ATS-native field
 * name, then by the wording patterns below, then — in the agent pass — by a
 * classifier), and the key decides where the answer comes from. Before this
 * file the fill engine knew ~15 meanings as regexes inline, and anything else
 * was a question for the applicant.
 *
 * Plain data, plain types, plain regexes: no imports and nothing Node-only,
 * so a browser can load it too.
 *
 * KEY NAMES ARE A CONTRACT. Stored answers, autofill modes, the shared
 * classification cache and resume-profile overrides (the applicant's
 * `overrides`, `Record<canonicalKey, value>`) all name fields by these keys:
 * rename one and what was stored under it is orphaned. Keys are lower
 * snake_case. Per-country work authorization, EEO and consent fields are not
 * overridable by key.
 *
 * Patterns are tested against the question's fingerprint
 * (fields/text.ts fingerprintQuestion): lowercase, punctuation stripped,
 * the employer's name removed, whitespace collapsed, at most 120 characters.
 * Each pattern should describe the whole question, not a word in it — the
 * failure this guards against is the applicant's city typed into "Which
 * location are you applying for?". Order matters: the first field whose
 * pattern matches wins, so narrower questions are listed before broader ones.
 */

export type FieldTab =
  | 'personal'
  | 'location'
  | 'documents'
  | 'education'
  | 'experience'
  | 'work_authorization'
  | 'eeo'
  | 'links'
  | 'other'

export const FIELD_TABS: Array<{ id: FieldTab; label: string }> = [
  { id: 'personal', label: 'Personal' },
  { id: 'location', label: 'Location' },
  { id: 'documents', label: 'Documents' },
  { id: 'education', label: 'Education' },
  { id: 'experience', label: 'Experience' },
  { id: 'work_authorization', label: 'Work Authorization' },
  { id: 'eeo', label: 'EEO' },
  { id: 'links', label: 'Social & Links' },
  { id: 'other', label: 'Other' },
]

export type FieldValueType = 'text' | 'boolean' | 'choice' | 'date' | 'number' | 'file'

/**
 * Where a field's value lives.
 * - `identity`: a column of application_profile the user fills in.
 * - `computed`: derived from other fields (first name from full name, age from DOB).
 * - `resume`: read off the CV (current employer, latest degree, years of experience).
 * - `answer_bank`: a remembered answer to a recurring question.
 * - `ask`: specific to one application; asked of the applicant every time.
 */
export type FieldSource = 'identity' | 'computed' | 'resume' | 'answer_bank' | 'ask'

/**
 * What the applicant wants done with a field.
 * - `autofill`: fill it from what is on file.
 * - `ask`: always ask, even when something is on file.
 * - `decline_or_blank`: pick the form's "decline to answer" option, or leave
 *   the field empty when it is optional.
 */
export type AutofillMode = 'autofill' | 'ask' | 'decline_or_blank'

export const AUTOFILL_MODES: AutofillMode[] = ['autofill', 'ask', 'decline_or_blank']

export type FormAtsName = 'greenhouse' | 'ashby' | 'lever'

export interface CanonicalField {
  key: string
  /** What the Field Mapper calls it. */
  label: string
  tab: FieldTab
  type: FieldValueType
  source: FieldSource
  /** Matched against the question fingerprint. */
  patterns: RegExp[]
  /** Vetoes a pattern match: a wording that shares the vocabulary but asks something else. */
  unless?: RegExp
  /** The ATS's own field names for this field. Checked before any wording. */
  native?: Partial<Record<FormAtsName, RegExp>>
  /** Only match when the nearest section heading also matches. */
  section?: RegExp
  /**
   * `eeo` and `consent` are never filled from inference; `private` is
   * personal data that defaults to being asked about each time.
   */
  sensitivity?: 'eeo' | 'consent' | 'private'
  defaultMode: AutofillMode
  /** The agent may draft this from the user's CV, profile and answer bank. */
  draftable?: boolean
  /** The answer depends on the employer, so a banked answer is never reused at another one. */
  perEmployer?: boolean
  /** Answered per country or region, from the work-authorization table. */
  perRegion?: boolean
  /** One entry of a repeating CV block; the native key carries the entry index. */
  block?: 'employment' | 'education'
  /** The application_profile column behind an `identity` field. */
  column?: string
  /** One line of help for the Field Mapper. */
  hint?: string
}

const F = (field: CanonicalField): CanonicalField => field

export const CANONICAL_FIELDS: CanonicalField[] = [
  // ── Work authorization ─────────────────────────────────────────────────
  // First: these wordings borrow "authorized", "name" and "location", and
  // must not fall to the broader fields further down.
  F({
    key: 'work_authorized_without_sponsorship',
    label: 'Can work without sponsorship',
    tab: 'work_authorization',
    type: 'boolean',
    source: 'computed',
    perRegion: true,
    defaultMode: 'autofill',
    patterns: [
      /\b(?:eligible|authori[sz]ed|able|entitled|permitted) to work\b.*\bwithout\b.*\bsponsor/,
      /\bwork\b.*\bwithout (?:the need for |requiring |needing )?(?:visa |immigration |employer |company )?sponsor/,
    ],
    hint: 'Authorized there and not needing sponsorship, per country.',
  }),
  F({
    key: 'sponsorship_details',
    label: 'Sponsorship details',
    tab: 'work_authorization',
    type: 'text',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/^if (?:you|yes)\b.*\bsponsor/, /\bsponsorship\b.*\b(?:details|explain|describe|specify)\b/],
  }),
  F({
    key: 'requires_sponsorship',
    label: 'Needs visa sponsorship',
    tab: 'work_authorization',
    type: 'boolean',
    source: 'identity',
    column: 'requires_sponsorship',
    perRegion: true,
    defaultMode: 'autofill',
    // "Will you require sponsorship?" only. "Can you work without
    // sponsorship?" asks the reverse, and "If you need sponsorship, give
    // details" wants prose.
    patterns: [/\b(?:require|need)\b.*\bsponsor/],
    unless: /\bwithout\b|^if\b/,
  }),
  F({
    key: 'opt_status',
    label: 'Holds OPT / STEM OPT',
    tab: 'work_authorization',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\boptional practical training\b|\bopt\b/],
  }),
  F({
    key: 'work_authorized',
    label: 'Authorized to work',
    tab: 'work_authorization',
    type: 'boolean',
    source: 'identity',
    column: 'work_authorization',
    perRegion: true,
    defaultMode: 'autofill',
    patterns: [
      /\b(authori[sz]ed to work|work authori[sz]ation|right to work|legally authori[sz]ed)\b/,
      /\b(?:legally )?(?:eligible|entitled|permitted) to work\b/,
      /\bauthori[sz]ed to work lawfully\b/,
    ],
    unless: /\bwithout\b/,
    hint: 'Per country — a remote role in the US and one in the EU are different questions.',
  }),
  F({
    key: 'citizenship',
    label: 'Citizenship',
    tab: 'work_authorization',
    type: 'choice',
    source: 'identity',
    column: 'citizenship',
    defaultMode: 'autofill',
    patterns: [/^(?:country of )?(?:citizenship|nationality)$/, /\bwhat is your (?:citizenship|nationality)\b/, /\bcitizen of\b/],
  }),
  F({
    key: 'open_to_contractor',
    label: 'Open to contractor / EOR',
    tab: 'work_authorization',
    type: 'boolean',
    source: 'computed',
    perRegion: true,
    defaultMode: 'autofill',
    patterns: [/\b(?:contractor|independent contractor|employer of record|\beor\b|contract basis|1099)\b/],
    unless: /\bhave you (?:ever )?(?:previously )?worked\b|\bin the past\b|\bcapacity\b/,
    hint: 'Hired through a contractor agreement or an employer-of-record, per country.',
  }),

  // ── Personal ───────────────────────────────────────────────────────────
  F({
    key: 'preferred_last_name',
    label: 'Preferred last name',
    tab: 'personal',
    type: 'text',
    source: 'identity',
    column: 'preferred_last_name',
    defaultMode: 'autofill',
    patterns: [/^preferred last name$/],
  }),
  F({
    key: 'preferred_name',
    label: 'Preferred name',
    tab: 'personal',
    type: 'text',
    source: 'identity',
    column: 'preferred_name',
    defaultMode: 'autofill',
    native: { greenhouse: /^preferred_name$/ },
    patterns: [/^(?:your )?preferred (?:first )?name(?: if applicable)?$/, /^nickname$/],
  }),
  F({
    key: 'name_pronunciation',
    label: 'Name pronunciation',
    tab: 'personal',
    type: 'text',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/^(?:name )?pronunciation(?: of your name)?$|^name pronunciation\b|\bhow do you pronounce\b/],
  }),
  F({
    key: 'first_name',
    label: 'First name',
    tab: 'personal',
    type: 'text',
    source: 'computed',
    column: 'first_name',
    defaultMode: 'autofill',
    native: { greenhouse: /^first_name$/ },
    patterns: [/^(?:legal )?(?:first|given) name$/],
    hint: 'From your full name unless you set it.',
  }),
  F({
    key: 'middle_name',
    label: 'Middle name',
    tab: 'personal',
    type: 'text',
    source: 'identity',
    column: 'middle_name',
    defaultMode: 'autofill',
    patterns: [/^(?:legal )?middle name(?: or initial)?$|^middle initial$/],
  }),
  F({
    key: 'last_name',
    label: 'Last name',
    tab: 'personal',
    type: 'text',
    source: 'computed',
    column: 'last_name',
    defaultMode: 'autofill',
    native: { greenhouse: /^last_name$/ },
    patterns: [/^(?:legal )?(?:last|family) name$|^surname$/],
    hint: 'From your full name unless you set it.',
  }),
  F({
    key: 'full_name',
    label: 'Full name',
    tab: 'personal',
    type: 'text',
    source: 'identity',
    column: 'full_name',
    defaultMode: 'autofill',
    native: { ashby: /^_systemfield_name$/, lever: /^name$/ },
    patterns: [/^(?:your |candidate |applicant )?(?:full legal |full |legal )?name$/],
  }),
  F({
    key: 'email',
    label: 'Email',
    tab: 'personal',
    type: 'text',
    source: 'identity',
    column: 'email',
    defaultMode: 'autofill',
    native: { greenhouse: /^email$/, ashby: /^_systemfield_email$/, lever: /^email$/ },
    patterns: [/^(?:your )?(?:personal )?e ?mail(?: address)?$/],
  }),
  F({
    key: 'phone_country',
    label: 'Phone country',
    tab: 'personal',
    type: 'choice',
    source: 'computed',
    defaultMode: 'autofill',
    // Greenhouse's dialling-code box: labelled "Country", sectioned "Phone".
    section: /^phone$/i,
    native: { greenhouse: /^country$/ },
    patterns: [/^country$/],
    hint: 'The country your phone number is registered in.',
  }),
  F({
    key: 'phone_country_code',
    label: 'Phone country code',
    tab: 'personal',
    type: 'text',
    source: 'computed',
    column: 'phone_country_code',
    defaultMode: 'autofill',
    patterns: [/^(?:phone |dialing |dial |calling )?country code$/],
  }),
  F({
    key: 'phone_national',
    label: 'Phone (national number)',
    tab: 'personal',
    type: 'text',
    source: 'computed',
    column: 'phone_national',
    defaultMode: 'autofill',
    patterns: [/^(?:phone )?number without (?:the )?country code$|^national (?:phone )?number$/],
  }),
  F({
    key: 'phone',
    label: 'Phone',
    tab: 'personal',
    type: 'text',
    source: 'identity',
    column: 'phone',
    defaultMode: 'autofill',
    native: { greenhouse: /^phone$/, lever: /^phone$/ },
    patterns: [/^(?:your )?(?:(?:mobile|cell|contact|primary) )?(?:phone|telephone|mobile)(?: number)?$/],
  }),
  F({
    key: 'phone_e164',
    label: 'Phone (international format)',
    tab: 'personal',
    type: 'text',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [/\bphone\b.*\b(?:international|e 164|with country code)\b/],
  }),
  F({
    key: 'date_of_birth',
    label: 'Date of birth',
    tab: 'personal',
    type: 'date',
    source: 'identity',
    column: 'date_of_birth',
    sensitivity: 'private',
    defaultMode: 'ask',
    patterns: [/^(?:your )?(?:date of birth|birth ?date|dob)$/],
    hint: 'Only used to answer age questions unless you switch it to autofill.',
  }),
  F({
    key: 'over_18',
    label: 'At least 18',
    tab: 'personal',
    type: 'boolean',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [/\b(?:at least|over|older than) (?:the age of )?18\b|\b18 (?:years )?(?:of age )?or older\b|\b18 years of age\b/],
  }),
  F({
    key: 'over_21',
    label: 'At least 21',
    tab: 'personal',
    type: 'boolean',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [/\b(?:at least|over|older than) (?:the age of )?21\b|\b21 (?:years )?(?:of age )?or older\b/],
  }),
  F({
    key: 'age',
    label: 'Age',
    tab: 'personal',
    type: 'number',
    source: 'computed',
    sensitivity: 'private',
    defaultMode: 'ask',
    patterns: [/^(?:your )?age$|^how old are you$/],
  }),
  F({
    key: 'pronouns',
    label: 'Pronouns',
    tab: 'personal',
    type: 'text',
    source: 'identity',
    column: 'pronouns',
    defaultMode: 'autofill',
    native: { lever: /^pronouns$/ },
    patterns: [/^(?:your |personal |preferred )*(?:personal )?pronouns(?: optional)?$/, /\bwhat are your (?:preferred )?(?:personal )?pronouns\b/],
    hint: 'Only what you state here. Never guessed.',
  }),
  F({
    key: 'name_and_pronouns',
    label: 'Preferred name and pronouns',
    tab: 'personal',
    type: 'text',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [/\bpreferred name and (?:personal )?pronouns\b/, /\bwhole selves to work\b/],
  }),

  // ── Location ───────────────────────────────────────────────────────────
  F({
    key: 'job_location_choice',
    label: 'Which office / location you apply for',
    tab: 'location',
    type: 'choice',
    source: 'ask',
    defaultMode: 'ask',
    native: { lever: /^opportunityLocationId$/ },
    patterns: [/\bwhich (?:location|office|team location)s? (?:are you|would you like to be) (?:applying|considered)\b/],
  }),
  F({
    key: 'address_line1',
    label: 'Street address',
    tab: 'location',
    type: 'text',
    source: 'identity',
    column: 'address_line1',
    sensitivity: 'private',
    defaultMode: 'autofill',
    patterns: [/\bstreet address\b|^address line 1$|^address 1$|^street$/],
  }),
  F({
    key: 'address_line2',
    label: 'Address line 2',
    tab: 'location',
    type: 'text',
    source: 'identity',
    column: 'address_line2',
    sensitivity: 'private',
    defaultMode: 'autofill',
    patterns: [/^address line 2$|^address 2$|^apartment\b|^apt suite\b/],
  }),
  F({
    key: 'full_address',
    label: 'Full address',
    tab: 'location',
    type: 'text',
    source: 'computed',
    sensitivity: 'private',
    defaultMode: 'autofill',
    patterns: [/^(?:your )?(?:home |mailing |residential |current )?address$/],
  }),
  F({
    key: 'postal_code',
    label: 'Postal / ZIP code',
    tab: 'location',
    type: 'text',
    source: 'identity',
    column: 'postal_code',
    defaultMode: 'autofill',
    patterns: [/\b(?:postal|post|zip) ?code\b/],
  }),
  F({
    key: 'region',
    label: 'State / province',
    tab: 'location',
    type: 'choice',
    source: 'identity',
    column: 'region',
    defaultMode: 'autofill',
    patterns: [
      /^(?:your )?(?:state|province|region|state or province|state province)(?: of residence)?$/,
      /\b(?:which|what) (?:state|province|state or province)\b.*\b(?:live|reside|located|based)\b/,
    ],
  }),
  F({
    key: 'located_in_region',
    label: 'Lives in a listed region',
    tab: 'location',
    type: 'boolean',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [
      /\bdo you (?:currently )?(?:reside|live) in one of the following\b/,
      /\bare you (?:currently )?(?:located|based) (?:in|within)\b/,
    ],
    unless: /\bwilling to relocate\b|\bif not\b|\bwithin \d+\b/,
  }),
  F({
    key: 'city',
    label: 'City',
    tab: 'location',
    type: 'text',
    source: 'identity',
    column: 'city',
    defaultMode: 'autofill',
    patterns: [/^(?:your )?(?:current )?city$/, /^city of residence$/],
  }),
  F({
    key: 'current_location',
    label: 'Current location',
    tab: 'location',
    type: 'text',
    source: 'identity',
    column: 'location',
    defaultMode: 'autofill',
    native: { greenhouse: /^candidate-location$/, lever: /^location$/ },
    // Where the applicant is — not the office they are applying to, and not
    // whether they may work "in this location".
    patterns: [
      /^(?:your )?(?:current )?(?:location|city)(?: city)?$/,
      /^(?:your )?(?:current )?city(?: (?:and|or|state|province|country|region|of residence))+$/,
      /^(?:what|which) city do you (?:currently )?(?:live|reside) in$/,
      /^where are you (?:currently )?(?:based|located)$/,
      /^(?:please (?:enter|provide|share|list) )?your current (?:working |home )?location$/,
    ],
  }),
  F({
    key: 'country_of_residence',
    label: 'Country of residence',
    tab: 'location',
    type: 'choice',
    source: 'identity',
    column: 'country',
    defaultMode: 'autofill',
    patterns: [
      /^(?:your )?(?:current )?country(?: of residence)?$/,
      /\b(?:which|what) country do you (?:currently )?(?:live|reside|intend to work|plan to work|work) (?:in|from)\b/,
      /\bcountry (?:you|do you) (?:currently )?(?:live|reside) in\b/,
      // "Considering this is a remote role, from which country will you be working?"
      /\b(?:from )?(?:which|what) country (?:will|would|do|are) you (?:be )?(?:working|work|based|located|living|live|reside)\b/,
      /\bcountry (?:you|where you) (?:will|would|plan to|intend to) (?:be )?(?:working|work|live|based)\b/,
    ],
  }),
  F({
    key: 'demographic_location',
    label: 'Location (demographic survey)',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    column: 'country',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    section: /demographic|self[- ]?ident|voluntary|equal/i,
    patterns: [/^what is your location$/],
  }),
  F({
    key: 'located_in_area_or_relocate',
    label: 'In the area, or willing to relocate',
    tab: 'location',
    type: 'boolean',
    source: 'answer_bank',
    perEmployer: true,
    defaultMode: 'ask',
    patterns: [/\bare you (?:currently )?(?:located|based) in\b.*\b(?:if not|willing to relocate)\b/],
  }),
  F({
    key: 'willing_to_relocate',
    label: 'Willing to relocate',
    tab: 'location',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\bwilling to relocate\b|\bopen to relocat\w*\b|\brelocation\b.*\bconsider\b|\bconsider relocat\w*\b/],
  }),
  F({
    key: 'near_office',
    label: 'Lives near one of the offices',
    tab: 'location',
    type: 'choice',
    source: 'ask',
    perEmployer: true,
    defaultMode: 'ask',
    patterns: [/\b(?:located|live|based) within \d+ (?:miles|km|kilometers)\b/],
  }),
  F({
    key: 'onsite_ok',
    label: 'Can work on site / hybrid',
    tab: 'location',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [
      /\b(?:hybrid|in office|in person|on ?site)\b.*\b(?:days?|week|able|willing|comfortable)\b/,
      /\b(?:able|willing) to (?:work|come) (?:from|in|into) (?:our|the) (?:\w+ )?office\b/,
      /\bwork from (?:our|the) (?:\w+ )?office\b/,
    ],
  }),

  // ── Documents ──────────────────────────────────────────────────────────
  F({
    key: 'resume',
    label: 'Resume / CV',
    tab: 'documents',
    type: 'file',
    source: 'resume',
    defaultMode: 'autofill',
    native: { greenhouse: /^resume$/, ashby: /^_systemfield_resume$/, lever: /^resume$/ },
    patterns: [/^(?:your )?(?:resume|résumé|cv|resume cv|curriculum vitae)$/],
  }),
  F({
    key: 'cover_letter',
    label: 'Cover letter',
    tab: 'documents',
    type: 'file',
    source: 'resume',
    defaultMode: 'autofill',
    native: { greenhouse: /^cover_letter$/ },
    patterns: [/^(?:your )?cover letter$/],
    hint: 'Tailored to each job from your letters.',
  }),
  F({
    key: 'certification_file',
    label: 'Certificates / licences',
    tab: 'documents',
    type: 'file',
    source: 'ask',
    defaultMode: 'ask',
    patterns: [/\b(?:certification|certificate|licen[cs]e|licensure)\b.*\b(?:upload|attach|proof|copy)\b|\bupload\b.*\b(?:certification|licen[cs]e|licensure)\b/],
  }),

  // ── Education ──────────────────────────────────────────────────────────
  F({
    key: 'education_school',
    label: 'School',
    tab: 'education',
    type: 'text',
    source: 'resume',
    block: 'education',
    defaultMode: 'autofill',
    native: { greenhouse: /^school--\d+$/ },
    patterns: [/^(?:school|university|college|institution)(?: name)?$/, /^(?:most recent |highest )?(?:school|university) attended$/],
  }),
  F({
    key: 'education_degree',
    label: 'Degree',
    tab: 'education',
    type: 'text',
    source: 'resume',
    block: 'education',
    defaultMode: 'autofill',
    native: { greenhouse: /^degree--\d+$/ },
    patterns: [/^degree(?: type| obtained| earned)?$/],
  }),
  F({
    key: 'education_field',
    label: 'Field of study',
    tab: 'education',
    type: 'text',
    source: 'resume',
    block: 'education',
    defaultMode: 'autofill',
    native: { greenhouse: /^discipline--\d+$/ },
    patterns: [/^(?:discipline|major|field of study|area of study|concentration)$/],
  }),
  F({
    key: 'education_start_month',
    label: 'Education start month',
    tab: 'education',
    type: 'text',
    source: 'resume',
    block: 'education',
    defaultMode: 'autofill',
    native: { greenhouse: /^start-month--\d+$/ },
    patterns: [],
  }),
  F({
    key: 'education_start_year',
    label: 'Education start year',
    tab: 'education',
    type: 'number',
    source: 'resume',
    block: 'education',
    defaultMode: 'autofill',
    native: { greenhouse: /^start-year--\d+$/ },
    patterns: [],
  }),
  F({
    key: 'education_end_month',
    label: 'Education end month',
    tab: 'education',
    type: 'text',
    source: 'resume',
    block: 'education',
    defaultMode: 'autofill',
    native: { greenhouse: /^end-month--\d+$/ },
    patterns: [],
  }),
  F({
    key: 'education_end_year',
    label: 'Graduation year',
    tab: 'education',
    type: 'number',
    source: 'resume',
    block: 'education',
    defaultMode: 'autofill',
    native: { greenhouse: /^end-year--\d+$/ },
    patterns: [/^(?:graduation|grad) (?:year|date)$|^(?:year|date) of graduation$|\bwhen did you graduate\b/],
  }),
  F({
    key: 'highest_education',
    label: 'Highest level of education',
    tab: 'education',
    type: 'choice',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [/\bhighest (?:level of )?(?:education|degree|qualification)\b/, /^(?:level of )?education(?: level)?$/],
  }),
  F({
    key: 'has_high_school_diploma',
    label: 'High school diploma or GED',
    tab: 'education',
    type: 'boolean',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [/\bhigh school diploma\b|\bged\b/],
  }),
  F({
    key: 'has_bachelors',
    label: "Has a bachelor's degree",
    tab: 'education',
    type: 'boolean',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [/\b(?:do you have|have you (?:earned|completed|obtained)) an? (?:bachelor s|bachelors|undergraduate|4 year) degree\b/],
  }),

  // ── Experience ─────────────────────────────────────────────────────────
  F({
    key: 'employment_company',
    label: 'Employer (history entry)',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    block: 'employment',
    defaultMode: 'autofill',
    native: { greenhouse: /^company-name-\d+$/ },
    patterns: [],
  }),
  F({
    key: 'employment_title',
    label: 'Job title (history entry)',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    block: 'employment',
    defaultMode: 'autofill',
    native: { greenhouse: /^title-\d+$/ },
    patterns: [],
  }),
  F({
    key: 'employment_start_month',
    label: 'Job start month',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    block: 'employment',
    defaultMode: 'autofill',
    native: { greenhouse: /^start-date-month-\d+$/ },
    patterns: [],
  }),
  F({
    key: 'employment_start_year',
    label: 'Job start year',
    tab: 'experience',
    type: 'number',
    source: 'resume',
    block: 'employment',
    defaultMode: 'autofill',
    native: { greenhouse: /^start-date-year-\d+$/ },
    patterns: [],
  }),
  F({
    key: 'employment_end_month',
    label: 'Job end month',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    block: 'employment',
    defaultMode: 'autofill',
    native: { greenhouse: /^end-date-month-\d+$/ },
    patterns: [],
  }),
  F({
    key: 'employment_end_year',
    label: 'Job end year',
    tab: 'experience',
    type: 'number',
    source: 'resume',
    block: 'employment',
    defaultMode: 'autofill',
    native: { greenhouse: /^end-date-year-\d+$/ },
    patterns: [],
  }),
  F({
    key: 'employment_current',
    label: 'Current role (history entry)',
    tab: 'experience',
    type: 'boolean',
    source: 'resume',
    block: 'employment',
    defaultMode: 'autofill',
    native: { greenhouse: /^current-role-\d+$/ },
    patterns: [],
  }),
  F({
    key: 'current_title',
    label: 'Current job title',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    defaultMode: 'autofill',
    patterns: [
      /^(?:your )?(?:current|most recent|current most recent|current or most recent) (?:job )?(?:title|position|role)$/,
      /\bwhat is your current (?:job )?(?:title|position|role)\b/,
    ],
  }),
  F({
    key: 'current_employer',
    label: 'Current employer',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    defaultMode: 'autofill',
    native: { lever: /^org$/ },
    patterns: [
      /^(?:your )?(?:current|most recent|current most recent|current or most recent) (?:company|employer|organi[sz]ation)(?: name)?$/,
      /\bwho is your (?:current|most recent)\b.*\bemployer\b/,
      /\bname of your current\b.*\bcompany\b/,
      /^most recent employer$/,
    ],
  }),
  F({
    key: 'years_experience',
    label: 'Years of experience',
    tab: 'experience',
    type: 'number',
    source: 'computed',
    defaultMode: 'autofill',
    patterns: [
      /\bhow many years of (?:total |professional |relevant |overall )?(?:work |professional |industry )?experience do you have$/,
      /^(?:total )?years of (?:professional |work |relevant )?experience$/,
    ],
    hint: 'Counted from the dates on your CV.',
  }),
  F({
    key: 'years_experience_with',
    label: 'Years with a specific skill',
    tab: 'experience',
    type: 'number',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\bhow many years\b.*\b(?:experience|worked|working|using)\b/, /\bat least \d+ years? of\b.*\bexperience\b/],
  }),
  F({
    key: 'skill_proficiency',
    label: 'Skill proficiency',
    tab: 'experience',
    type: 'choice',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [
      /\b(?:advanced |expert )?proficiency (?:in|with)\b/,
      /\bwhich statement best describes your experience\b/,
      /\b(?:rate|describe) your (?:level of )?(?:experience|proficiency|expertise)\b/,
    ],
  }),
  F({
    key: 'skills',
    label: 'Skills',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    defaultMode: 'autofill',
    patterns: [/^(?:your )?(?:key |technical )?skills$/],
  }),
  F({
    key: 'tools_used',
    label: 'Tools and software used',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    draftable: true,
    defaultMode: 'autofill',
    patterns: [/\b(?:list|which) (?:any )?(?:software|tools|programs|technologies)\b.*\b(?:used|use|worked with)\b/],
  }),
  F({
    key: 'languages_spoken',
    label: 'Languages spoken',
    tab: 'experience',
    type: 'text',
    source: 'resume',
    defaultMode: 'autofill',
    patterns: [/\bwhich languages do you speak\b|^languages(?: spoken)?$|\blanguages? (?:do you speak|proficiency)\b/],
  }),
  F({
    key: 'managed_team',
    label: 'Has managed a team',
    tab: 'experience',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\b(?:directly )?(?:managed|led|supervised) (?:a )?(?:team|people|direct reports)\b|\bpeople management experience\b/],
  }),
  F({
    key: 'notice_period',
    label: 'Notice period',
    tab: 'experience',
    type: 'text',
    source: 'identity',
    column: 'notice_period_days',
    defaultMode: 'autofill',
    patterns: [/\b(notice period)\b/],
  }),
  F({
    key: 'earliest_start_date',
    label: 'Earliest start date',
    tab: 'experience',
    type: 'date',
    source: 'identity',
    column: 'earliest_start_date',
    defaultMode: 'autofill',
    // When the applicant could start — not the "Start date month" of a past
    // job in an employment-history block.
    patterns: [
      /^(?:your )?(?:(?:earliest|preferred|desired|available|possible|expected) )*start date$|\b(?:earliest|soonest) (?:possible )?start\b|\bwhen (?:can|could|would) you (?:be able to )?start\b|\bavailable (?:to start|from)\b/,
    ],
  }),
  F({
    key: 'desired_salary',
    label: 'Salary expectation',
    tab: 'experience',
    type: 'text',
    source: 'identity',
    column: 'desired_salary',
    defaultMode: 'autofill',
    patterns: [
      /\b(salary expectations?|desired salary|expected salary|compensation expectations?)\b/,
      // "What's your expected annual salary?", "expected monthly pay": a word between.
      /\b(?:expected|desired|anticipated|target)\s+(?:(?:annual|yearly|monthly|base|gross|total|yearly)\s+)+(?:salary|compensation|pay)\b/,
      /\b(?:target|desired|expected) (?:total )?(?:compensation|salary|pay)(?: range)?\b/,
      /\b(?:total )?compensation requirements?\b|\bsalary requirements?\b/,
    ],
  }),
  F({
    key: 'current_salary',
    label: 'Current salary',
    tab: 'experience',
    type: 'text',
    source: 'answer_bank',
    sensitivity: 'private',
    defaultMode: 'ask',
    patterns: [/\bcurrent (?:base )?(?:salary|compensation|pay)\b/],
  }),
  F({
    key: 'weekend_availability',
    label: 'Available weekends / shifts',
    tab: 'experience',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\b(?:available|availability) to work (?:weekends|nights|evenings|shifts)\b|\bwork (?:weekends|night shifts)\b/],
  }),
  F({
    key: 'non_compete',
    label: 'Bound by a non-compete',
    tab: 'experience',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\bnon ?compete\b|\bnon ?solicitation\b/],
  }),
  F({
    key: 'previously_employed_here',
    label: 'Worked at this employer before',
    tab: 'experience',
    type: 'boolean',
    source: 'resume',
    perEmployer: true,
    defaultMode: 'autofill',
    patterns: [
      /\b(?:have you|are you currently or have you) (?:ever )?(?:previously )?(?:been )?(?:worked|employed|work)\b.*\b(?:for|at|by)\b(?:\s|$)/,
      /\b(?:are you currently or have you previously|have you previously|have you ever) (?:been )?(?:worked|employed)\b/,
      /^have you (?:previously )?worked (?:at|for) in the past\b/,
      /^have you worked at in the past\b/,
      /^have you ever been previously employed by$/,
    ],
    unless: /\bpartner\b|\bmanaged\b|\bteam\b|\bremote\b/,
    hint: 'Answered from the employers on your CV.',
  }),
  F({
    key: 'employed_by_partner',
    label: 'Works for a partner of the employer',
    tab: 'experience',
    type: 'boolean',
    source: 'answer_bank',
    perEmployer: true,
    defaultMode: 'ask',
    patterns: [/\b(?:currently )?employed by a\b.*\bpartner\b/],
  }),

  // ── EEO ────────────────────────────────────────────────────────────────
  // Voluntary self-identification. Never inferred from a name or a photo;
  // filled only with what the applicant stated, and declined by default.
  F({
    key: 'eeo_decline_all',
    label: 'Decline all demographic questions',
    tab: 'eeo',
    type: 'boolean',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    patterns: [/^i decline to answer the following questions$/],
  }),
  F({
    key: 'eeo_transgender',
    label: 'Transgender',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    patterns: [/\btransgender\b/],
  }),
  F({
    key: 'eeo_sexual_orientation',
    label: 'Sexual orientation',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    patterns: [/\bsexual orientation\b|\blgbtq\w*\b|\b2slgbtqia\b/],
  }),
  F({
    key: 'eeo_gender',
    label: 'Gender',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    native: { greenhouse: /^gender$/, ashby: /^_systemfield_eeoc_gender$/, lever: /^eeo\[gender\]$/ },
    patterns: [/^(?:your )?gender(?: identity)?$/, /\bgender(?: identity)?\b/, /^(?:what )?gender do you identify (?:as|with)$/],
    hint: 'Only what you state here. Never guessed from your name or photo.',
  }),
  F({
    key: 'eeo_hispanic_latino',
    label: 'Hispanic or Latino',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    native: { greenhouse: /^hispanic_ethnicity$/ },
    patterns: [/\bhispanic\b.*\blatin[oaxe]\b|^are you hispanic\b/],
  }),
  F({
    key: 'eeo_race_ethnicity',
    label: 'Race / ethnicity',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    native: { ashby: /^_systemfield_eeoc_race$/, lever: /^eeo\[race\]$/ },
    patterns: [/\brac(?:e|ial)\b|\bethnicit(?:y|ies)\b|\bperson of colou?r\b|\bnational heritage\b/],
  }),
  F({
    key: 'eeo_veteran',
    label: 'Veteran status',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    native: { greenhouse: /^veteran_status$/, ashby: /^_systemfield_eeoc_veteran_status$/, lever: /^eeo\[veteran\]$/ },
    patterns: [/\bveteran\b|\barmed forces\b|\bserved in the military\b/],
  }),
  F({
    key: 'eeo_disability',
    label: 'Disability status',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    native: { greenhouse: /^disability_status$/, lever: /^eeo\[disability\]$/ },
    patterns: [/\bdisabilit(?:y|ies)\b|\bchronic condition\b|\bimpairment\b/],
  }),
  F({
    key: 'eeo_age_range',
    label: 'Age range',
    tab: 'eeo',
    type: 'choice',
    source: 'computed',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    patterns: [/^what is your (?:current )?age$/, /\bage range\b/],
    hint: 'Computed from your date of birth — only if you switch this to autofill.',
  }),
  F({
    key: 'eeo_communities',
    label: 'Communities you belong to',
    tab: 'eeo',
    type: 'choice',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    patterns: [/\bwhich of the following communities\b/],
  }),
  F({
    key: 'eeo_self_describe',
    label: 'Self-description',
    tab: 'eeo',
    type: 'text',
    source: 'identity',
    sensitivity: 'eeo',
    defaultMode: 'decline_or_blank',
    patterns: [/\bself describe\b/],
  }),

  // ── Social & links ─────────────────────────────────────────────────────
  F({
    key: 'linkedin_url',
    label: 'LinkedIn',
    tab: 'links',
    type: 'text',
    source: 'identity',
    column: 'linkedin_url',
    defaultMode: 'autofill',
    native: { lever: /^urls\[LinkedIn\]$/ },
    patterns: [/^(?:your )?linkedin\b|\blinkedin (?:profile|url|link)\b/],
  }),
  F({
    key: 'github_url',
    label: 'GitHub',
    tab: 'links',
    type: 'text',
    source: 'identity',
    column: 'github_url',
    defaultMode: 'autofill',
    native: { lever: /^urls\[GitHub\]$/ },
    patterns: [/^(?:your )?github\b|\bgithub (?:profile|url|link)\b/],
  }),
  F({
    key: 'portfolio_url',
    label: 'Portfolio / website',
    tab: 'links',
    type: 'text',
    source: 'identity',
    column: 'portfolio_url',
    defaultMode: 'autofill',
    native: { lever: /^urls\[(?:Portfolio|Personal Website)\]$/ },
    patterns: [/^(?:your )?(?:portfolio|personal website|website)\b|\b(?:portfolio|personal website) (?:url|link)\b/],
  }),
  F({
    key: 'twitter_url',
    label: 'X / Twitter',
    tab: 'links',
    type: 'text',
    source: 'identity',
    column: 'twitter_url',
    defaultMode: 'autofill',
    native: { lever: /^urls\[Twitter\]$/ },
    patterns: [/^(?:your )?(?:twitter|x)(?: (?:profile|url|handle|link))?(?: url)?$/],
  }),
  F({
    key: 'other_website',
    label: 'Other link',
    tab: 'links',
    type: 'text',
    source: 'identity',
    column: 'other_url',
    defaultMode: 'autofill',
    native: { lever: /^urls\[Other\]$/ },
    patterns: [/^other (?:website|url|link|profile)s?$/],
  }),

  // ── Other: recurring screening questions, consents and essays ─────────
  F({
    key: 'referral_source_details',
    label: 'How you heard (details)',
    tab: 'other',
    type: 'text',
    source: 'ask',
    defaultMode: 'ask',
    patterns: [/^if you selected other\b/],
  }),
  F({
    key: 'referral_source',
    label: 'How you heard about the job',
    tab: 'other',
    type: 'choice',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [
      /\bhow did you (?:hear|learn|find out) about\b/,
      /\bwhere (?:did|have) you (?:hear|learn|learned|heard|find|found) (?:about )?/,
      /^(?:referral )?source$/,
    ],
  }),
  F({
    key: 'referred_by_insider',
    label: 'Referred by someone at the company',
    tab: 'other',
    type: 'boolean',
    source: 'answer_bank',
    perEmployer: true,
    defaultMode: 'ask',
    patterns: [/\b(?:were|are) you referred\b|\breferred (?:to this position )?by\b/],
  }),
  F({
    key: 'relatives_employed',
    label: 'Relatives working there',
    tab: 'other',
    type: 'boolean',
    source: 'answer_bank',
    perEmployer: true,
    defaultMode: 'ask',
    patterns: [
      /\b(?:family members?|relatives?|household members?)\b.*\b(?:employed|work(?:ing)? (?:at|for))\b/,
      /^do you have any (?:family members|relatives|household members)\b/,
    ],
  }),
  F({
    key: 'conditional_details',
    label: '"If yes, please specify" follow-ups',
    tab: 'other',
    type: 'text',
    source: 'ask',
    defaultMode: 'decline_or_blank',
    patterns: [/^if (?:yes|so)\b/],
    hint: 'Left blank when your answer to the question before was "No".',
  }),
  F({
    key: 'government_official_relative',
    label: 'Relative of a government official',
    tab: 'other',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\b(?:close )?relative of a (?:current |former )?government official\b/],
  }),
  F({
    key: 'government_official',
    label: 'Government official',
    tab: 'other',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\bgovernment official\b/],
  }),
  F({
    key: 'conflict_of_interest',
    label: 'Conflict of interest',
    tab: 'other',
    type: 'boolean',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\bconflicts? of interest\b|\bsignificant financial interest\b/],
  }),
  F({
    key: 'contact_preference',
    label: 'Preferred contact method',
    tab: 'other',
    type: 'choice',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\bpreferred (?:method|way) (?:for|of) (?:receiving|contact|communication)\b|\bhow (?:should|would you like) we contact you\b/],
  }),
  F({
    key: 'ai_tool_usage',
    label: 'How you use AI tools',
    tab: 'other',
    type: 'choice',
    source: 'answer_bank',
    defaultMode: 'autofill',
    patterns: [/\bhow you use ai tools\b|\buse (?:of )?ai tools today\b/],
  }),
  F({
    key: 'privacy_consent',
    label: 'Privacy / data-processing consent',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'ask',
    native: { greenhouse: /^gdpr_/, ashby: /^_systemfield_data_consent_ack$/ },
    patterns: [
      /\bprivacy (?:policy|notice)\b/,
      /\b(?:processing of )?personal data\b/,
      /\bconsent to (?:collect|store|process)\b|\bhas my consent to collect\b/,
      /^i agree$/,
      /\bi agree\b.*\b(?:processed|information)\b/,
    ],
    hint: 'Always yours to tick.',
  }),
  F({
    key: 'ai_policy_ack',
    label: 'AI-use acknowledgement',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'ask',
    patterns: [/\bai (?:usage |use )?(?:attestation|policy)\b|\bmay use ai tools\b/],
  }),
  F({
    key: 'sms_consent',
    label: 'Text-message consent',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'decline_or_blank',
    native: { ashby: /^communicationConsent$/ },
    patterns: [/\bconsent to receiv(?:e|ing) (?:text|sms)\b|\btext messages?\b/],
  }),
  F({
    key: 'future_opportunities_consent',
    label: 'Contact about future roles',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'decline_or_blank',
    native: { lever: /^consent\[marketing\]$/ },
    patterns: [/\b(?:future|other) (?:job )?opportunities\b|\btalent (?:pool|community)\b/],
  }),
  F({
    key: 'background_check_consent',
    label: 'Background check consent',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'ask',
    patterns: [/\bbackground check\b|\bdrug (?:screen|test)\w*\b/],
  }),
  F({
    key: 'reference_check_consent',
    label: 'Reference check consent',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'ask',
    patterns: [/\breferences?\b.*\b(?:contact|validate|check)\b|\b(?:contact|check) (?:your |additional )?references\b/],
  }),
  F({
    key: 'truthfulness_attestation',
    label: 'Information-is-accurate attestation',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'ask',
    patterns: [/\btruthful and accurate\b|\bhereby certify\b|\bnot knowingly withheld\b|\binformation (?:provided )?is (?:true|accurate|correct)\b/],
  }),
  F({
    key: 'reviewed_job_description',
    label: 'Read the job description',
    tab: 'other',
    type: 'boolean',
    source: 'ask',
    sensitivity: 'consent',
    defaultMode: 'ask',
    patterns: [/\bi (?:confirm|acknowledge) that i have (?:read|reviewed) the job description\b/],
  }),
  F({
    key: 'why_company',
    label: 'Why this company',
    tab: 'other',
    type: 'text',
    source: 'answer_bank',
    draftable: true,
    perEmployer: true,
    defaultMode: 'autofill',
    patterns: [
      /\bwhy (?:do you want|would you like|are you interested|are you excited) (?:in |to )?(?:work(?:ing)? (?:at|for|with)|join(?:ing)?)\b/,
      /^why (?:us|here|this company)$/,
      /\bwhat (?:attracts|draws) you to (?:our company|us|work(?:ing)? (?:at|for))\b/,
    ],
  }),
  F({
    key: 'why_role',
    label: 'Why this role',
    tab: 'other',
    type: 'text',
    source: 'answer_bank',
    draftable: true,
    perEmployer: true,
    defaultMode: 'autofill',
    patterns: [
      /\bwhat (?:excites|interests|draws|attracts) you (?:about|to) (?:the|this)\b.*\b(?:role|position|opportunity|team|job)\b/,
      /\bwhy are you interested in (?:this|the)\b.*\b(?:role|position|aspect)\b/,
      /\bwhy (?:this|the) (?:role|position)\b/,
      /\bwhy are you (?:interested in|applying for) this (?:role|position|job)\b/,
    ],
  }),
  F({
    key: 'jd_highlight',
    label: 'What stood out in the job description',
    tab: 'other',
    type: 'text',
    source: 'answer_bank',
    draftable: true,
    perEmployer: true,
    defaultMode: 'autofill',
    patterns: [/\b(?:one thing|what) in this job description (?:that )?stood out\b|\bstood out to you\b/],
  }),
  F({
    key: 'relevant_experience',
    label: 'Relevant experience (essay)',
    tab: 'other',
    type: 'text',
    source: 'answer_bank',
    draftable: true,
    defaultMode: 'autofill',
    patterns: [
      /\b(?:describe|tell (?:me|us) about) your (?:most )?(?:relevant )?\w* ?(?:or \w+ )?experience\b/,
      /\bmost relevant experience\b/,
    ],
  }),
  F({
    key: 'proudest_achievement',
    label: 'Proudest achievement (essay)',
    tab: 'other',
    type: 'text',
    source: 'answer_bank',
    draftable: true,
    defaultMode: 'autofill',
    patterns: [
      /\b(?:hardest|most challenging|most impressive|proudest)\b.*\b(?:built|achieved|accomplished|shipped|project)\b/,
      /\bmost proud of\b|\bproudest (?:achievement|accomplishment)\b/,
    ],
  }),
  F({
    key: 'behavioral_example',
    label: 'An example from your work (essay)',
    tab: 'other',
    type: 'text',
    source: 'answer_bank',
    draftable: true,
    perEmployer: true,
    defaultMode: 'autofill',
    patterns: [/\b(?:share|give|provide|describe) an example\b|\btell (?:us|me) about a time\b|\bdescribe a (?:time|situation)\b/],
    hint: 'Drafted per application from your CV, for you to review.',
  }),
  F({
    key: 'professional_summary',
    label: 'About you / summary',
    tab: 'other',
    type: 'text',
    source: 'resume',
    draftable: true,
    defaultMode: 'autofill',
    patterns: [/^(?:tell us )?about (?:you|yourself)$|^(?:professional )?summary$|\btell us about yourself\b/],
  }),
  F({
    key: 'additional_info',
    label: 'Anything else to add',
    tab: 'other',
    type: 'text',
    source: 'answer_bank',
    defaultMode: 'decline_or_blank',
    patterns: [/^additional (?:information|comments|info)$|\banything else (?:you would like|you d like|we should know)\b/],
    hint: 'Left blank unless you write something here.',
  }),
]

export const FIELDS_BY_KEY: ReadonlyMap<string, CanonicalField> = new Map(CANONICAL_FIELDS.map((field) => [field.key, field]))

export function fieldByKey(key: string): CanonicalField | undefined {
  return FIELDS_BY_KEY.get(key)
}

/** The mode a field runs in for this user. Consents can never autofill: they
 * are the applicant's to give, per application. */
export function effectiveMode(field: CanonicalField, modes: Record<string, AutofillMode> | undefined): AutofillMode {
  const chosen = modes?.[field.key] ?? field.defaultMode
  if (field.sensitivity === 'consent' && chosen === 'autofill') return 'ask'
  return chosen
}

/**
 * The work-authorization regions the Field Mapper offers out of the box.
 * Codes are ISO 3166-1 alpha-2, plus `EU` for the whole union (an EU citizen
 * may work in every member state). The table accepts any other two-letter code.
 */
export const COMMON_WORK_REGIONS: Array<{ code: string; label: string }> = [
  { code: 'US', label: 'United States' },
  { code: 'EU', label: 'European Union' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Australia' },
  { code: 'SG', label: 'Singapore' },
  { code: 'ID', label: 'Indonesia' },
  { code: 'IN', label: 'India' },
  { code: 'DE', label: 'Germany' },
]

/** EEO categories the Field Mapper keeps an explicit answer for. `decline` is the default. */
export const EEO_CATEGORIES = [
  'eeo_gender',
  'eeo_race_ethnicity',
  'eeo_hispanic_latino',
  'eeo_veteran',
  'eeo_disability',
  'eeo_sexual_orientation',
  'eeo_transgender',
  'eeo_age_range',
  'eeo_communities',
] as const
export type EeoCategory = (typeof EEO_CATEGORIES)[number]

export const EEO_DECLINE = 'decline'

/**
 * What the Auto Apply gate checks, now expressed as registry fields. The item
 * names are the 409 body's contract with the client (src/lib/profileReadiness.ts),
 * so they stay as they were; what satisfies each is read off the registry.
 */
export const READINESS_ITEMS = {
  name: ['full_name'],
  phone: ['phone'],
  location: ['current_location'],
  social_links: ['linkedin_url', 'portfolio_url', 'github_url'],
  base_resume: ['resume'],
  cover_letter: ['cover_letter'],
} as const satisfies Record<string, readonly string[]>

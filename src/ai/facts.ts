/**
 * A deterministic check on the one kind of fabrication a rewrite prompt cannot
 * be trusted to avoid: numbers.
 *
 * Every rewriting prompt in this codebase says "never state a number the CV
 * does not already contain", and every model benchmarked still does it a few
 * times per run — "shipping 15+ new components", "a team of five engineers".
 * A recruiter cannot tell those from the real figures, and a candidate who
 * clicks one without noticing gets caught in the interview. Prose claims are
 * for the prompt to govern; quantities can be checked here.
 */

/** Spelled-out quantities, folded to digits so "three engineers" and "3
 * engineers" are the same claim. "one" is left out: as a pronoun ("one flow",
 * "one click") it is far more often not a quantity. Compound forms
 * ("twenty-five") fold to their parts, which is close enough to catch a
 * figure that appears nowhere in the source. */
const NUMBER_WORDS: Record<string, string> = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40',
  fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100',
  hundreds: '100', thousand: '1000', thousands: '1000', million: '1000000', millions: '1000000',
  dozen: '12', dozens: '12',
}

const WORD_PATTERN = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi')

const SUFFIX_MULTIPLIER: Record<string, number> = { k: 1_000, m: 1_000_000 }

/** Every quantity in a text, normalised so "1,200", "1200" and "1.2k" compare
 * by what they say rather than how they are typed. Digits glued to a
 * preceding letter ("e2e", "p75", "H2") are identifiers, not quantities, and
 * are skipped; a trailing unit ("4.1s", "35%") is a quantity and is kept, and
 * a k/M suffix is folded into the number so "12k lines" and "12,000 lines"
 * are the same claim. */
export function numbersIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/(?<![A-Za-z\d])(\d[\d,]*(?:\.\d+)?)(?:([kKmM])\b)?/g)) {
    const value = match[1].replace(/,/g, '')
    const multiplier = match[2] ? SUFFIX_MULTIPLIER[match[2].toLowerCase()] : 1
    found.add(multiplier === 1 ? value : String(Number(value) * multiplier))
  }
  for (const match of text.matchAll(WORD_PATTERN)) {
    found.add(NUMBER_WORDS[match[1].toLowerCase()])
  }
  return found
}

/** The quantities in `candidate` that appear nowhere in `source`. Quantities
 * the source already states may be moved, reordered or restated. */
export function newNumbersIn(candidate: string, source: string | Set<string>): string[] {
  const allowed = typeof source === 'string' ? numbersIn(source) : source
  return [...numbersIn(candidate)].filter((number) => !allowed.has(number))
}

/** True when `candidate` contains a quantity that appears nowhere in `source`. */
export function introducesNewNumbers(candidate: string, source: string | Set<string>): boolean {
  return newNumbersIn(candidate, source).length > 0
}

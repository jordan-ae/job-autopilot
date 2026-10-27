/**
 * A salary figure restated in the period a form asks for.
 *
 * The profile can say "3500 USD per month" (a resume profile's compensation
 * section, profiles/overrides.ts) while a form asks for the annual figure; the
 * answer is the arithmetic, not a guess. A figure that states no period is
 * left as it is: nothing says what it was meant for, and a salary is not a
 * place to assume.
 */

export type SalaryPeriod = 'year' | 'month' | 'hour'

const PER_YEAR: Record<SalaryPeriod, number> = { year: 1, month: 12, hour: 2080 }

/** "3500 USD per month" → 3500, USD, month. Null when it is not that shape. */
export function parseSalary(value: string): { amount: number; currency: string; period: SalaryPeriod | null } | null {
  const match = /^\s*(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]{3})?(?:\s*(?:per|\/|a)\s*(year|yr|annum|month|mo|hour|hr))?\s*$/i.exec(value)
  if (!match) return null
  const amount = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  const unit = match[3]?.toLowerCase()
  const period: SalaryPeriod | null = !unit ? null : /^(year|yr|annum)$/.test(unit) ? 'year' : /^(month|mo)$/.test(unit) ? 'month' : 'hour'
  return { amount, currency: (match[2] ?? '').toUpperCase(), period }
}

/** The period a question's wording asks for, or null when it does not say. */
export function periodAsked(text: string): SalaryPeriod | null {
  const t = text.toLowerCase()
  if (/\b(?:annual(?:ly)?|yearly|per year|per annum|a year|\/\s*year|p\.?a\.?|12[- ]month)\b/.test(t)) return 'year'
  if (/\b(?:monthly|per month|a month|\/\s*month)\b/.test(t)) return 'month'
  if (/\b(?:hourly|per hour|an hour|\/\s*hour)\b/.test(t)) return 'hour'
  return null
}

const plain = (salary: { amount: number; currency: string }) => `${salary.amount}${salary.currency ? ` ${salary.currency}` : ''}`

/** The stored figure in the period the question asks for; unchanged when either side does not say. */
export function salaryForQuestion(stored: string, questionText: string): string {
  const salary = parseSalary(stored)
  const asked = periodAsked(questionText)
  if (!salary || !salary.period || !asked) return stored
  if (salary.period === asked) return plain(salary)
  const converted = Math.round((salary.amount * PER_YEAR[salary.period]) / PER_YEAR[asked])
  return plain({ amount: converted, currency: salary.currency })
}

/**
 * Question wording, normalized. Lives here rather than in plan/answers.ts
 * because the field classifier and the answer bank both key on it, and
 * answers.ts in turn resolves through the classifier.
 */

/**
 * Normalize a question label to a stable key we can look up stored answers by.
 * Lowercased, punctuation stripped, employer name removed, whitespace collapsed
 * — so "Do you require sponsorship to work at Acme, Inc.?" reads the same at
 * every employer and the patterns in fields/registry.ts only have to know one
 * wording.
 *
 * Removing the name does not make a question generic. One that names its
 * employer ("Why Acme?") is about that employer; see `namesCompany`.
 */
export function fingerprintQuestion(label: string, company = ''): string {
  let text = label.toLowerCase()
  if (company.trim()) {
    const escaped = company.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`\\b${escaped}\\b(?:[,\\s]+(?:inc|llc|ltd|gmbh|bv|ag|sa)\\b\\.?)?`, 'g'), '')
  }
  return text
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * True when `text` mentions the employer by name.
 *
 * A question that names the employer, or an answer that does, belongs to that
 * one application. "Why do you want to work at Acme?" answered with "I have
 * followed Acme's launches for years" must never be offered to Beta — and
 * with the name stripped from the fingerprint, that is exactly what the
 * answer bank used to do.
 *
 * Board slugs give us names like "mavenclinic" for "Maven Clinic", so a
 * longer name is also matched with spacing and punctuation ignored. Short
 * names only match as whole words: "Ro" is not in "product".
 */
export function namesCompany(text: string, company: string): boolean {
  const name = company.trim().toLowerCase()
  if (name.length < 2) return false
  const haystack = text.toLowerCase()

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack)) return true

  const compact = name.replace(/[^a-z0-9]/g, '')
  return compact.length >= 6 && haystack.replace(/[^a-z0-9]/g, '').includes(compact)
}

/** Answer-bank fingerprint for a value set on the Field Mapper itself. */
export const fieldFingerprint = (key: string) => `field:${key}`

/** Answer-bank fingerprint for an answer that belongs to one job only. Never
 * equal to a real question's fingerprint, which has no '#'. */
export const jobFingerprint = (fingerprint: string, jobId: string) => `${fingerprint}#job:${jobId}`

/** The option among `options` that declines to answer, when exactly one does. */
export function findDeclineOption(options: string[] | undefined): string | null {
  const hits = (options ?? []).filter((option) =>
    /\bdecline\b|\bprefer not\b|\bdon.?t (?:wish|want)\b|\bdo not (?:wish|want)\b|\bnot to (?:answer|disclose|say|self[- ]identify|respond)\b|\bchoose not\b|\brather not\b/i.test(option),
  )
  return hits.length === 1 ? hits[0] : null
}

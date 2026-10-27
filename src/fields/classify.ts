import { CANONICAL_FIELDS, type CanonicalField, type FormAtsName } from './registry.js'
import { fingerprintQuestion } from './text.js'

/**
 * Which canonical field a form question is — the deterministic part.
 *
 * The ATS's own field name decides first (Greenhouse's `first_name`, Lever's
 * `urls[GitHub]`): that is the form telling us, not us reading. Then the
 * wording, against the registry's patterns in order. Anything left goes to
 * the agent pass (fields/agent.ts), which consults a shared classification
 * cache and only then a model — and leaves the question unmapped rather than
 * guess when the model is unsure.
 */

export interface QuestionShape {
  label: string
  description?: string
  section?: string
  /** The ATS-native field key. */
  key?: string
  ats?: FormAtsName | string
  /** Fill-engine kind or adapter type: 'select', 'radio', 'textarea', 'boolean'… */
  kind?: string
  options?: string[]
}

export type ClassificationVia = 'native' | 'pattern' | 'cache' | 'model'

export interface Classification {
  field: CanonicalField
  via: ClassificationVia
  /** 1 for native and pattern matches; the model's confidence otherwise. */
  confidence: number
  /** For a repeating CV block (employment history entry 2), which entry. */
  entryIndex?: number
}

function entryIndexOf(key: string | undefined): number | undefined {
  const match = /-(\d+)$/.exec(key ?? '')
  return match ? Number(match[1]) : undefined
}

function sectionAllows(field: CanonicalField, section: string | undefined): boolean {
  return !field.section || field.section.test(section ?? '')
}

export function classifyNative(question: QuestionShape): Classification | null {
  const ats = question.ats as FormAtsName | undefined
  if (!ats || !question.key) return null
  for (const field of CANONICAL_FIELDS) {
    const native = field.native?.[ats]
    if (native && native.test(question.key) && sectionAllows(field, question.section)) {
      return {
        field,
        via: 'native',
        confidence: 1,
        ...(field.block ? { entryIndex: entryIndexOf(question.key) ?? 0 } : {}),
      }
    }
  }
  return null
}

export function classifyByPattern(fingerprint: string, section?: string): Classification | null {
  if (!fingerprint) return null
  for (const field of CANONICAL_FIELDS) {
    if (!sectionAllows(field, section)) continue
    if (!field.patterns.some((pattern) => pattern.test(fingerprint))) continue
    if (field.unless?.test(fingerprint)) continue
    return { field, via: 'pattern', confidence: 1, ...(field.block ? { entryIndex: 0 } : {}) }
  }
  return null
}

/**
 * Native key first, then wording. Null when neither recognises the question.
 *
 * An essay box often has a two-word title ("Scaling experience") and the
 * real prompt underneath; for free-text fields the help text is read too.
 */
export function classifyQuestion(question: QuestionShape, company = ''): Classification | null {
  const direct = classifyNative(question) ?? classifyByPattern(fingerprintQuestion(question.label, company), question.section)
  if (direct || !question.description || !/^(text|textarea)$/.test(question.kind ?? '')) return direct
  const fromHelp = classifyByPattern(fingerprintQuestion(question.description, company), question.section)
  // Only essays: a description never turns a short field into a profile value.
  return fromHelp && fromHelp.field.draftable ? fromHelp : null
}

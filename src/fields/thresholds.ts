/**
 * Every confidence bar the agent pass acts on, in one place.
 *
 * Jev's confidence is 1 when all probability sits on one answer and 0 when
 * it is spread evenly (https://docs.typesafe.ai/confidence). Below a bar the
 * agent does nothing — the field stays unmapped or the applicant is asked —
 * so a bar set too high costs the user a question, and one set too low costs
 * them a wrong answer sent to an employer. Every bar starts high for that
 * reason; lower one only with measurements behind it.
 *
 * These were set against the pinned model (env.typesafeModel). A model
 * upgrade means re-checking them.
 *
 * Live check, 2026-10-20, jev-1.13.0 (scratch script, not a test):
 * - mapLabel: one fixture question per canonical field, wording only (no
 *   ATS keys), 103 questions: 92 right overall. At ≥ 0.9 it acted on 77 and
 *   got 3 wrong — two were Greenhouse's identical "End date year/month"
 *   wordings (education vs employment), which native keys settle before the
 *   model is ever asked, and one was "Location (City)" → city. Every other
 *   miss was below 0.85.
 * - pickOption: 7 of 8 right, all at ≥ 0.95; the one it should have refused
 *   ("No" against "No, never" / "No, not currently") came back at 0.48.
 * - needsProse: 12 questions, the essays scored 0.85–0.96, the facts
 *   (postal code, years of X, start date, salary, "how did you hear")
 *   ≤ 0.36. "Additional information" scored 0.73.
 * Cost: ~2.5k input tokens per question mapped (the field list rides along
 * with each question), ≈ $0.001 each before the shared cache; ~460 ms a call.
 */
export const DECISION_THRESHOLDS = {
  /** Map an unrecognised question to a canonical field. A wrong mapping fills
   * the wrong value everywhere the cache serves it, so this is the strictest. */
  mapLabel: 0.9,
  /** Pick the option that says the same as a value we already hold
   * ("No" → "No, I will not require sponsorship"). */
  pickOption: 0.9,
  /** Noul: probability the question wants a written answer. At or above this
   * the agent drafts one; at or below 1 − this, it does not; between, it asks. */
  needsProse: 0.8,
} as const

/** Above this many unmapped questions on one form, map only the required
 * ones — a 60-question form is not worth 60 classifications. */
export const MAX_MODEL_QUESTIONS_PER_FORM = 40

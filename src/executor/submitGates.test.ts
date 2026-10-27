import { describe, expect, it } from 'vitest'
import type { PageClassification } from 'ats-form-fill'
import type { FilledField, PageRun, ReadBack } from './pageRun.js'
import { decideSubmitGates, readsAsPlanned, statedCompanyCap, TRAP_WORDING, type SubmitGateInput } from './submitGates.js'

/**
 * Each pre-submit gate on its own, on hand-made page runs. The captured forms
 * get theirs in submitGates.fixtures.test.ts.
 */

const URL_OK = 'https://jobs.ashbyhq.com/acme/1/application'
const form = (overrides: Partial<PageClassification> = {}): PageClassification => ({ state: 'form', evidence: 'ashby', challenges: [], ...overrides })

function field(key: string, overrides: Partial<FilledField> = {}): FilledField {
  return { key, label: key, kind: 'text', required: true, source: 'profile', ok: true, observed: `${key}-value`, reason: '', planned: `${key}-value`, layer: 'identity', ...overrides }
}

function readBackOf(filled: FilledField[], extra: ReadBack[] = []): ReadBack[] {
  return [...filled.map((entry) => ({ key: entry.key, label: entry.label, kind: entry.kind, required: entry.required, observed: entry.observed })), ...extra]
}

function pageRun(filled: FilledField[], extra: { readBack?: ReadBack[]; fields?: PageRun['fields'] } = {}): PageRun {
  const readBack = readBackOf(filled, extra.readBack)
  return {
    before: form(),
    after: form(),
    fields:
      extra.fields ??
      readBack.map((entry) => ({ selector: `#${entry.key}`, key: entry.key, kind: entry.kind, inputType: '', label: entry.label, description: '', section: '', required: entry.required, options: [], maxLength: null, accept: '' })),
    filled,
    left: [],
    readBack,
    finalUrl: URL_OK,
    fillMs: 10,
    challenge: { seen: false, solved: false, kinds: [], waits: 0, waitedMs: 0 },
  }
}

const RESUME = field('resume', { kind: 'file', label: 'Resume', source: 'document', observed: 'ada.pdf', planned: 'ada.pdf', layer: undefined })

function input(overrides: Partial<SubmitGateInput> = {}, filled: FilledField[] = [field('name'), field('email'), RESUME]): SubmitGateInput {
  return {
    run: pageRun(filled),
    prePress: form(),
    prePressUrl: URL_OK,
    submitTarget: { selector: '[data-arkoo-submit="1"]', text: 'Submit Application', disabled: false, count: 1 },
    questions: [],
    agentQuestionIds: [],
    reviewedQuestionIds: [],
    drafts: { policy: 'review_first', reviewedCount: 0, reviewFirst: 5 },
    approved: false,
    documents: { tailoredDocumentId: 'doc-1', resumeFileName: 'ada.pdf', coverLetterFileName: null, coverLetterText: '' },
    job: { active: true },
    caps: { appliedToday: 0, dailyLimit: 5, companyApplied: 0, companyCap: 1, companyWindowDays: 30 },
    budget: { spentUsd: 0.5, budgetUsd: 4, thisRunUsd: 0.002 },
    eligibility: { matchScore: null, minMatch: 0.6, verdict: null },
    ...overrides,
  }
}

describe('decideSubmitGates', () => {
  it('passes a clean, fully planned form and runs every gate', () => {
    const decision = decideSubmitGates(input())
    expect(decision.outcome).toBe('passed')
    expect(Object.values(decision.gates).every((gate) => gate.ok && gate.ran)).toBe(true)
    expect(Object.keys(decision.gates)).toHaveLength(13)
  })

  describe('no_challenge', () => {
    it('blocks on a bot check that appeared right before the press', () => {
      const prePress = form({ state: 'challenge', evidence: 'email-code: input security-code', challenges: [{ kind: 'email-code', state: 'blocking', evidence: 'input security-code' }] })
      expect(decideSubmitGates(input({ prePress }))).toMatchObject({ outcome: 'blocked', blockedReason: 'email-code' })
    })

    it('lets a scoring check that is only loaded through', () => {
      const prePress = form({ challenges: [{ kind: 'recaptcha-v3', state: 'present', evidence: 'api.js' }] })
      expect(decideSubmitGates(input({ prePress })).outcome).toBe('passed')
    })
  })

  it('on_form_host: hands back a form that moved off the ATS', () => {
    expect(decideSubmitGates(input({ prePressUrl: 'https://careers.acme.com/apply' }))).toMatchObject({ outcome: 'hand_back', blockedReason: 'off_host' })
  })

  describe('job_open', () => {
    it('hands back a posting marked closed', () => {
      expect(decideSubmitGates(input({ job: { active: false } }))).toMatchObject({ outcome: 'hand_back', blockedReason: 'closed' })
    })
    it('hands back a page that turned into "closed"', () => {
      expect(decideSubmitGates(input({ prePress: form({ state: 'closed', evidence: 'no longer accepting applications' }) })).blockedReason).toBe('closed')
    })
  })

  it('no_validation_error: hands back an answer flagged invalid right before the press', () => {
    const decision = decideSubmitGates(input({ prePress: form({ state: 'validation_error', evidence: 'invalid: email' }) }))
    expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'validation' })
  })

  describe('required_planned', () => {
    it('hands back a value that reads differently from what was planned', () => {
      const changed = field('email', { observed: 'other@example.com', planned: 'ada@example.com' })
      const decision = decideSubmitGates(input({}, [field('name'), changed, RESUME]))
      expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'readback' })
      expect(decision.gates.required_planned.items).toEqual([expect.objectContaining({ key: 'email', why: 'reads back differently from the plan' })])
    })

    it('hands back a required field left empty', () => {
      const run = pageRun([field('name'), RESUME], { readBack: [{ key: 'phone', label: 'Phone', kind: 'text', required: true, observed: '' }] })
      expect(decideSubmitGates(input({ run })).gates.required_planned).toMatchObject({ ok: false })
    })
  })

  describe('no_trap', () => {
    it('puts a posting with trap wording off-limits even when the box was left alone', () => {
      const fields = [
        ...pageRun([field('name'), RESUME]).fields,
        {
          selector: '#trap',
          key: 'trap',
          kind: 'checkboxes' as const,
          inputType: 'checkbox',
          label: 'I confirm that I have reviewed the Job Description',
          description: 'Warning for Humans: Do NOT check this box. It is a bot-trap. Checking this box will result in automatic rejection.',
          section: '',
          required: false,
          options: ['Yes', 'No'],
          maxLength: null,
          accept: '',
        },
      ]
      const run = pageRun([field('name'), RESUME], { fields, readBack: [{ key: 'trap', label: fields[2].label, kind: 'checkboxes', required: false, observed: '' }] })
      const decision = decideSubmitGates(input({ run }))
      expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'trap' })
      expect(decision.gates.no_trap.items).toEqual([expect.objectContaining({ key: 'trap', why: 'trap wording' })])
    })

    it('fails when an optional box is ticked that nothing planned', () => {
      const run = pageRun([field('name'), RESUME], { readBack: [{ key: 'marketing', label: 'Send me job alerts', kind: 'checkbox', required: false, observed: 'checked' }] })
      const decision = decideSubmitGates(input({ run }))
      expect(decision.blockedReason).toBe('trap')
      expect(decision.gates.no_trap.items).toEqual([expect.objectContaining({ key: 'marketing', why: 'ticked but never planned' })])
    })

    it('recognises the wordings a trap uses', () => {
      for (const text of ['This is a honeypot', 'Leave this field blank', "Don't tick this", 'Ticking it will automatically reject you']) {
        expect(TRAP_WORDING.test(text), text).toBe(true)
      }
      expect(TRAP_WORDING.test('Do you require sponsorship?')).toBe(false)
    })
  })

  describe('answer_sources', () => {
    const essay = field('why', { kind: 'textarea', label: 'Why us?', source: 'answer', questionId: 'q-why', observed: 'Because.', planned: 'Because.', layer: undefined })

    it('holds an unreviewed draft for approval under review first', () => {
      const decision = decideSubmitGates(input({ agentQuestionIds: ['q-why'] }, [field('name'), essay, RESUME]))
      expect(decision.outcome).toBe('review')
      expect(decision.gates.answer_sources.items).toEqual([expect.objectContaining({ key: 'why', why: 'unreviewed draft' })])
    })

    it('sends it once the applicant has reviewed enough drafts, or approved this one, or allows drafts', () => {
      const filled = [field('name'), essay, RESUME]
      expect(decideSubmitGates(input({ agentQuestionIds: ['q-why'], drafts: { policy: 'review_first', reviewedCount: 5, reviewFirst: 5 } }, filled)).outcome).toBe('passed')
      expect(decideSubmitGates(input({ agentQuestionIds: ['q-why'], approved: true }, filled)).outcome).toBe('passed')
      expect(decideSubmitGates(input({ agentQuestionIds: ['q-why'], drafts: { policy: 'allow', reviewedCount: 0, reviewFirst: 5 } }, filled)).outcome).toBe('passed')
      expect(decideSubmitGates(input({ agentQuestionIds: ['q-why'], reviewedQuestionIds: ['q-why'] }, filled)).outcome).toBe('passed')
    })

    it("hands it back under 'never' unless approved", () => {
      const filled = [field('name'), essay, RESUME]
      const never = { policy: 'never' as const, reviewedCount: 50, reviewFirst: 5 }
      expect(decideSubmitGates(input({ agentQuestionIds: ['q-why'], drafts: never }, filled))).toMatchObject({ outcome: 'hand_back', blockedReason: 'source' })
      expect(decideSubmitGates(input({ agentQuestionIds: ['q-why'], drafts: never, approved: true }, filled)).outcome).toBe('passed')
    })

    it('never lets a factual or legal field come from the agent, approved or not', () => {
      const sponsorship = field('sponsor', { label: 'Do you need sponsorship?', source: 'answer', questionId: 'q-s', fieldKey: 'requires_sponsorship', observed: 'No', planned: 'No', layer: undefined })
      for (const approved of [false, true]) {
        const decision = decideSubmitGates(input({ agentQuestionIds: ['q-s'], approved, drafts: { policy: 'allow', reviewedCount: 9, reviewFirst: 5 } }, [field('name'), sponsorship, RESUME]))
        expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'source' })
      }
    })

    it('treats a value the resolver took from an agent bank answer as a draft', () => {
      const banked = field('why', { kind: 'textarea', source: 'profile', layer: 'agent' })
      expect(decideSubmitGates(input({}, [field('name'), banked, RESUME])).outcome).toBe('review')
    })

    it("passes the applicant's own answers and stored data", () => {
      const own = field('years', { source: 'answer', questionId: 'q-years', layer: undefined })
      const stored = field('linkedin', { source: 'profile', layer: 'answer_bank' })
      expect(decideSubmitGates(input({ agentQuestionIds: ['other'] }, [own, stored, RESUME])).outcome).toBe('passed')
    })
  })

  describe('documents_attached', () => {
    it('hands back when the tailored CV is not the file on the form', () => {
      const wrong = { ...RESUME, observed: 'old-cv.pdf', planned: 'old-cv.pdf' }
      expect(decideSubmitGates(input({}, [field('name'), wrong]))).toMatchObject({ outcome: 'hand_back', blockedReason: 'documents' })
    })
    it('needs a tailored CV on the attempt', () => {
      const documents = { tailoredDocumentId: null, resumeFileName: 'ada.pdf', coverLetterFileName: null, coverLetterText: '' }
      expect(decideSubmitGates(input({ documents })).gates.documents_attached.ok).toBe(false)
    })
    it('needs the letter attached where the form takes one as a file', () => {
      const letter = field('cover_letter', { kind: 'file', label: 'Cover Letter', source: 'document', observed: '', planned: '', layer: undefined, required: false })
      const documents = { tailoredDocumentId: 'doc-1', resumeFileName: 'ada.pdf', coverLetterFileName: 'ada-letter.pdf', coverLetterText: 'Dear team' }
      const decision = decideSubmitGates(input({ documents }, [field('name'), RESUME, letter]))
      expect(decision.gates.documents_attached.items).toEqual([expect.objectContaining({ key: 'cover_letter', why: 'letter not attached' })])
    })
  })

  describe('submit_control', () => {
    it.each([
      [null, 'no submit button found'],
      [{ selector: 's', text: 'Submit', disabled: true, count: 1 }, 'disabled'],
      [{ selector: 's', text: 'Submit', disabled: false, count: 2 }, '2 submit buttons'],
    ])('hands back %j', (submitTarget, detail) => {
      const decision = decideSubmitGates(input({ submitTarget }))
      expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'no_submit' })
      expect(decision.gates.submit_control.detail).toContain(detail)
    })
  })

  describe('caps and budget', () => {
    it('holds the application, not hands it back, when the day is full', () => {
      const decision = decideSubmitGates(input({ caps: { appliedToday: 5, dailyLimit: 5, companyApplied: 0, companyCap: 1, companyWindowDays: 30 } }))
      expect(decision).toMatchObject({ outcome: 'hold', blockedReason: '' })
    })
    it('hands back a second application to the same company in the window', () => {
      const decision = decideSubmitGates(input({ caps: { appliedToday: 0, dailyLimit: 5, companyApplied: 1, companyCap: 1, companyWindowDays: 30 } }))
      expect(decision).toMatchObject({ outcome: 'hand_back', blockedReason: 'company_cap' })
    })
    it('hands back when this run would pass the monthly compute budget', () => {
      expect(decideSubmitGates(input({ budget: { spentUsd: 3.999, budgetUsd: 4, thisRunUsd: 0.002 } }))).toMatchObject({ outcome: 'hand_back', blockedReason: 'budget' })
      expect(decideSubmitGates(input({ budget: { spentUsd: 0, budgetUsd: 0, thisRunUsd: 0 } })).blockedReason).toBe('budget')
    })
  })

  describe('eligibility (from selection, when the attempt has it)', () => {
    it('passes when selection wrote nothing', () => {
      expect(decideSubmitGates(input()).gates.eligibility).toMatchObject({ ok: true, detail: expect.stringContaining('no selection data') })
    })
    it("waits for approval when selection couldn't tell (unknown is never hands-free)", () => {
      const unknown = { matchScore: 0.8, minMatch: 0.6, verdict: { eligible: 'unknown' as const } }
      expect(decideSubmitGates(input({ eligibility: unknown }))).toMatchObject({ outcome: 'review', blockedReason: '' })
      expect(decideSubmitGates(input({ eligibility: unknown, approved: true })).outcome).toBe('passed')
    })

    it('hands back a job selection called ineligible, or under the minimum match', () => {
      expect(decideSubmitGates(input({ eligibility: { matchScore: 0.9, minMatch: 0.6, verdict: { eligible: false, reasons: ['needs US work authorisation'] } } })).blockedReason).toBe('not_eligible')
      expect(decideSubmitGates(input({ eligibility: { matchScore: 0.4, minMatch: 0.6, verdict: null } })).blockedReason).toBe('not_eligible')
      expect(decideSubmitGates(input({ eligibility: { matchScore: 0.7, minMatch: 0.6, verdict: { eligible: true } } })).outcome).toBe('passed')
    })
  })
})

describe('readsAsPlanned', () => {
  it('follows the fill engine’s reading of each control', () => {
    expect(readsAsPlanned({ kind: 'checkbox', planned: 'checked' }, 'checked')).toBe(true)
    expect(readsAsPlanned({ kind: 'checkbox', planned: 'checked' }, '')).toBe(false)
    expect(readsAsPlanned({ kind: 'file', planned: 'ada.pdf' }, 'ada.pdf')).toBe(true)
    expect(readsAsPlanned({ kind: 'combobox', planned: 'Berlin', pick: 'first' }, 'Berlin, Germany')).toBe(true)
    expect(readsAsPlanned({ kind: 'combobox', planned: 'Berlin', pick: 'exact' }, 'Berlin, Germany')).toBe(false)
    expect(readsAsPlanned({ kind: 'checkboxes', planned: 'A | B' }, 'B | A')).toBe(true)
    expect(readsAsPlanned({ kind: 'text', planned: '+1 202 555 0143' }, '+1 202-555-0143')).toBe(true)
    expect(readsAsPlanned({ kind: 'text', planned: 'Ada' }, ' ada ')).toBe(true)
  })
})

describe('statedCompanyCap', () => {
  it('reads the caps employers state', () => {
    expect(statedCompanyCap('Candidates may not apply more than 3 times in any 60 days for any job')).toEqual({ cap: 3, days: 60 })
    expect(statedCompanyCap('You may submit five applications per candidate per 180 days.')).toEqual({ cap: 5, days: 180 })
    expect(statedCompanyCap('Candidates may not re-apply to the same role within 180 days')).toBeNull()
    expect(statedCompanyCap('We review every application within 5 days.')).toBeNull()
  })
})

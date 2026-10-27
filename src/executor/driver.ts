import type { Page } from 'playwright-core'
import { fillField, readField, type FillOptions, type FillResult, type FillValue } from 'ats-form-fill'
import { classifyPage, detectChallenges } from 'ats-form-fill'
import { extractFormFields } from 'ats-form-fill'
import type { ChallengeSignal, FormAts, FormField, PageClassification } from 'ats-form-fill'
import { finderArgs, findSubmitControl, SUBMIT_FINDER_JS, type SubmitTarget } from './submitControl.js'

/**
 * The fill engine's calls, made against one open form.
 *
 * In a run the form is a page in a real browser and each call crosses into it
 * by name (`__arkooFill`, the ats-form-fill bundle, browser/fillBundle.ts).
 * In tests it is a happy-dom document and the same engine runs in-process.
 * Everything above this interface — what to fill, the gates — is identical
 * either way, which is what lets the gate decisions be tested against the 25
 * captured forms without a browser.
 */
export interface FormDriver {
  classifyPage(): Promise<PageClassification>
  detectChallenges(): Promise<ChallengeSignal[]>
  extractFormFields(): Promise<FormField[]>
  fillField(field: Target, value: FillValue, options?: FillOptions): Promise<FillResult>
  readField(field: Target): Promise<string>
  /** The page's address now, for the host guard. */
  url(): string
  /** Give the page's framework time to commit what was typed. */
  settle(ms: number): Promise<void>
  /** The form's submit control, found and marked but not touched (submitControl.ts). */
  findSubmit(ats: FormAts): Promise<SubmitTarget | null>
  /**
   * Press it. Called from one place only, executor/submit.ts, once per
   * attempt and only after submit_clicked_at was written.
   */
  pressSubmit(target: SubmitTarget): Promise<void>
  /** One PNG of the page as it is, for the receipt. Null where there is no screen. */
  screenshot(): Promise<Buffer | null>
  /** The page's visible text, clipped: where employers state their own caps. */
  pageText(): Promise<string>
}

type Target = Pick<FormField, 'selector' | 'key' | 'kind'>

const PAGE_TEXT_CHARS = 20_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The engine run directly on a document: tests, and anything already in-page. */
export function domDriver(doc: Document, address = ''): FormDriver {
  return {
    classifyPage: async () => classifyPage(doc),
    detectChallenges: async () => detectChallenges(doc),
    extractFormFields: async () => extractFormFields(doc),
    fillField: (field, value, options) => fillField(doc, field, value, options),
    readField: async (field) => readField(doc, field),
    url: () => address || doc.location?.href || '',
    settle: sleep,
    findSubmit: async (ats) => findSubmitControl(doc, ats),
    pressSubmit: async (target) => {
      const button = doc.querySelector<HTMLElement>(target.selector)
      if (!button) throw new Error('submit control is gone')
      button.click()
    },
    screenshot: async () => null,
    pageText: async () => (doc.body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, PAGE_TEXT_CHARS),
  }
}

/**
 * The engine in a Playwright page, after the bundle has been evaluated there.
 * Arguments cross as JSON, so only plain values (and base64 files) go in.
 */
export function playwrightDriver(page: Page, bundle = ''): FormDriver {
  const expression = (method: string, args: unknown[]) => `__arkooFill.${method}(${args.map((arg) => JSON.stringify(arg ?? {})).join(', ')})`
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    try {
      return (await page.evaluate(expression(method, args))) as T
    } catch (error) {
      // Pressing submit can load a new page (Lever's thank-you page), which
      // has no engine in it. Load it again once and ask again.
      if (!bundle || !/__arkooFill is not defined/.test((error as Error).message)) throw error
      await page.evaluate(bundle)
      return (await page.evaluate(expression(method, args))) as T
    }
  }
  const target = (field: Target): Target => ({ selector: field.selector, key: field.key, kind: field.kind })
  return {
    classifyPage: () => call<PageClassification>('classifyPage'),
    detectChallenges: () => call<ChallengeSignal[]>('detectChallenges'),
    extractFormFields: () => call<FormField[]>('extractFormFields'),
    fillField: (field, value, options) => call<FillResult>('fillField', target(field), value, options ?? {}),
    readField: (field) => call<string>('readField', target(field)),
    url: () => page.url(),
    settle: (ms) => page.waitForTimeout(ms),
    findSubmit: (ats) =>
      page.evaluate(`${SUBMIT_FINDER_JS}(document, ${finderArgs(ats).map((arg) => JSON.stringify(arg)).join(', ')})`) as Promise<SubmitTarget | null>,
    // A real, trusted click through the browser's input pipeline, on the one
    // element the finder marked.
    pressSubmit: (target) => page.locator(target.selector).first().click({ timeout: 10_000 }),
    screenshot: () => page.screenshot({ fullPage: true, type: 'png', timeout: 15_000 }),
    pageText: () => page.evaluate(`(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, ${PAGE_TEXT_CHARS})`) as Promise<string>,
  }
}

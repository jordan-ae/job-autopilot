import type { Page } from 'playwright-core'
import type { BrowserSession } from '../browser/provider.js'
import type { PostingRef } from 'ats-form-fill'
import { playwrightDriver, type FormDriver } from '../executor/driver.js'
import { classifyApplyTarget, refFromUrl } from './target.js'
import { detectWall, PAGE_SNAPSHOT_JS, type PageSnapshot, type SnapshotControl, type Wall } from './walls.js'

/**
 * The agent runner's way from a posting's page to its application form, for
 * postings with no fill-engine form (the agent route). Deterministic: it reads each page (PAGE_SNAPSHOT_JS), and either
 * stops — a fill-engine form, an application form, an account wall — or
 * follows the one control that most plainly means "apply". It never types,
 * never presses anything inside a form or marked submit, and never signs in.
 * Filling stays with the fill engine (pageRun.ts) and every gate after it,
 * exactly as for a Greenhouse form.
 *
 * Why not an LLM agent driving the page: the dry run of 2026-10-21 showed the
 * hops are few and plainly labelled ("Apply Now", "Apply", "Apply Manually"),
 * and that what stops these postings is an account wall, which no agent
 * should get past. The agent's money buys nothing there. A model-picked hop
 * (Jev over the snapshot's controls) is the place to add one if a page's
 * Apply control turns out to be unlabelled; it is not built.
 */

export type NavOutcome =
  /** The trail reached a form the fill engine knows: run it as one. */
  | { kind: 'ref'; ref: PostingRef; hops: NavHop[] }
  /** An application form on a host the fill engine has no driver for.
   * `multiStep`: it shows Next/Continue and no submit, so this page is one of several. */
  | { kind: 'form'; driver: FormDriver; url: string; host: string; multiStep: boolean; hops: NavHop[] }
  | { kind: 'wall'; wall: Wall; url: string; hops: NavHop[] }
  /** No form, no wall, nothing that reads as Apply. */
  | { kind: 'lost'; detail: string; url: string; hops: NavHop[] }

export interface NavHop {
  url: string
  /** What was done from here: 'goto <url>', 'press "<text>"', or the stop. */
  action: string
  inputs: number
  passwords: number
}

/** The page as the navigator needs it. Playwright in production; a fake in tests. */
export interface NavPage {
  goto(url: string): Promise<void>
  snapshot(): Promise<PageSnapshot>
  /** Press the control marked data-arkoo-nav=<index> by the last snapshot. */
  press(index: number): Promise<void>
  /** The fill engine on this page, once it is the form. */
  driver(): Promise<FormDriver>
}

export const MAX_HOPS = 5

/** Fields that make a page an application rather than a search box or a newsletter sign-up. */
const APPLICATION_FIELD = /\b(first|last|full|given|family)[ _-]?name|\bname\b|e-?mail|phone|resume|résumé|\bcv\b|linkedin|cover letter/i

const NEXT = /^(next|next step|continue|save (and|&) continue|continue to next step)$/i
const SUBMIT = /\b(submit|send)\b|^apply( now)?$/i

/** A form page that leads to another (Next) rather than ending in a submit. */
export function looksMultiStep(page: PageSnapshot): boolean {
  const submits = page.controls.some((control) => control.submits && SUBMIT.test(control.text))
  return !submits && page.controls.some((control) => NEXT.test(control.text.trim()))
}

/** An application form: enough fields, and some of them about the applicant. */
export function looksLikeApplication(page: PageSnapshot): boolean {
  if (page.passwords > 0) return false
  const about = page.inputs.filter((input) => input.type === 'file' || APPLICATION_FIELD.test(input.label))
  return page.inputs.length >= 3 && about.length >= 2
}

const NEVER = /\b(save|saved|share|alert|similar|later|refer|subscribe|newsletter|sign ?in|log ?in|sign ?up|register|create account|with linkedin|with indeed|with google|autofill|upload resume|use my last|cookie|privacy|filter|search|apply to (yc|y combinator))\b/i
/** Links that are never a job's application: YC's own accelerator application, HN's footer. */
const NEVER_HOSTS = /(^|\.)ycombinator\.com$/
const APPLY_EXACT = /^(apply|apply now|apply here|apply for (this )?(job|role|position)|apply on (the )?(company|employer)('s)? (site|website)|apply manually|start (your )?application|continue to application|i'?m interested)$/i

/**
 * How strongly a control means "take me to the application", or 0 for one to
 * leave alone. Links to a fill-engine form win; then the plain Apply words.
 */
export function controlScore(control: SnapshotControl, here: string): number {
  if (control.submits) return 0
  const text = control.text.trim()
  if (NEVER.test(text) && !/apply manually/i.test(text)) return 0
  if (control.href) {
    if (control.href.split('#')[0] === here.split('#')[0]) return 0
    if (/^(mailto|tel|javascript):/i.test(control.href)) return 0
    if (refFromUrl(control.href)) return 100
    const target = classifyApplyTarget(control.href)
    if (target.kind === 'login' || NEVER_HOSTS.test(target.host)) return 0
  }
  if (/applyManually/i.test(control.automationId) || /^apply manually$/i.test(text)) return 70
  if (/adventureButton/i.test(control.automationId)) return 60
  if (APPLY_EXACT.test(text)) return control.href ? 55 : 50
  if (/\bapply\b/i.test(text) && text.length <= 40) return 30
  return 0
}

export function pickControl(page: PageSnapshot): SnapshotControl | null {
  let best: SnapshotControl | null = null
  let bestScore = 0
  for (const control of page.controls) {
    const score = controlScore(control, page.url)
    if (score > bestScore) {
      best = control
      bestScore = score
    }
  }
  return best
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export async function navigateToForm(page: NavPage, startUrl: string, maxHops = MAX_HOPS): Promise<NavOutcome> {
  const hops: NavHop[] = []
  const pressed = new Set<string>()
  const start = refFromUrl(startUrl)
  if (start) return { kind: 'ref', ref: start, hops }

  await page.goto(startUrl)
  for (let hop = 0; hop < maxHops; hop++) {
    const snap = await page.snapshot()
    const note = (action: string) => hops.push({ url: snap.url, action, inputs: snap.inputs.length, passwords: snap.passwords })

    const ref = refFromUrl(snap.url)
    if (ref) {
      note('stop: fill-engine form')
      return { kind: 'ref', ref, hops }
    }
    const wall = detectWall(snap)
    if (wall) {
      note(`stop: ${wall.code} (${wall.by}: ${wall.evidence})`)
      return { kind: 'wall', wall, url: snap.url, hops }
    }
    if (looksLikeApplication(snap)) {
      const multiStep = looksMultiStep(snap)
      note(multiStep ? 'stop: application form, first of several pages' : 'stop: application form')
      return { kind: 'form', driver: await page.driver(), url: snap.url, host: hostOf(snap.url), multiStep, hops }
    }
    const control = pickControl(snap)
    // A control pressed before on this same address did nothing useful.
    const key = control ? `${snap.url}#${control.href || control.text}` : ''
    if (!control || pressed.has(key)) {
      note('stop: nothing reads as Apply')
      return { kind: 'lost', detail: `no apply control on ${hostOf(snap.url) || 'the page'}`, url: snap.url, hops }
    }
    pressed.add(key)
    if (control.href) {
      note(`goto ${control.href.slice(0, 160)}`)
      // Followed as a navigation, not a click: target=_blank links open no popup.
      await page.goto(control.href)
    } else {
      note(`press "${control.text.slice(0, 40)}"`)
      await page.press(control.index)
    }
  }
  const last = await page.snapshot()
  hops.push({ url: last.url, action: 'stop: too many hops', inputs: last.inputs.length, passwords: last.passwords })
  return { kind: 'lost', detail: `no form after ${maxHops} steps`, url: last.url, hops }
}

/** How long a hop's page gets to render before it is read. */
const RENDER_MS = 2_500

/** A NavPage over a fresh page of `session`, with the fill engine loaded on demand. */
export async function playwrightNavPage(session: BrowserSession, bundle: string): Promise<NavPage> {
  let page: Page = await session.context.newPage()
  const settle = async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(RENDER_MS)
  }
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await settle()
    },
    snapshot: async () => {
      try {
        return (await page.evaluate(PAGE_SNAPSHOT_JS)) as PageSnapshot
      } catch (error) {
        // The page navigated while it was being read (a client-side redirect): read the new one.
        if (!/Execution context was destroyed|navigation/i.test((error as Error).message)) throw error
        await settle()
        return (await page.evaluate(PAGE_SNAPSHOT_JS)) as PageSnapshot
      }
    },
    press: async (index) => {
      const popup = session.context.waitForEvent('page', { timeout: 5_000 }).catch(() => null)
      await page.locator(`[data-arkoo-nav="${index}"]`).first().click({ timeout: 10_000 })
      // A button that opens the form in a new tab: follow it there.
      const opened = await popup
      if (opened) page = opened
      await settle()
    },
    driver: async () => {
      await page.evaluate(bundle)
      return playwrightDriver(page, bundle)
    },
  }
}

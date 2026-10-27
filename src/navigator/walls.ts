import { classifyApplyTarget, type AccountSystem } from './target.js'

/**
 * What a page in the browser shows, cut down to what the agent runner decides
 * on: where it is, whether it asks for an account, and which controls lead
 * on towards the application. Taken in the page in one evaluate
 * (PAGE_SNAPSHOT_JS) so the decisions below stay pure and testable.
 */
export interface PageSnapshot {
  url: string
  title: string
  /** Visible text, squashed and clipped. */
  text: string
  /** Visible password inputs. */
  passwords: number
  /** Visible text-like inputs, selects and textareas outside cookie banners. */
  inputs: Array<{ type: string; label: string; required: boolean }>
  /** Visible links and buttons whose words or automation ids are about applying or accounts. */
  controls: SnapshotControl[]
}

export interface SnapshotControl {
  /** Its position among the snapshot's controls; marked in the page as data-arkoo-nav. */
  index: number
  tag: string
  text: string
  /** Absolute href for a link; '' for a button. */
  href: string
  /** Workday's data-automation-id, when there is one. */
  automationId: string
  /** Inside a <form>, or a submit button: never pressed by the navigator. */
  submits: boolean
}

export type WallCode = 'account_required' | 'login_required'

export interface Wall {
  code: WallCode
  /** Who put it up: an ATS, or the site's own name. */
  by: AccountSystem | string
  evidence: string
}

const ACCOUNT_WORDS = /\b(create (an |your )?account|sign up|register|create password|verify (your )?password|already have an account)\b/i
const LOGIN_WORDS = /\b(sign (in|up) (or log in |or sign in )?(to|and then) apply|log ?in to apply|sign in to continue|you must (create|log in|sign in))\b/i

/**
 * Does the page want an account or a login before the application form?
 * Account creation is not something Autopilot does — it would mean holding a
 * password per employer, reading verification mail and accepting each
 * employer's terms in the applicant's name — so any of these ends the run and
 * hands the application back.
 */
export function detectWall(page: PageSnapshot): Wall | null {
  const target = classifyApplyTarget(page.url)
  const words = `${page.title} ${page.text.slice(0, 4000)}`
  const controlWords = page.controls.map((control) => `${control.text} ${control.automationId}`).join(' | ')

  // Workday: "Create Account" / "Sign In" with password boxes, before any form.
  if (target.kind === 'account' && target.system === 'workday') {
    if (page.passwords > 0 || /createAccount|signInSubmit|Create Account/i.test(controlWords)) {
      return { code: 'account_required', by: 'workday', evidence: page.passwords ? `${page.passwords} password field(s)` : 'Create Account' }
    }
  }
  // Oracle Recruiting Cloud: the apply flow opens on an email step that makes
  // a candidate profile and may mail a one-time code.
  if (target.kind === 'account' && target.system === 'oracle' && /\/CandidateExperience\/.*\/apply\/email/i.test(page.url)) {
    return { code: 'account_required', by: 'oracle', evidence: 'email + candidate profile step' }
  }
  if (target.kind === 'account' && page.passwords > 0) {
    return { code: 'account_required', by: target.system, evidence: `${page.passwords} password field(s)` }
  }
  if (target.kind === 'login' && (page.passwords > 0 || LOGIN_WORDS.test(words) || ACCOUNT_WORDS.test(words))) {
    return { code: 'login_required', by: target.site, evidence: clip(words.match(LOGIN_WORDS)?.[0] ?? words.match(ACCOUNT_WORDS)?.[0] ?? 'password field') }
  }
  // Anywhere else: a password box, or "sign in to apply", in front of the form.
  if (page.passwords > 0) {
    return { code: ACCOUNT_WORDS.test(words) ? 'account_required' : 'login_required', by: target.host, evidence: `${page.passwords} password field(s)` }
  }
  if (LOGIN_WORDS.test(words) && page.inputs.length <= 2) {
    return { code: 'login_required', by: target.host, evidence: clip(words.match(LOGIN_WORDS)?.[0] ?? '') }
  }
  return null
}

function clip(text: string, max = 80): string {
  const squashed = text.replace(/\s+/g, ' ').trim()
  return squashed.length > max ? `${squashed.slice(0, max - 1)}…` : squashed
}

/**
 * Evaluated in the page: returns a PageSnapshot and marks each reported
 * control with data-arkoo-nav="<index>" so the navigator can press the one
 * it chose by that mark and nothing else. Plain ES2017, no imports.
 */
export const PAGE_SNAPSHOT_JS = `(() => {
  const visible = (el) => {
    const style = window.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 2 && rect.height > 2
  }
  const squash = (text) => String(text || '').replace(/\\s+/g, ' ').trim()
  const inBanner = (el) => Boolean(el.closest('#onetrust-consent-sdk, #onetrust-banner-sdk, [id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i]'))
  const labelOf = (el) => {
    const id = el.getAttribute('id')
    const byFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null
    return squash((byFor && byFor.textContent) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 80)
  }
  const inputs = Array.from(document.querySelectorAll('input, select, textarea'))
    .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()))
    .filter((el) => visible(el) && !inBanner(el))
    .slice(0, 60)
    .map((el) => ({ type: (el.getAttribute('type') || el.tagName).toLowerCase(), label: labelOf(el), required: el.required || el.getAttribute('aria-required') === 'true' }))
  const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible).length
  const WORDS = /apply|submit|send|sign ?in|log ?in|sign ?up|create account|register|continue|next|manually|autofill|start/i
  document.querySelectorAll('[data-arkoo-nav]').forEach((el) => el.removeAttribute('data-arkoo-nav'))
  const controls = []
  // RemoteOK-style boards draw their Apply as a styled div.
  for (const el of Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"], [class*="apply" i]'))) {
    if (controls.length >= 30) break
    if (!visible(el) || inBanner(el)) continue
    const text = squash(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 60)
    const automationId = el.getAttribute('data-automation-id') || ''
    if (!WORDS.test(text + ' ' + automationId)) continue
    const href = el.tagName === 'A' ? el.href : ''
    const type = (el.getAttribute('type') || '').toLowerCase()
    const submits = type === 'submit' || (el.tagName === 'BUTTON' && !type && Boolean(el.closest('form'))) || (el.tagName === 'INPUT' && type === 'submit')
    el.setAttribute('data-arkoo-nav', String(controls.length))
    controls.push({ index: controls.length, tag: el.tagName.toLowerCase(), text, href, automationId, submits })
  }
  return {
    url: location.href,
    title: document.title,
    text: squash(document.body ? document.body.innerText : '').slice(0, 6000),
    passwords,
    inputs,
    controls,
  }
})()`

import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { env, type BrowserProviderName } from '../config.js'

export type { BrowserProviderName }

/**
 * One browser per application: the Chrome on this machine (`local`), or a
 * cloud browser rented for the run from Browser Use or Browserbase and driven
 * over CDP. Every exit path closes it, and for the cloud ones stops the
 * billing.
 */

/** What closing a session learned about it. */
export interface SessionClosed {
  /** USD the provider says the session cost (browser time plus proxy), when it
   * reports it; null otherwise, and the caller estimates from the clock. */
  costUsd: number | null
}

/** One browser, opened for one piece of work and closed after it. */
export interface BrowserSession {
  provider: BrowserProviderName
  /** The provider's id for this run; '' for a local browser. */
  sessionId: string
  /** Where a person can watch the run live; '' locally. */
  inspectUrl: string
  /** True when the provider clears CAPTCHAs in the page by itself, so a
   * challenge is worth waiting on (executor/pageRun.ts). */
  solvesCaptchas: boolean
  context: BrowserContext
  /** Ends the session and stops its billing. Safe to call more than once. */
  close(): Promise<SessionClosed>
}

export interface OpenBrowserOptions {
  provider?: BrowserProviderName
  /** Local only: show the window. */
  headed?: boolean
  /** Hard stop, so a crashed run cannot leave a rented browser billing. */
  timeoutSeconds?: number
  /**
   * Cloud only: let the provider keep a replay of the run. Off unless asked
   * for. A real application carries someone's CV, phone number and answers,
   * and those should not sit in a third party's dashboard; a placeholder dry
   * run can turn it on to be watched.
   */
  record?: boolean
}

const VIEWPORT = { width: 1280, height: 900 }
const BROWSERBASE_API = 'https://api.browserbase.com/v1'
const BROWSER_USE_API = 'https://api.browser-use.com/api/v4'

export async function openBrowserSession(options: OpenBrowserOptions = {}): Promise<BrowserSession> {
  const provider = options.provider ?? env.browserProvider
  if (provider === 'browseruse') return openBrowserUse(options)
  if (provider === 'browserbase') return openBrowserbase(options)
  return openLocal(options)
}

async function openLocal(options: OpenBrowserOptions): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(env.localChromiumPath ? { executablePath: env.localChromiumPath } : { channel: 'chrome' }),
  })
  const context = await browser.newContext({ viewport: VIEWPORT })
  return {
    provider: 'local',
    sessionId: '',
    inspectUrl: '',
    solvesCaptchas: false,
    context,
    close: once(async () => {
      await browser.close().catch(() => {})
      return { costUsd: null }
    }),
  }
}

/** Run `fn` once; later calls get the first call's result. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | null = null
  return () => (result ??= fn())
}

/**
 * Connect Playwright over CDP. The connect URL can carry a credential, and
 * Playwright quotes the URL in its connection errors; those are replaced with
 * a message naming only the session, so a failed run cannot log the credential.
 */
async function connect(cdpUrl: string, label: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 45_000 }).catch(() => {
    throw new Error(`${label}: could not connect over CDP`)
  })
  // The provider's own default context is the one it tracks; a second would work but sit outside it.
  const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: VIEWPORT }))
  return { browser, context }
}

/** A decimal string or number from a provider's API, as a number; null when absent or unreadable. */
function usd(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * A cloud browser from Browser Use Cloud (API v4), driven over CDP.
 *
 * The provider's own options come from the environment (config.ts). The
 * residential proxy is off unless BROWSER_USE_PROXY_COUNTRY names a country,
 * and has to be switched off explicitly: the API defaults to a US proxy,
 * billed per GB. Recording is off unless a caller asks.
 *
 * Closing the CDP connection does not end the session or its billing; only
 * `PATCH /browsers/{id} {"action":"stop"}` does, and refunds the unused part of
 * the reserved time. So every exit path stops it, and the stop's answer is
 * where the session's cost comes from.
 */
async function openBrowserUse(options: OpenBrowserOptions): Promise<BrowserSession> {
  if (!env.browserUseApiKey) throw new Error('browseruse: BROWSER_USE_API_KEY is not configured')
  const headers = { 'X-Browser-Use-API-Key': env.browserUseApiKey, 'Content-Type': 'application/json' }
  const minutes = Math.min(240, Math.max(1, Math.ceil((options.timeoutSeconds ?? 600) / 60)))

  const created = await fetch(`${BROWSER_USE_API}/browsers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      solveCaptchas: env.browserUseSolveCaptchas,
      proxyCountryCode: env.browserUseProxyCountry || null,
      enableRecording: options.record === true,
      timeout: minutes,
      browserScreenWidth: VIEWPORT.width,
      browserScreenHeight: VIEWPORT.height,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!created.ok) throw new Error(`browseruse create browser -> ${created.status}: ${(await created.text()).slice(0, 300)}`)
  const session = (await created.json()) as { id: string; cdpUrl?: string | null; liveUrl?: string | null }

  const stop = once(async (): Promise<SessionClosed> => {
    try {
      const stopped = await fetch(`${BROWSER_USE_API}/browsers/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ action: 'stop' }),
        signal: AbortSignal.timeout(15_000),
      })
      if (stopped.ok) return { costUsd: sessionCost(await stopped.json()) }
      // Already stopped (its own timeout) or a hiccup: the session's record still has the cost.
      const read = await fetch(`${BROWSER_USE_API}/browsers/${encodeURIComponent(session.id)}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
      return { costUsd: read.ok ? sessionCost(await read.json()) : null }
    } catch {
      return { costUsd: null }
    }
  })

  try {
    if (!session.cdpUrl) throw new Error(`browseruse: session ${session.id} came back without a CDP address`)
    const { browser, context } = await connect(session.cdpUrl, `browseruse session ${session.id}`)
    return {
      provider: 'browseruse',
      sessionId: session.id,
      inspectUrl: session.liveUrl ?? '',
      solvesCaptchas: env.browserUseSolveCaptchas,
      context,
      close: once(async () => {
        await browser.close().catch(() => {})
        return stop()
      }),
    }
  } catch (error) {
    await stop()
    throw error
  }
}

function sessionCost(view: { browserCost?: unknown; proxyCost?: unknown }): number | null {
  const browser = usd(view.browserCost)
  if (browser === null) return null
  // To the millionth of a dollar: the figures are decimal strings and their float sum drifts.
  return Math.round((browser + (usd(view.proxyCost) ?? 0)) * 1_000_000) / 1_000_000
}

/**
 * A cloud browser from Browserbase, driven over CDP, as an alternative to
 * Browser Use. Created as a plain browser, with every optional extra switched
 * off in the request, at a higher per-minute price.
 */
async function openBrowserbase(options: OpenBrowserOptions): Promise<BrowserSession> {
  if (!env.browserbaseApiKey) throw new Error('browserbase: BROWSERBASE_API_KEY is not configured')
  const headers = { 'X-BB-API-Key': env.browserbaseApiKey, 'Content-Type': 'application/json' }

  const created = await fetch(`${BROWSERBASE_API}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      browserSettings: {
        solveCaptchas: false,
        advancedStealth: false,
        verified: false,
        recordSession: options.record === true,
        logSession: options.record === true,
        viewport: VIEWPORT,
      },
      proxies: false,
      timeout: options.timeoutSeconds ?? 300,
      ...(env.browserbaseRegion ? { region: env.browserbaseRegion } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!created.ok) throw new Error(`browserbase create session -> ${created.status}: ${(await created.text()).slice(0, 300)}`)
  const session = (await created.json()) as { id: string; connectUrl: string }

  // Billing runs until the session is released, so every exit path releases it.
  const release = once(async (): Promise<SessionClosed> => {
    await fetch(`${BROWSERBASE_API}/sessions/${session.id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {})
    return { costUsd: null }
  })

  try {
    const { browser, context } = await connect(session.connectUrl, `browserbase session ${session.id}`)
    return {
      provider: 'browserbase',
      sessionId: session.id,
      inspectUrl: `https://www.browserbase.com/sessions/${session.id}`,
      solvesCaptchas: false,
      context,
      close: once(async () => {
        await browser.close().catch(() => {})
        return release()
      }),
    }
  } catch (error) {
    await release()
    throw error
  }
}

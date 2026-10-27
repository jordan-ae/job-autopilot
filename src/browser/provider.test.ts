import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Browser Use provider against a fake API and a fake Playwright: what it
 * asks for, that every way out stops the session (closing CDP does not stop
 * billing), and where the session's cost comes from. Nothing leaves the process.
 */

const h = vi.hoisted(() => ({
  connect: null as null | ((url: string) => Promise<unknown>),
  browserClosed: 0,
}))

vi.mock('playwright-core', () => ({
  chromium: {
    connectOverCDP: (url: string) => h.connect!(url),
    launch: async () => {
      throw new Error('no local browser in tests')
    },
  },
}))

import { env } from '../config.js'
import { openBrowserSession } from './provider.js'

interface Call {
  method: string
  url: string
  body: Record<string, unknown> | null
  headers: Record<string, string>
}

const CDP = 'wss://connect.browser-use.com/devtools/browser/abc?token=SECRET-TOKEN'
const saved = { ...env }
let calls: Call[] = []
let answers: Record<string, () => Response>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  calls = []
  h.browserClosed = 0
  Object.assign(env, { browserUseApiKey: 'bu_test_key', browserUseSolveCaptchas: true, browserUseProxyCountry: '' })
  h.connect = async () => ({
    contexts: () => [{ name: 'default-context' }],
    newContext: async () => ({}),
    close: async () => {
      h.browserClosed++
    },
  })
  answers = {
    'POST /browsers': () => json(201, { id: 'sess-1', status: 'active', cdpUrl: CDP, liveUrl: 'https://live.browser-use.com/sess-1' }),
    'PATCH /browsers/sess-1': () => json(200, { id: 'sess-1', status: 'stopped', browserCost: '0.000334', proxyCost: '0', proxyUsedMb: '0' }),
    'GET /browsers/sess-1': () => json(200, { id: 'sess-1', status: 'stopped', browserCost: '0.0005', proxyCost: '0.0001' }),
  }
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    calls.push({
      method,
      url,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers: init.headers as Record<string, string>,
    })
    const key = `${method} ${url.replace('https://api.browser-use.com/api/v4', '')}`
    const answer = answers[key]
    if (!answer) throw new Error(`unexpected request ${key}`)
    return answer()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(env, saved)
})

const stops = () => calls.filter((call) => call.method === 'PATCH')

describe('openBrowserSession: browseruse', () => {
  it('asks for a short session with the solver on, no proxy and no recording', async () => {
    const session = await openBrowserSession({ provider: 'browseruse', timeoutSeconds: 240 })
    const [create] = calls
    expect(create).toMatchObject({ method: 'POST', url: 'https://api.browser-use.com/api/v4/browsers' })
    expect(create.headers['X-Browser-Use-API-Key']).toBe('bu_test_key')
    expect(create.headers.Authorization).toBeUndefined()
    // The API defaults to a US proxy billed per GB; it is turned off explicitly.
    expect(create.body).toMatchObject({ solveCaptchas: true, proxyCountryCode: null, enableRecording: false, timeout: 4 })
    expect(session).toMatchObject({ provider: 'browseruse', sessionId: 'sess-1', solvesCaptchas: true, inspectUrl: 'https://live.browser-use.com/sess-1' })
    await session.close()
  })

  it('uses a proxy country and turns the solver off only when told to', async () => {
    Object.assign(env, { browserUseProxyCountry: 'de', browserUseSolveCaptchas: false })
    const session = await openBrowserSession({ provider: 'browseruse', record: true })
    expect(calls[0].body).toMatchObject({ proxyCountryCode: 'de', solveCaptchas: false, enableRecording: true, timeout: 10 })
    expect(session.solvesCaptchas).toBe(false)
    await session.close()
  })

  it('stops the session on close and reports what it cost', async () => {
    const session = await openBrowserSession({ provider: 'browseruse' })
    expect(await session.close()).toEqual({ costUsd: 0.000334 })
    expect(h.browserClosed).toBe(1)
    expect(stops()).toEqual([expect.objectContaining({ url: 'https://api.browser-use.com/api/v4/browsers/sess-1', body: { action: 'stop' } })])
  })

  it('stops it once, however many times it is closed', async () => {
    const session = await openBrowserSession({ provider: 'browseruse' })
    await Promise.all([session.close(), session.close()])
    await session.close()
    expect(stops()).toHaveLength(1)
  })

  it('reads the cost from the session when the stop is refused', async () => {
    answers['PATCH /browsers/sess-1'] = () => json(404, { detail: 'already stopped' })
    const session = await openBrowserSession({ provider: 'browseruse' })
    expect(await session.close()).toEqual({ costUsd: 0.0006 })
  })

  it('reports no cost rather than failing when the API is unreachable', async () => {
    answers['PATCH /browsers/sess-1'] = () => {
      throw new Error('fetch failed')
    }
    const session = await openBrowserSession({ provider: 'browseruse' })
    expect(await session.close()).toEqual({ costUsd: null })
  })

  it('stops the session when connecting fails, without quoting the connect address', async () => {
    h.connect = async (url) => {
      throw new Error(`browserType.connectOverCDP: WebSocket error: ${url}`)
    }
    const error = await openBrowserSession({ provider: 'browseruse' }).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('SECRET-TOKEN')
    expect((error as Error).message).toContain('sess-1')
    expect(stops()).toHaveLength(1)
  })

  it('stops a session that came back without a CDP address', async () => {
    answers['POST /browsers'] = () => json(201, { id: 'sess-1', status: 'active', cdpUrl: null })
    await expect(openBrowserSession({ provider: 'browseruse' })).rejects.toThrow(/without a CDP address/)
    expect(stops()).toHaveLength(1)
  })

  it('says why when the session cannot be created, and has nothing to stop', async () => {
    answers['POST /browsers'] = () => json(429, { detail: 'Too many concurrent active sessions' })
    await expect(openBrowserSession({ provider: 'browseruse' })).rejects.toThrow(/browseruse create browser -> 429/)
    expect(stops()).toHaveLength(0)
  })

  it('needs its key', async () => {
    Object.assign(env, { browserUseApiKey: '' })
    await expect(openBrowserSession({ provider: 'browseruse' })).rejects.toThrow(/BROWSER_USE_API_KEY/)
    expect(calls).toHaveLength(0)
  })
})

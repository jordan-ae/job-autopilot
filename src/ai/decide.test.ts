import { describe, expect, it, vi } from 'vitest'
import { costOf, decide, DecisionMeter, noulConfidence, type ChoiceQuestion } from './decide.js'

/** A fetch that answers like TypeSafe's /v1/systemone. Nothing here touches the network. */
function fakeFetch(body: unknown, status = 200, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

const QUESTION: { pick: ChoiceQuestion } = {
  pick: { type: 'choice', instructions: 'Which department?', criteria: { returns: 'Returns', billing: 'Billing' } },
}

describe('decide', () => {
  it('does nothing without a key', async () => {
    const fetchImpl = vi.fn()
    const result = await decide('state', QUESTION, { apiKey: '', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends model, state and questions with a bearer key, and reads the answers', async () => {
    let sent: { url: string; init: RequestInit } | null = null
    const result = await decide('my card was charged twice', QUESTION, {
      apiKey: 'ts_test',
      model: 'jev-1.13.0',
      fetchImpl: fakeFetch(
        {
          model: 'jev-1.13.0',
          answers: { pick: { type: 'choice', choice: 'billing', confidence: 0.97, probabilities: { returns: 0.01, billing: 0.99 } } },
          usage: { input_tokens: 1000, output_tokens: 3 },
        },
        200,
        (url, init) => (sent = { url, init }),
      ),
    })
    expect(sent!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe('Bearer ts_test')
    expect(JSON.parse(String(sent!.init.body))).toEqual({ model: 'jev-1.13.0', state: 'my card was charged twice', questions: QUESTION })
    expect(result.ok && result.answers.pick.choice).toBe('billing')
    expect(result.ok && result.usage.inputTokens).toBe(1000)
    expect(result.ok && result.usage.costUsd).toBeCloseTo(costOf(1000, 3))
  })

  it('rejects requests the API would refuse, before sending them', async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]))
    const result = await decide('s', { q: { type: 'choice', instructions: 'x', criteria: tooMany } }, { apiKey: 'k', fetchImpl: fakeFetch({}) })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_request' })
    const score = await decide('s', { q: { type: 'score', instructions: 'x', criteria: ['only one'] } }, { apiKey: 'k', fetchImpl: fakeFetch({}) })
    expect(score).toMatchObject({ ok: false, reason: 'invalid_request' })
  })

  it('degrades on errors, timeouts and malformed answers', async () => {
    expect(await decide('s', QUESTION, { apiKey: 'k', fetchImpl: fakeFetch({ detail: [{ msg: 'bad' }] }, 422) })).toMatchObject({ ok: false, reason: 'http_error' })
    expect(
      await decide('s', QUESTION, { apiKey: 'k', fetchImpl: fakeFetch({ answers: { pick: { type: 'choice', choice: 'nonsense', confidence: 1 } } }) }),
    ).toMatchObject({ ok: false, reason: 'bad_response' })
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
    expect(await decide('s', QUESTION, { apiKey: 'k', fetchImpl: hang, timeoutMs: 20 })).toMatchObject({ ok: false, reason: 'timeout' })
    const down = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await decide('s', QUESTION, { apiKey: 'k', fetchImpl: down })).toMatchObject({ ok: false, reason: 'http_error' })
  })

  it('meters usage across calls', async () => {
    const meter = new DecisionMeter()
    const fetchImpl = fakeFetch({ answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 500, output_tokens: 1 }, model: 'jev-1.13.0' })
    await decide('s', { yes: { type: 'noul', instructions: 'x' } }, { apiKey: 'k', fetchImpl, onUsage: meter.record })
    await decide('s', { yes: { type: 'noul', instructions: 'x' } }, { apiKey: 'k', fetchImpl, onUsage: meter.record })
    expect(meter.toJSON()).toMatchObject({ calls: 2, inputTokens: 1000, model: 'jev-1.13.0' })
    expect(noulConfidence({ type: 'noul', noul: 0.9 })).toBeCloseTo(0.8)
  })
})

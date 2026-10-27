import { env } from '../config.js'
import type { BrowserProviderName } from '../browser/provider.js'

/**
 * What one executor run cost, for the attempt's `cost_usd` — what the
 * monthly compute budget gate (submitGates.ts `compute_budget`) adds up.
 *
 * Browser Use reports what each session cost (browser time plus any proxy),
 * and that figure is used as given. Otherwise browser time is estimated the
 * way both cloud providers bill it: by the started minute, one-minute
 * minimum, at BROWSER_USD_PER_MINUTE or the provider's list price. A local
 * browser costs nothing. Model calls are added as reported; the fill engine
 * itself makes none.
 */

/** List prices per browser minute. */
export const LIST_USD_PER_MINUTE: Record<BrowserProviderName, number> = {
  local: 0,
  browseruse: 0.02 / 60,
  browserbase: 0.12 / 60,
}

export function billedBrowserMinutes(provider: BrowserProviderName | '', browserMs: number): number {
  if (provider === '' || provider === 'local') return 0
  return Math.max(1, Math.ceil(Math.max(0, browserMs) / 60_000))
}

export interface RunCost {
  browserMinutes: number
  browserUsd: number
  modelUsd: number
  totalUsd: number
  /** Whether browserUsd is the provider's own figure or our estimate. */
  source: 'provider' | 'estimate'
}

/** Rounded to a millionth of a dollar, the precision cost_usd is read at. */
const usd = (value: number) => Math.round(value * 1_000_000) / 1_000_000

export function runCost(input: {
  provider: BrowserProviderName | ''
  browserMs: number
  /** The provider's own figure for the session, when it gave one. */
  reportedUsd?: number | null
  modelUsd?: number
  usdPerMinute?: number | null
}): RunCost {
  const browserMinutes = billedBrowserMinutes(input.provider, input.browserMs)
  const rate = input.usdPerMinute ?? env.browserUsdPerMinute ?? (input.provider ? LIST_USD_PER_MINUTE[input.provider] : 0)
  const reported = input.reportedUsd != null && Number.isFinite(input.reportedUsd) && input.reportedUsd >= 0
  const browserUsd = usd(reported ? input.reportedUsd! : browserMinutes * (Number.isFinite(rate) && rate > 0 ? rate : 0))
  const modelUsd = usd(Math.max(0, input.modelUsd ?? 0))
  return { browserMinutes, browserUsd, modelUsd, totalUsd: usd(browserUsd + modelUsd), source: reported ? 'provider' : 'estimate' }
}

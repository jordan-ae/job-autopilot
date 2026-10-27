/**
 * Everything the agent reads from the environment, in one place. Every switch
 * that lets it do more than fill and check a form is off unless set.
 *
 * The CLI (src/cli/) layers its flags over these; a library caller can pass
 * its own values through the deps each module takes instead.
 */

export type BrowserProviderName = 'local' | 'browseruse' | 'browserbase'

function browserProviderFrom(value: string | undefined, fallback: BrowserProviderName): BrowserProviderName {
  return value === 'local' || value === 'browseruse' || value === 'browserbase' ? value : fallback
}

const number = (value: string | undefined, fallback: number) => {
  const parsed = value === undefined || value === '' ? NaN : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const env = {
  // ── Models ────────────────────────────────────────────────────────────────
  /** Jev (TypeSafe's decision model): field mapping, option picks, the prose gate, eligibility. */
  typesafeApiKey: process.env.TYPESAFE_API_KEY ?? '',
  /** Pinned: the decision thresholds (fields/thresholds.ts) were measured against it. */
  typesafeModel: process.env.TYPESAFE_MODEL || 'jev-1.13.0',
  typesafeBaseUrl: process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai',
  typesafeTimeoutMs: number(process.env.TYPESAFE_TIMEOUT_MS, 4000),
  typesafeInputUsdPerM: number(process.env.TYPESAFE_INPUT_USD_PER_M, 0.42),
  typesafeOutputUsdPerM: number(process.env.TYPESAFE_OUTPUT_USD_PER_M, 0),

  /** Drafted answers: any OpenAI-compatible chat endpoint. Fireworks by default. */
  llmApiKey: process.env.LLM_API_KEY ?? process.env.FIREWORKS_API_KEY ?? '',
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.fireworks.ai/inference/v1',
  /** DeepSeek V4 Pro: the quality tier that reliably finishes a structured answer. */
  fireworksModel: process.env.LLM_MODEL || process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4-pro-0813',

  // ── Browser ───────────────────────────────────────────────────────────────
  /** `local` (Chrome on this machine), `browseruse` or `browserbase`. */
  browserProvider: browserProviderFrom(process.env.BROWSER_PROVIDER, 'local'),
  /** The executor's own default, separate so a dev script can use another. */
  executorBrowserProvider: browserProviderFrom(process.env.APPLY_EXECUTOR_BROWSER ?? process.env.BROWSER_PROVIDER, 'local'),
  /** A Chromium to launch instead of the installed Chrome. */
  localChromiumPath: process.env.LOCAL_CHROMIUM_PATH ?? '',
  browserUseApiKey: process.env.BROWSER_USE_API_KEY ?? '',
  browserUseSolveCaptchas: process.env.BROWSER_USE_SOLVE_CAPTCHAS === 'true',
  /** ISO country code for Browser Use's proxy; empty leaves it off. */
  browserUseProxyCountry: (process.env.BROWSER_USE_PROXY_COUNTRY ?? '').trim().toLowerCase(),
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY ?? '',
  browserbaseRegion: process.env.BROWSERBASE_REGION ?? '',
  /** Overrides the providers' list prices when estimating a run's cost. */
  browserUsdPerMinute: process.env.BROWSER_USD_PER_MINUTE ? Number(process.env.BROWSER_USD_PER_MINUTE) : null,

  // ── Running ───────────────────────────────────────────────────────────────
  /** How long one run may hold an attempt. The browser stops a minute before. */
  leaseSeconds: Math.max(120, number(process.env.AUTOPILOT_LEASE_SECONDS, 300)),
  /** Follow a posting's Apply links to a form the fill engine has no driver for (src/navigator/). */
  autopilotAgentEnabled: process.env.AUTOPILOT_AGENT_ENABLED !== 'false',

  // ── Submitting ───────────────────────────────────────────────────────────
  // There is no environment switch for pressing submit: it takes an explicit
  // option on each run (`submit: true`, the CLI's --submit), and on a form the
  // navigator found, a second one (`agentSubmit`, --agent-submit).
  autopilotSubmitConfirmSeconds: Math.max(5, number(process.env.AUTOPILOT_SUBMIT_CONFIRM_SECONDS, 30)),

  // ── Limits the pre-submit gates enforce ──────────────────────────────────
  autopilotDailyCap: number(process.env.AUTOPILOT_DAILY_CAP, 50),
  autopilotCompanyCap: Math.max(1, number(process.env.AUTOPILOT_COMPANY_CAP, 2)),
  autopilotCompanyWindowDays: Math.max(1, number(process.env.AUTOPILOT_COMPANY_WINDOW_DAYS, 30)),
  autopilotMonthlyBudgetUsd: number(process.env.AUTOPILOT_MONTHLY_BUDGET_USD, 4),
}

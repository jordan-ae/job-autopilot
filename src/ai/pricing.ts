/** USD per 1M tokens, [input, output], Fireworks' standard serverless tier.
 * Update as pricing changes: https://docs.fireworks.ai/serverless/pricing */
const PRICING: Record<string, [number, number]> = {
  'accounts/fireworks/models/kimi-k2p6': [0.95, 4],
  'accounts/fireworks/models/kimi-k2p7-code': [0.95, 4],
  'accounts/fireworks/models/deepseek-v4-pro': [1.32, 3.96],
  'accounts/fireworks/models/deepseek-v4-pro-0813': [1.32, 3.96],
  'accounts/fireworks/models/deepseek-v4-flash-0731': [0.22, 0.66],
  'accounts/fireworks/models/deepseek-v4p1-flash': [0.22, 0.66],
  'accounts/fireworks/models/kimi-k3': [3, 15],
  'accounts/fireworks/models/qwen3p7-plus': [0.4, 1.6],
  'accounts/fireworks/models/qwen3p8-max': [2, 6],
  'accounts/fireworks/models/gpt-oss-120b': [0.15, 0.6],
  'accounts/fireworks/models/glm-5p3': [1.4, 4.4],
  'accounts/fireworks/models/glm-5p3-flash': [0.15, 0.5],
  'accounts/fireworks/models/minimax-m3': [0.3, 1.2],
}

/** Unknown models are estimated at top-of-catalog rates so we over- rather than under-count. */
const FALLBACK: [number, number] = [2, 6]

function ratesFor(model: string): [number, number] {
  // Match the longest known prefix so versioned snapshots (kimi-k2p6-0905) resolve.
  let best: [number, number] | null = null
  let bestLen = 0
  for (const [name, rates] of Object.entries(PRICING)) {
    if (model.startsWith(name) && name.length > bestLen) {
      best = rates
      bestLen = name.length
    }
  }
  return best ?? FALLBACK
}

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const [inRate, outRate] = ratesFor(model)
  const cost = (promptTokens * inRate + completionTokens * outRate) / 1_000_000
  return Math.round(cost * 10_000) / 10_000
}

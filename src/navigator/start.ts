import { classifyApplyTarget, formLinksIn, isWalled, wallCode, wallSentence, type ApplyTarget } from './target.js'

/**
 * Where the agent runner starts for a posting, decided without a browser.
 *
 * The posting's apply link, unless its description links to exactly one
 * fill-engine form (an HN thread naming its Ashby posting, a board's copy
 * quoting the Greenhouse link): then that form, which the normal executor run
 * carries. Exactly one, because a description that links several is a
 * company's whole board, and the wrong one would be an application to the
 * wrong job.
 */
export type AgentStart =
  | { kind: 'go'; url: string; target: Exclude<ApplyTarget, { kind: 'account' | 'login' | 'invalid' }> }
  | { kind: 'walled'; url: string; code: 'account_required' | 'login_required' | 'unsupported'; reason: string }

export function agentStartFrom(applyUrl: string, description: string): AgentStart {
  const links = formLinksIn(description)
  if (links.length === 1) {
    const target = classifyApplyTarget(links[0])
    if (target.kind === 'fill') return { kind: 'go', url: links[0], target }
  }
  const target = classifyApplyTarget(applyUrl)
  if (isWalled(target)) return { kind: 'walled', url: applyUrl, code: wallCode(target), reason: wallSentence(target) }
  return { kind: 'go', url: applyUrl, target }
}

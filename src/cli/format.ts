import type { Attempt } from '../attempt.js'
import type { GateResult } from '../executor/gates.js'
import type { AutopilotReceipt } from '../executor/receipt.js'
import type { ExecutionReport } from '../executor/report.js'
import type { PressSummary } from '../executor/submitRun.js'
import type { Plan } from '../selection/plan.js'
import type { AgentAnswerRecord } from '../store/types.js'

/** What the CLI prints. Plain text, no colour codes unless the terminal is a TTY. */

const tty = process.stdout.isTTY === true
const paint = (code: number) => (text: string) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text)
export const bold = paint(1)
export const dim = paint(2)
export const green = paint(32)
export const red = paint(31)
export const yellow = paint(33)

const row = (label: string, value: string) => `  ${dim(label.padEnd(12))}${value}`
const usd = (value: number) => `$${value.toFixed(4)}`

function passed(gates: Record<string, GateResult>): string {
  const all = Object.values(gates)
  return `${all.filter((gate) => gate.ok).length} of ${all.length} passed`
}

function gateLine(gates: Record<string, GateResult>): string[] {
  return Object.entries(gates).map(([name, gate]) => {
    const mark = !gate.ran ? dim('·') : gate.ok ? green('✓') : red('✗')
    return `    ${mark} ${name.padEnd(20)} ${dim(gate.detail)}`
  })
}

export function formatReport(report: ExecutionReport, attempt: Attempt | null, company: string, role: string): string {
  const out: string[] = []
  out.push('', bold(`${company}${role ? ` — ${role}` : ''}`))
  if (report.navigation) {
    out.push(row('navigated', `${report.navigation.outcome} after ${report.navigation.hops.length} hop${report.navigation.hops.length === 1 ? '' : 's'}`))
    report.navigation.hops.forEach((hop, index) => out.push(`    ${index + 1}. ${dim(hop.url)} → ${hop.action}`))
  }
  if (report.formUrl) out.push(row('form', report.finalUrl || report.formUrl))
  out.push(row('mode', report.mode))

  const fieldMapper = attempt?.payload.fieldMapper
  if (fieldMapper) {
    const drafted = fieldMapper.answers.map((answer) => answer.label)
    out.push(row('wrote', drafted.length ? `${drafted.length} draft${drafted.length === 1 ? '' : 's'}: ${drafted.join('; ')}` : 'nothing to draft'))
    if (fieldMapper.mappings.length) out.push(row('mapped', fieldMapper.mappings.map((mapping) => `${mapping.questionId} → ${mapping.fieldKey}`).join(', ')))
    if (fieldMapper.notes.length) out.push(row('notes', dim(fieldMapper.notes.join(', '))))
  } else {
    out.push(row('wrote', dim('agent pass off (no TYPESAFE_API_KEY): stored data only')))
  }

  if (report.page) {
    out.push(row('filled', `${report.counts.filled} of ${report.counts.fields} fields, ${report.counts.failed} refused, ${report.counts.left} left for you`))
    for (const field of report.filled) {
      const mark = field.ok ? green('✓') : red('✗')
      out.push(`    ${mark} ${field.label.padEnd(36).slice(0, 36)} ${dim(field.source.padEnd(8))} ${field.observed}${field.ok ? '' : red(`  (${field.reason})`)}`)
    }
    for (const field of report.left) {
      out.push(`    ${yellow('–')} ${field.label.padEnd(36).slice(0, 36)} ${dim(field.reason)}${field.required ? yellow('  required') : ''}`)
    }
  }
  if (report.gates) {
    out.push(row('form gates', passed(report.gates)))
    out.push(...gateLine(report.gates))
  }
  if (report.submit?.gates) {
    out.push(row('pre-submit', `${passed(report.submit.gates)} ${dim(`(${report.submit.policyReason})`)}`))
    out.push(...gateLine(report.submit.gates))
  }
  if (report.submit?.clickedAt) {
    out.push(row('pressed', `${report.submit.clickedAt}: ${report.submit.result} ${dim(report.submit.evidence)}`))
  }
  if (report.submit?.screenshot) out.push(row('screenshot', report.submit.screenshot))

  const outcomeColour = report.outcome === 'submitted' || report.outcome === 'passed' || report.outcome === 'rehearsed' ? green : report.outcome === 'retry' ? yellow : red
  out.push(row('outcome', `${outcomeColour(report.outcome)} → ${report.status}`))
  if (report.reason) out.push(row('', report.reason))
  if (report.error && report.error !== report.reason) out.push(row('error', red(report.error)))
  out.push(row('cost', `${usd(report.cost.browserUsd)} browser + ${usd(report.cost.modelUsd)} model, ${(report.durationMs / 1000).toFixed(1)}s`))
  if (attempt) out.push(row('attempt', `${attempt.id} ${dim(`(${attempt.status})`)}`))
  return out.join('\n')
}

export function formatPress(summary: PressSummary): string {
  const out = ['', bold(`About to submit to ${summary.company}${summary.role ? ` — ${summary.role}` : ''}`), row('form', summary.formUrl), row('button', `"${summary.button}"`)]
  if (summary.screenshot) out.push(row('screenshot', summary.screenshot))
  out.push(row('sending', ''))
  for (const field of summary.fields) {
    out.push(`    ${field.label.padEnd(36).slice(0, 36)} ${dim(field.source.padEnd(8))} ${field.value}${field.draft ? yellow('  (drafted)') : ''}`)
  }
  return out.join('\n')
}

export function formatReceipt(receipt: AutopilotReceipt): string {
  const out = [row('receipt', `${receipt.status}: ${receipt.fields.length} fields, CV ${receipt.documents.resume?.fileName ?? 'none'} (sha256 ${receipt.documents.resume?.sha256.slice(0, 12) ?? '-'})`)]
  if (receipt.confirmation) out.push(row('', `"${receipt.confirmation.text}"`))
  return out.join('\n')
}

export function formatAttempts(rows: Array<{ attempt: Attempt; company: string; role: string }>): string {
  if (rows.length === 0) return 'No applications yet.'
  return rows
    .map(({ attempt, company, role }) => `${attempt.id}  ${attempt.status.padEnd(18)} ${company}${role ? ` — ${role}` : ''}${attempt.blocked_reason ? dim(`  (${attempt.blocked_reason})`) : ''}`)
    .join('\n')
}

export function formatAnswers(rows: AgentAnswerRecord[]): string {
  if (rows.length === 0) return 'The agent has drafted nothing yet.'
  return rows
    .map((row, index) => {
      const state = row.reviewState === 'pending' ? yellow('pending') : green(row.reviewState)
      return `${String(index + 1).padStart(2)}. ${state}  ${bold(row.label)}\n    ${row.answer.replace(/\n/g, '\n    ')}`
    })
    .join('\n\n')
}

export function formatPlan(plan: Plan): string {
  const out: string[] = []
  const c = plan.counts
  out.push(bold(`${c.pool} postings → ${c.relevant} relevant → ${c.shortlisted} shortlisted → ${c.picked} picked`))
  out.push(dim(`already applied ${c.alreadyApplied}, walled ${c.walled}, eligible ${c.eligible}, ineligible ${c.ineligible}, unknown ${c.unknown}; ${c.jevCalls} Jev calls ($${plan.usage.costUsd.toFixed(4)})`))
  for (const [title, list] of [['Picked', plan.picks], ['Reserve', plan.reserves]] as const) {
    if (!list.length) continue
    out.push('', bold(title))
    for (const pick of list) {
      out.push(`  ${pick.matchScore.toFixed(2)}  ${pick.job.company} — ${pick.job.role}  ${dim(`${pick.route}, ${pick.eligibility}`)}`)
      out.push(`        ${dim(pick.reason)}`)
      out.push(`        ${dim(pick.job.apply_url)}`)
    }
  }
  if (plan.skips.length) {
    out.push('', bold('Skipped'))
    for (const skip of plan.skips.slice(0, 20)) out.push(`  ${skip.code.padEnd(20)} ${skip.job.company} — ${skip.job.role}  ${dim(skip.reason)}`)
  }
  if (plan.notes.length) out.push('', dim(plan.notes.join('\n')))
  return out.join('\n')
}

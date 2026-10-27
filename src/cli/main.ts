#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { applicantFrom, loadApplicant, type Applicant, type ProfileFile } from '../applicant.js'
import { newAttempt, type Attempt } from '../attempt.js'
import { env } from '../config.js'
import { executorDeps, type RunOptions } from '../executor/deps.js'
import { runClaimedAttempt } from '../executor/run.js'
import type { PressSummary } from '../executor/submitRun.js'
import { postingFromUrl } from '../posting.js'
import { poolJob, selectJobs } from '../selection/select.js'
import { FileStore } from '../store/file.js'
import { placeholderCv, startDemoSite } from './demo.js'
import { bold, dim, formatAnswers, formatAttempts, formatPlan, formatPress, formatReceipt, formatReport, red, yellow } from './format.js'

const HELP = `job-autopilot — a job-application agent that never invents a fact

Usage
  job-autopilot demo [--rehearse | --submit] [--headed]
      The whole agent against a careers page on localhost. Nothing leaves the machine.

  job-autopilot apply <job-url> --profile <profile.json> --cv <cv.pdf> [options]
      Plan, write and fill one application in a browser. Stops before submit
      unless --submit is given.

  job-autopilot run <attempt-id> --profile <profile.json> --cv <cv.pdf> [options]
      Run an attempt again: after you approved it, or after a failed run.

  job-autopilot approve <attempt-id>
      Approve an application that waits for you (drafts reviewed, eligibility checked).

  job-autopilot answers [--approve <n>] [--correct <n> --text <answer>]
      What the agent drafted, for you to approve or correct. Your correction
      is what is used next time.

  job-autopilot select --jobs <jobs.json> --profile <profile.json> --cv <cv.pdf> [--wanted <n>] [--queue]
      Which of a list of postings to apply to next, and why the rest were passed over.

  job-autopilot show [<attempt-id>]
      Every application, or one application's last report and receipt.

Options
  --rehearse            Run every pre-submit gate and take the screenshot, then stop.
  --submit              Press submit once, if every gate passes and you type the company's name.
  --agent-submit        Also allow submit on a form the navigator found (not Greenhouse, Lever or Ashby).
  --company, --role     The employer and job title, when the link does not say.
  --description <file>  The posting's text, for the drafter and for finding a direct form link.
  --found-on <board>    Where you found the posting, if on a job board: answers "How did you hear about us?".
  --letter <file>       A cover letter, as text.
  --headed              Show the browser window.
  --provider <name>     local (default), browseruse or browserbase.
  --no-agent            Skip the agent pass: fill from stored data only.
  --no-navigate         Only fill Greenhouse, Lever and Ashby forms; never follow Apply links.
  --state <dir>         Where attempts, drafts and receipts are kept (default .autopilot).
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    cv: { type: 'string' },
    letter: { type: 'string' },
    company: { type: 'string' },
    role: { type: 'string' },
    description: { type: 'string' },
    'found-on': { type: 'string' },
    rehearse: { type: 'boolean' },
    submit: { type: 'boolean' },
    'agent-submit': { type: 'boolean' },
    headed: { type: 'boolean' },
    provider: { type: 'string' },
    'no-agent': { type: 'boolean' },
    'no-navigate': { type: 'boolean' },
    state: { type: 'string' },
    jobs: { type: 'string' },
    wanted: { type: 'string' },
    queue: { type: 'boolean' },
    approve: { type: 'string' },
    correct: { type: 'string' },
    text: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [command, target] = positionals
const store = new FileStore(resolve(values.state ?? '.autopilot'))

function fail(message: string): never {
  console.error(red(message))
  process.exit(1)
}

function mode(): RunOptions['mode'] {
  if (values.submit && values.rehearse) fail('--submit and --rehearse are two different runs: pick one.')
  return values.submit ? 'submit' : values.rehearse ? 'rehearse' : 'dry_run'
}

function provider(): RunOptions['provider'] {
  const name = values.provider ?? env.executorBrowserProvider
  if (name !== 'local' && name !== 'browseruse' && name !== 'browserbase') fail(`unknown --provider ${name}`)
  return name
}

function applicant(): Applicant {
  if (!values.profile || !values.cv) fail('--profile <profile.json> and --cv <cv.pdf> are required.')
  try {
    return loadApplicant({ profile: values.profile, cv: values.cv, coverLetter: values.letter })
  } catch (error) {
    fail((error as Error).message)
  }
}

/** The pilot's rule: show everything that will be sent, and press only once the company's name is typed. */
async function confirmByName(summary: PressSummary): Promise<boolean> {
  console.log(formatPress(summary))
  if (!process.stdin.isTTY) {
    console.log(yellow('\nNot a terminal: nothing to confirm with, so nothing is pressed.'))
    return false
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const typed = await prompt.question(`\nType ${bold(summary.company)} to press submit, anything else to stop: `)
  prompt.close()
  return typed.trim().toLowerCase() === summary.company.trim().toLowerCase()
}

async function runAttempt(person: Applicant, attemptId: string): Promise<void> {
  const runMode = mode()
  const deps = executorDeps({
    store,
    applicant: person,
    mode: runMode,
    agentSubmit: values['agent-submit'] === true,
    provider: provider(),
    headed: values.headed === true,
    navigate: values['no-navigate'] !== true,
    agentPass: values['no-agent'] !== true,
    ...(runMode === 'submit' ? { confirmPress: confirmByName } : {}),
  })
  await store.recoverStale(deps.maxRuns)
  const claimed = await store.claimAttempt(attemptId, deps.owner, deps.leaseSeconds)
  if (!claimed) {
    const attempt = await store.getAttempt(attemptId)
    fail(attempt ? `Attempt ${attemptId} is ${attempt.status}, not ready to run.` : `No attempt ${attemptId}.`)
  }
  const posting = await store.getPosting(claimed.job_id)
  console.log(dim(`${runMode === 'dry_run' ? 'Dry run' : runMode === 'rehearse' ? 'Rehearsal' : 'Submit run'}: ${posting?.apply_url ?? ''}`))
  const report = await runClaimedAttempt(claimed, deps)
  const attempt = await store.getAttempt(attemptId)
  console.log(formatReport(report, attempt, posting?.company ?? '', posting?.role ?? ''))
  const receipt = await store.getReceipt(attemptId)
  if (receipt) console.log(formatReceipt(receipt))
}

async function queueAttempt(person: Applicant, url: string, details: Parameters<typeof postingFromUrl>[1], extra: Partial<Attempt> = {}): Promise<string> {
  const posting = postingFromUrl(url, details)
  const known = await store.getPosting(posting.id)
  await store.savePosting({ ...posting, ...(known ? { active: known.active } : {}) })
  const attempt: Attempt = {
    ...newAttempt({ id: randomUUID().slice(0, 8), userId: person.userId, jobId: posting.id, targetUrl: url, tailoredDocumentId: person.documentId, dryRun: mode() !== 'submit' }),
    ...extra,
  }
  await store.createAttempt(attempt)
  return attempt.id
}

async function main(): Promise<void> {
  if (values.help || !command) {
    console.log(HELP)
    return
  }
  switch (command) {
    case 'apply': {
      if (!target) fail('apply needs the job link.')
      const person = applicant()
      const description = values.description ? readFileSync(values.description, 'utf8') : undefined
      const id = await queueAttempt(person, target, { company: values.company, role: values.role, description, foundOn: values['found-on'] })
      await runAttempt(person, id)
      return
    }
    case 'run': {
      if (!target) fail('run needs an attempt id.')
      await runAttempt(applicant(), target)
      return
    }
    case 'approve': {
      if (!target) fail('approve needs an attempt id.')
      const attempt = (await store.getAttempt(target)) ?? fail(`No attempt ${target}.`)
      if (!(await store.approveAttempt(target))) {
        fail(`Attempt ${target} is ${attempt.status}${attempt.executor === 'assisted' ? ', handed to you to finish' : ''}: nothing to approve.`)
      }
      console.log(`Approved ${target}. Send it with: job-autopilot run ${target} --profile <profile.json> --cv <cv.pdf> --submit`)
      return
    }
    case 'answers': {
      const userId = values.profile ? (JSON.parse(readFileSync(values.profile, 'utf8')) as ProfileFile).id?.trim() || 'me' : await soleUser()
      const rows = await store.listAgentAnswers(userId)
      const pick = (raw: string) => rows[Number(raw) - 1] ?? fail(`No draft ${raw}.`)
      if (values.approve) {
        await store.reviewAgentAnswer(userId, pick(values.approve).fingerprint, { approved: true })
      } else if (values.correct) {
        if (!values.text) fail('--correct needs --text "<your answer>".')
        await store.reviewAgentAnswer(userId, pick(values.correct).fingerprint, { corrected: values.text })
      }
      console.log(formatAnswers(await store.listAgentAnswers(userId)))
      return
    }
    case 'select': {
      if (!values.jobs) fail('select needs --jobs <jobs.json>.')
      const person = applicant()
      const raw = JSON.parse(readFileSync(values.jobs, 'utf8')) as Array<Parameters<typeof poolJob>[0]>
      const jobs = raw.map((job, index) => poolJob(job, index))
      const plan = await selectJobs({ store, applicant: person, jobs, wanted: values.wanted ? Number(values.wanted) : undefined })
      console.log(formatPlan(plan))
      if (values.queue) {
        for (const pick of plan.picks) {
          const id = await queueAttempt(
            person,
            pick.job.apply_url,
            { company: pick.job.company, role: pick.job.role, location: pick.job.location, description: pick.job.description ?? '', foundOn: pick.job.found_on ?? undefined },
            {
              match_score: pick.matchScore,
              profile_id: pick.profileId,
              gate_results: { selection: { eligibility: pick.eligibility === 'eligible' ? 'eligible' : 'unknown', reason: pick.reason } },
            },
          )
          console.log(`queued ${id}  ${pick.job.company} — ${pick.job.role}`)
        }
      }
      return
    }
    case 'show': {
      if (target) {
        const attempt = (await store.getAttempt(target)) ?? fail(`No attempt ${target}.`)
        const posting = await store.getPosting(attempt.job_id)
        const report = (attempt.payload.executorRuns ?? []).at(-1) as Parameters<typeof formatReport>[0] | undefined
        if (report) console.log(formatReport(report, attempt, posting?.company ?? '', posting?.role ?? ''))
        else console.log(`${attempt.id}: ${attempt.status}, never run.`)
        const receipt = await store.getReceipt(target)
        if (receipt) console.log(formatReceipt(receipt))
        return
      }
      const userId = await soleUser()
      const attempts = await store.listAttempts(userId)
      const rows = await Promise.all(attempts.map(async (attempt) => ({ attempt, company: (await store.getPosting(attempt.job_id))?.company ?? '', role: (await store.getPosting(attempt.job_id))?.role ?? '' })))
      console.log(formatAttempts(rows))
      return
    }
    case 'demo': {
      await demo()
      return
    }
    default:
      fail(`Unknown command "${command}". Try --help.`)
  }
}

/** The one applicant this folder holds applications for. */
async function soleUser(): Promise<string> {
  const state = join(store.dir, 'state.json')
  if (!existsSync(state)) return 'me'
  const ids = new Set((JSON.parse(readFileSync(state, 'utf8')).attempts as Attempt[]).map((attempt) => attempt.client_key))
  return [...ids][0] ?? 'me'
}

async function demo(): Promise<void> {
  const site = await startDemoSite()
  try {
    const examples = fileURLToPath(new URL('../../examples/profile.example.json', import.meta.url))
    const file = JSON.parse(readFileSync(examples, 'utf8')) as ProfileFile
    const dir = resolve(store.dir, 'demo')
    mkdirSync(dir, { recursive: true })
    const cvPath = join(dir, 'Ada-Lovelace-CV.pdf')
    writeFileSync(cvPath, await placeholderCv(file.profile.full_name ?? 'Ada Lovelace'))
    const person = applicantFrom(file, { bytes: readFileSync(cvPath), fileName: 'Ada-Lovelace-CV.pdf' })
    console.log(dim(`Demo careers site at ${site.jobUrl} (localhost only).`))
    const runMode = mode()
    const id = await queueAttempt(person, site.jobUrl, { company: 'Example Labs', role: 'Platform Engineer', location: 'London, United Kingdom' })
    // The demo form is not Greenhouse, Lever or Ashby: submitting it needs the second switch, which the demo gives itself.
    if (runMode === 'submit') values['agent-submit'] = true
    await runAttempt(person, id)
    if (site.received()) console.log(`\nThe demo site received ${site.received()} application.`)
  } finally {
    await site.close()
  }
}

main().catch((error) => fail((error as Error).stack ?? String(error)))

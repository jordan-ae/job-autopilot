// The agent, as a library. The CLI (src/cli/) is one caller of exactly this.

// Who is applying, and to what.
export { applicantFrom, applyContext, loadApplicant, profileFrom, withReviewedAnswers, type Applicant, type ProfileFile } from './applicant.js'
export { newAttempt, type Attempt } from './attempt.js'
export { postingFromUrl, postingRef } from './posting.js'
export { DEFAULT_SETTINGS, effectiveMode, type AutopilotSettings, type DraftPolicy } from './settings.js'
export type { ApplicationProfile, ApplyContext, ApplyQuestion, JobRow, ProfileTargeting, ResumeFacts, WorkAuthorization } from './types.js'

// Plan: which postings, and what goes in each field.
export { selectJobs, poolJob, routeOf } from './selection/select.js'
export { planSelection, type Plan, type PlannedJob, type SkippedJob } from './selection/plan.js'
export { checkEligibility, type EligibilityResult } from './selection/eligibility.js'
export { planFill, type FillPlan, type FillStep, type LeftField } from './plan/plan.js'
export { resolveQuestion, type Resolution, type ResolutionLayer } from './fields/resolver.js'
export { CANONICAL_FIELDS, fieldByKey, type CanonicalField } from './fields/registry.js'

// Write: the agent pass, for what stored data does not answer.
export { agentFill, type AgentDeps, type AgentOutcome, type ClassificationCache } from './fields/agent.js'
export { answerForm } from './fields/answerForm.js'
export { checkDraft, draftAnswer } from './fields/draft.js'
export { introducesNewNumbers, newNumbersIn, numbersIn } from './ai/facts.js'
export { decide, DecisionMeter, type JevQuestion } from './ai/decide.js'

// Act: the browser, the navigator, the run, the gates.
export { openBrowserSession, type BrowserSession, type OpenBrowserOptions } from './browser/provider.js'
export { navigateToForm, type NavOutcome } from './navigator/navigate.js'
export { classifyApplyTarget, refFromUrl, type ApplyTarget } from './navigator/target.js'
export { executorDeps, prepareRun, submitRunDeps, type RunOptions } from './executor/deps.js'
export { runClaimedAttempt, type ExecutorDeps, type PreparedRun } from './executor/run.js'
export { domDriver, playwrightDriver, type FormDriver } from './executor/driver.js'
export { decideGates, type GateDecision, type GateName, type GateResult } from './executor/gates.js'
export { decideSubmitGates, statedCompanyCap, TRAP_WORDING, type SubmitGateDecision, type SubmitGateName } from './executor/submitGates.js'
export { decideSubmitMode, type SubmitMode } from './executor/submitPolicy.js'
export { buildReceipt, type AutopilotReceipt } from './executor/receipt.js'
export type { ExecutionReport } from './executor/report.js'
export type { PressSummary } from './executor/submitRun.js'

// Where it keeps things.
export { MemoryStore } from './store/memory.js'
export { FileStore } from './store/file.js'
export { NO_BILLING, type BillingHooks, type HoldResult, type Store } from './store/types.js'

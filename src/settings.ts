/**
 * The applicant's settings for Autopilot: their shape, their defaults, and
 * the few things derived from them (the mode in force, today's target, the
 * next window it may run in). Read by selection (src/selection/) and by the
 * submit policy and gates (src/executor/).
 */

/** `anomaly`: set when submits keep failing. */
export type PauseReason = 'user' | 'credits' | 'budget' | 'setup' | 'anomaly'
export type AutopilotMode = 'review_first' | 'hands_free'
export type NotifyMode = 'each' | 'daily_digest' | 'off'
/**
 * Agent-drafted essays in an application Autopilot submits on its own:
 * `review_first` holds an application with an unreviewed draft for approval
 * until the user has reviewed `draftReviewCount` drafts; `allow` sends them;
 * `never` hands such an application back unless the user approved it.
 */
export type DraftPolicy = 'review_first' | 'allow' | 'never'

export const PAUSE_REASONS: readonly PauseReason[] = ['user', 'credits', 'budget', 'setup', 'anomaly']
export const MODES: readonly AutopilotMode[] = ['review_first', 'hands_free']
export const NOTIFY_MODES: readonly NotifyMode[] = ['each', 'daily_digest', 'off']
export const DRAFT_POLICIES: readonly DraftPolicy[] = ['review_first', 'allow', 'never']

/** One applicant's settings. */
export interface AutopilotSettings {
  enabled: boolean
  pausedReason: PauseReason | null
  dailyTarget: number
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  activeDays: number[]
  windowStartHour: number
  windowEndHour: number
  /** IANA, e.g. 'Africa/Lagos'. */
  timezone: string
  mode: AutopilotMode
  /** How many of Autopilot's applications are reviewed whatever the mode. */
  reviewFirstCount: number
  /** Resume profile ids to select for. Empty = every profile. */
  profileIds: string[]
  /** 0–1. */
  minMatch: number
  excludedCompanies: string[]
  excludedKeywords: string[]
  remoteOnly: boolean
  locations: string[]
  notify: NotifyMode
  draftPolicy: DraftPolicy
  /** Drafts to review before unreviewed ones may go out (draftPolicy review_first). */
  draftReviewCount: number
}

export const DEFAULT_SETTINGS: AutopilotSettings = {
  enabled: false,
  pausedReason: null,
  dailyTarget: 5,
  activeDays: [1, 2, 3, 4, 5],
  windowStartHour: 8,
  windowEndHour: 20,
  timezone: 'UTC',
  mode: 'review_first',
  reviewFirstCount: 5,
  profileIds: [],
  minMatch: 0.6,
  excludedCompanies: [],
  excludedKeywords: [],
  remoteOnly: false,
  locations: [],
  notify: 'daily_digest',
  draftPolicy: 'review_first',
  draftReviewCount: 5,
}

export function isValidTimezone(value: string): boolean {
  if (!value || value.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// ── Derived state ─────────────────────────────────────────────────────────────

/**
 * The mode in force. Hands-free begins only once the first
 * `reviewFirstCount` of Autopilot's applications have been sent: until then,
 * each one is reviewed whatever the user chose.
 */
export function effectiveMode(
  settings: Pick<AutopilotSettings, 'mode' | 'reviewFirstCount'>,
  sentCount: number,
): { mode: AutopilotMode; reviewsLeft: number } {
  const reviewsLeft = Math.max(0, settings.reviewFirstCount - sentCount)
  if (settings.mode === 'hands_free' && reviewsLeft === 0) return { mode: 'hands_free', reviewsLeft: 0 }
  return { mode: 'review_first', reviewsLeft: settings.mode === 'hands_free' ? reviewsLeft : 0 }
}

/**
 * How many Autopilot can file today: the user's target, under the safety cap,
 * and never more than the credits allow. `limitedBy` says which one bit.
 */
export function todaysTarget(input: {
  dailyTarget: number
  dailyCap: number
  appliedToday: number
  credits: number | null
}): { target: number; limitedBy: 'cap' | 'credits' | null } {
  let target = input.dailyTarget
  let limitedBy: 'cap' | 'credits' | null = null
  if (input.dailyCap < target) {
    target = input.dailyCap
    limitedBy = 'cap'
  }
  if (input.credits !== null) {
    const affordable = input.appliedToday + Math.max(0, input.credits)
    if (affordable < target) {
      target = affordable
      limitedBy = 'credits'
    }
  }
  return { target: Math.max(0, target), limitedBy }
}

// ── Time zones ────────────────────────────────────────────────────────────────

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localParts(at: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') }
}

/** How far `timezone` is ahead of UTC at `at`, in ms. */
function offsetMs(at: Date, timezone: string): number {
  const p = localParts(at, timezone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The instant a wall-clock time in `timezone` falls on. `hour` may be 24. */
export function zonedTime(year: number, month: number, day: number, hour: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour)
  const first = offsetMs(new Date(guess), timezone)
  let result = guess - first
  // Across a DST change the offset at the answer differs from the guess's.
  const second = offsetMs(new Date(result), timezone)
  if (second !== first) result = guess - second
  return new Date(result)
}

/** Midnight today in `timezone`, as an instant. */
export function startOfLocalDay(now: Date, timezone: string): Date {
  const p = localParts(now, timezone)
  return zonedTime(p.year, p.month, p.day, 0, timezone)
}

export interface RunWindow {
  startsAt: string
  endsAt: string
  /** Now is inside it. */
  activeNow: boolean
}

/**
 * The next stretch of time Autopilot may file in: today's window if it hasn't
 * ended, otherwise the next active day's. Null when no day is active.
 */
export function nextRunWindow(
  settings: Pick<AutopilotSettings, 'activeDays' | 'windowStartHour' | 'windowEndHour' | 'timezone'>,
  now: Date,
): RunWindow | null {
  if (settings.activeDays.length === 0) return null
  const timezone = isValidTimezone(settings.timezone) ? settings.timezone : 'UTC'
  const today = localParts(now, timezone)
  for (let offset = 0; offset <= 7; offset++) {
    const calendar = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
    const isoWeekday = calendar.getUTCDay() === 0 ? 7 : calendar.getUTCDay()
    if (!settings.activeDays.includes(isoWeekday)) continue
    const y = calendar.getUTCFullYear()
    const m = calendar.getUTCMonth() + 1
    const d = calendar.getUTCDate()
    const start = zonedTime(y, m, d, settings.windowStartHour, timezone)
    const end = zonedTime(y, m, d, settings.windowEndHour, timezone)
    if (now.getTime() >= end.getTime()) continue
    return {
      startsAt: (now > start ? now : start).toISOString(),
      endsAt: end.toISOString(),
      activeNow: now.getTime() >= start.getTime(),
    }
  }
  return null
}

/**
 * Today's window in `timezone`, as instants, whether or not it is active
 * today or has passed. The scheduler spreads the day's applications across it.
 */
export function windowBounds(
  settings: Pick<AutopilotSettings, 'windowStartHour' | 'windowEndHour' | 'timezone'>,
  now: Date,
): { start: Date; end: Date } {
  const timezone = isValidTimezone(settings.timezone) ? settings.timezone : 'UTC'
  const p = localParts(now, timezone)
  return {
    start: zonedTime(p.year, p.month, p.day, settings.windowStartHour, timezone),
    end: zonedTime(p.year, p.month, p.day, settings.windowEndHour, timezone),
  }
}

/** The user's calendar date today, 'YYYY-MM-DD', in `timezone`. */
export function localDay(now: Date, timezone: string): string {
  const p = localParts(now, isValidTimezone(timezone) ? timezone : 'UTC')
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

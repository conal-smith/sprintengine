import { formatTimeOfDay } from './clockFormat'

// Snooze: "not now, ask me again at <time>" (owner ruling, 2026-09-10).
//
// A snoozed chat STOPS RUNNING and comes back on a clock. Its terminals are
// suspended, so it sits exactly as the app's other non-live chats do — no agent
// process, just a row — and when the wake time passes the row simply returns to
// the sidebar. Nothing is relaunched: the person's first keystroke resumes the
// agent under its own session id with `--resume`, the same way returning to a
// paused chat has always worked (owner ruling, 2026-09-10).
//
// Snooze first shipped visibility-only, on the rule that a snooze never touches
// the agent. That rule does not survive here: visibility-only suits a snooze
// whose session lives on a SERVER, where hiding costs nothing, while ours holds
// a live local process — so "hidden" meant a chat you had told to go away was
// the most expensive row in the tree. The suspend lives in
// `components/workspace/workspaceTerminalTermination.ts`; this module still
// only decides WHEN a row is asleep.
//
// Suspend, not kill, is the whole distinction from Settle — which says the work
// is DONE and drops the ptys outright (owner ruling 2026-09-07). A snoozed chat
// is coming back on a known clock, so its session is kept resumable.
//
// TIMER WAKES ARE DERIVED, NOT SCHEDULED. There is no timer, no sweep entry and
// no wake event: a row is snoozed while `snoozedUntil` is in the future, and
// stops being snoozed when it is not. The sidebar already re-renders on
// `useRelativeNow`'s tick, so the wake costs nothing and — the real prize —
// survives a restart, a window move and a machine asleep past the wake time
// with no recovery path to get wrong.
//
// This module offers the wake times and the words a sleeping row wears.
// Whether a row is asleep is the record rule in `shared/workspace-snooze.ts`,
// re-exported below, which main's rest sweep reads as well: the sidebar
// renders it, and main writes the fields.

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Wake hour for "This evening". */
const EVENING_HOUR = 18
/** Wake hour for the calendar presets ("Tomorrow", "Next week"). */
const MORNING_HOUR = 9

export type SnoozePresetId = 'hour' | 'three-hours' | 'evening' | 'tomorrow' | 'next-week'

export type SnoozePreset = {
  readonly id: SnoozePresetId
  /** The choice, as the person makes it: "In 1 hour", "Tomorrow". */
  readonly label: string
  /**
   * The wake time the choice lands on, for the menu row's second column. It
   * COMPLEMENTS the label rather than repeating it — "Tomorrow" pairs with
   * "9:00 am", not with "tomorrow 9:00 am" — so the person can see that
   * "Tomorrow" means the morning and not this time tomorrow.
   */
  readonly whenLabel: string
  readonly wakeAt: number
}

function timeOfDayLabel(at: number): string {
  return formatTimeOfDay(at)
}

function weekdayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short' })
}

/** The given clock hour on `base`'s own calendar day, at the top of the hour. */
function atHour(base: number, hour: number): number {
  const date = new Date(base)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

// Calendar-day arithmetic, NOT `+ n * DAY_MS`. A fixed millisecond offset lands
// on the wrong local day across a DST transition — a spring-forward day is 23
// hours, so 23:30 + 24h skips the whole next day — and "Tomorrow" landing on
// the day after tomorrow twice a year is the kind of bug nobody reports and
// everybody distrusts the feature for.
function addDays(base: number, days: number): number {
  const date = new Date(base)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/**
 * The wake times on offer, resolved against a clock so the labels say when each
 * one actually lands.
 *
 * Two presets are relative ("in an hour") and the rest are calendar points, and
 * a calendar point only earns a row while it is still in front of you:
 *
 *  - "This evening" appears only while evening is more than an hour away.
 *    Offering it at 17:55 is offering a five-minute snooze under a name that
 *    promises the rest of the afternoon.
 *  - "Next week" collapses into "Tomorrow" when they are the same instant,
 *    which is every Sunday. Two rows, one wake time, is a menu that looks like
 *    it is offering a choice it is not.
 */
export function resolveSnoozePresets(now: number): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = [
    {
      id: 'hour',
      label: 'In 1 hour',
      whenLabel: timeOfDayLabel(now + HOUR_MS),
      wakeAt: now + HOUR_MS,
    },
    {
      id: 'three-hours',
      label: 'In 3 hours',
      whenLabel: timeOfDayLabel(now + 3 * HOUR_MS),
      wakeAt: now + 3 * HOUR_MS,
    },
  ]

  const evening = atHour(now, EVENING_HOUR)
  if (evening - now > HOUR_MS) {
    presets.push({
      id: 'evening',
      label: 'This evening',
      whenLabel: timeOfDayLabel(evening),
      wakeAt: evening,
    })
  }

  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR)
  presets.push({
    id: 'tomorrow',
    label: 'Tomorrow',
    whenLabel: timeOfDayLabel(tomorrow),
    wakeAt: tomorrow,
  })

  // The coming Monday. `|| 7` keeps Monday itself meaning "a week from now"
  // rather than "today".
  const daysUntilMonday = (1 - new Date(now).getDay() + 7) % 7 || 7
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR)
  if (nextWeek !== tomorrow) {
    presets.push({
      id: 'next-week',
      label: 'Next week',
      whenLabel: `${weekdayLabel(nextWeek)} ${timeOfDayLabel(nextWeek)}`,
      wakeAt: nextWeek,
    })
  }

  return presets
}

/**
 * The countdown a sleeping row wears: "42m", "2h", "3d". Minutes round UP so a
 * row that is still hidden never reads "0m" — a zero on a row you cannot see is
 * the interface calling itself broken.
 *
 * Deliberately not `formatRelativeMs`: that one floors, blanks under a minute
 * and reads backwards (how long ago), and all three are wrong for a countdown.
 */
export function snoozeWakeLabel(wakeAt: number, now: number): string {
  const remaining = wakeAt - now
  if (remaining <= 0) return 'now'
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`
  return `${Math.ceil(remaining / DAY_MS)}d`
}

// The record rules (is a row asleep, when did it wake, the patch that puts it
// to sleep) are shared with main, which decides a chat's rest against them.
export {
  canSnoozeWorkspace,
  hasSnooze,
  isSnoozeUnexpired,
  isSnoozedWorkspace,
  snoozeWorkspacePatch,
  wakeSnoozedWorkspacePatch,
  workspaceWokeAt,
} from '../../../shared/workspace-snooze'

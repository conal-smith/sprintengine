// The schedule picker's model: the four tabs (Daily, Weekly, Monthly, Cron)
// and the cron line they add up to. Cron is the one stored form; the tabs are a
// way of writing the everyday shapes of it without typing it. A cron the tabs
// can say opens on its tab, with its days and times in the controls; anything
// else opens on Cron, as written.

import { parseCronSchedule, type CronLine } from '../../shared/cron/cron'

export type ScheduleTab = 'daily' | 'weekly' | 'monthly' | 'cron'

/** Minutes past midnight. */
export type ScheduleTime = number

export type ScheduleEditorState = {
  tab: ScheduleTab
  /** Weekly: 0-6, Sunday first. */
  weekdays: number[]
  /** Monthly: 1-31. */
  monthDays: number[]
  times: ScheduleTime[]
  /** The Cron tab's own text, kept as typed so a half-typed line is not lost to a tab switch. */
  cronText: string
}

const DEFAULT_TIME: ScheduleTime = 9 * 60

export function editorStateFromCron(cron: string): ScheduleEditorState {
  const fallback: ScheduleEditorState = {
    tab: 'cron',
    weekdays: [1, 2, 3, 4, 5],
    monthDays: [1],
    times: [DEFAULT_TIME],
    cronText: cron,
  }
  const parsed = parseCronSchedule(cron)
  if (!parsed.ok) return fallback
  const lines = parsed.schedule.lines
  const first = lines[0] as CronLine
  // Every line must run on the same days at fixed clock times.
  const sameDays = lines.every(
    (line) =>
      line.dayOfMonthOpen === first.dayOfMonthOpen &&
      line.dayOfWeekOpen === first.dayOfWeekOpen &&
      line.daysOfMonth.join() === first.daysOfMonth.join() &&
      line.daysOfWeek.join() === first.daysOfWeek.join() &&
      line.months.length === 12,
  )
  const fixedTimes = lines.every((line) => line.minutes.length === 1 && line.hours.length <= 6)
  if (!sameDays || !fixedTimes) return fallback
  const times = [...new Set(lines.flatMap((line) => line.hours.map((hour) => hour * 60 + (line.minutes[0] as number))))]
  times.sort((a, b) => a - b)
  if (first.dayOfMonthOpen && first.dayOfWeekOpen) return { ...fallback, tab: 'daily', times }
  if (first.dayOfMonthOpen) return { ...fallback, tab: 'weekly', weekdays: first.daysOfWeek, times }
  if (first.dayOfWeekOpen) return { ...fallback, tab: 'monthly', monthDays: first.daysOfMonth, times }
  return fallback
}

/** The cron line the tab in front of the person adds up to; null when it cannot say one yet. */
export function cronFromEditorState(state: ScheduleEditorState): string | null {
  if (state.tab === 'cron') return state.cronText.trim() || null
  const times = [...new Set(state.times)].sort((a, b) => a - b)
  if (times.length === 0) return null
  let days: string
  if (state.tab === 'daily') days = '* * *'
  else if (state.tab === 'weekly') {
    if (state.weekdays.length === 0) return null
    days = `* * ${[...state.weekdays].sort((a, b) => a - b).join(',')}`
  } else {
    if (state.monthDays.length === 0) return null
    days = `${[...state.monthDays].sort((a, b) => a - b).join(',')} * *`
  }
  // One expression per minute: 9:00 and 13:00 share one, 9:00 and 13:30 need two.
  const hoursByMinute = new Map<number, number[]>()
  for (const time of times) {
    const minute = time % 60
    hoursByMinute.set(minute, [...(hoursByMinute.get(minute) ?? []), Math.floor(time / 60)])
  }
  return [...hoursByMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([minute, hours]) => `${minute} ${hours.join(',')} ${days}`)
    .join('; ')
}

/** Switching tabs carries the times across, and the Cron tab starts from what the last tab said. */
export function switchTab(state: ScheduleEditorState, tab: ScheduleTab): ScheduleEditorState {
  if (tab === state.tab) return state
  if (tab === 'cron') return { ...state, tab, cronText: cronFromEditorState(state) ?? state.cronText }
  if (state.tab === 'cron') {
    const read = editorStateFromCron(state.cronText)
    return { ...state, ...(read.tab === 'cron' ? {} : { times: read.times }), tab }
  }
  return { ...state, tab }
}

/** "9:00 AM", for a time field, the words beside it and the run times under it. */
export function formatScheduleTime(time: ScheduleTime): { clock: string; meridiem: 'AM' | 'PM' } {
  const hour = Math.floor(time / 60)
  const minute = time % 60
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return { clock: `${twelve}:${String(minute).padStart(2, '0')}`, meridiem: hour < 12 ? 'AM' : 'PM' }
}

/**
 * A typed time back to minutes past midnight: "9", "9:30", "9pm", "21:00",
 * "9:30 p". With no AM/PM, `meridiem` decides for 1-12 and 13-23 is itself.
 * Null when it is not a time.
 */
export function parseScheduleTime(text: string, meridiem: 'AM' | 'PM'): ScheduleTime | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(a|am|p|pm)?\s*$/iu.exec(text)
  if (!match) return null
  let hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  if (minute > 59 || hour > 23) return null
  const typed = match[3]?.toLowerCase()
  const side = typed ? (typed.startsWith('p') ? 'PM' : 'AM') : hour > 12 || hour === 0 ? null : meridiem
  if (side !== null) {
    if (hour > 12 || hour === 0) return null
    hour = (hour % 12) + (side === 'PM' ? 12 : 0)
  }
  return hour * 60 + minute
}

function clockText(time: ScheduleTime): string {
  const { clock, meridiem } = formatScheduleTime(time)
  return `${clock} ${meridiem}`
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A run time as the schedule readout says it, in the schedule's own zone:
 * "Today 1:00 PM", "Tomorrow 9:00 AM", "Sun 4 Oct 9:00 PM". Each after the
 * first drops what it shares with the one before: "Sun 4 Oct 9:00 PM · Sun 11
 * Oct". The clock is the one the time fields and the schedule's words use, so
 * the chip reading "9:00 AM" is not followed by a next run at "09:00".
 */
export function formatRunTimes(instants: number[], timeZone: string, now: number): string[] {
  const parts = (instant: number) => {
    const read = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant))
    const get = (type: Intl.DateTimeFormatPartTypes) => read.find((part) => part.type === type)?.value ?? ''
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      weekday: WEEKDAY_SHORT.indexOf(get('weekday')),
      day: Number(get('day')),
      month: Number(get('month')),
      clock: clockText(Number(get('hour')) * 60 + Number(get('minute'))),
    }
  }
  const today = parts(now).date
  const tomorrow = parts(now + 24 * 60 * 60 * 1000).date
  let previous: { date: string; clock: string } | null = null
  return instants.map((instant) => {
    const at = parts(instant)
    const before = previous
    previous = { date: at.date, clock: at.clock }
    // What the one before already said is not said again: the same day drops
    // the date, and the same time on another day drops the time.
    if (before?.date === at.date) return at.clock
    const clock = before?.clock === at.clock ? '' : ` ${at.clock}`
    if (at.date === today) return `Today${clock}`
    if (at.date === tomorrow) return `Tomorrow${clock}`
    return `${WEEKDAY_SHORT[at.weekday] ?? ''} ${at.day} ${MONTH_SHORT[at.month - 1] ?? ''}${clock}`
  })
}

/** The zone this computer's clock is in, which is the zone a new schedule is written in. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

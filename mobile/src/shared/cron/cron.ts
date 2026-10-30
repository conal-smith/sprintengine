// Cron, read three ways from one parse: whether it is valid (and which field is
// not, so the schedule picker can mark that field), when it runs next in a given
// timezone, and what it says in words ("Every Sunday at 9:00 PM"). The engine and
// the picker both read it from here, so the next run a person is shown is the
// run the engine will fire.
//
// Five fields — minute hour day-of-month month day-of-week — with `*`, lists,
// ranges and steps, three-letter month and day names, 7 as a second Sunday, and
// the @hourly/@daily/@weekly/@monthly/@yearly shorthands. A schedule may hold
// several expressions separated by `;`, which is how "daily at 9:00 AM and
// 1:30 PM" is written: two times that share no minute cannot be one cron line.
//
// Day-of-month and day-of-week follow the classic rule: when both are
// restricted, a day matches if EITHER does.
//
// Pure: no clock, no store. Wall-clock time in a zone comes from `Intl`, which
// both processes have.

export const CRON_FIELD_NAMES = ['minute', 'hour', 'day', 'month', 'weekday'] as const
export type CronFieldName = (typeof CRON_FIELD_NAMES)[number]

export type CronLine = {
  /** The expression as written, trimmed. */
  source: string
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  /** 0-6, Sunday first; a written 7 is folded onto 0. */
  daysOfWeek: number[]
  /** Whether each day field was left open (`*`), which decides how the two combine. */
  dayOfMonthOpen: boolean
  dayOfWeekOpen: boolean
  /**
   * Whether the hour field repeats (`*` or a step): such a line runs on the
   * clock rather than at a time of day, so a wall-clock time a DST change
   * repeats runs at both of its instants.
   */
  hourRepeats: boolean
}

export type CronSchedule = { lines: CronLine[] }

export type CronParseResult =
  | { ok: true; schedule: CronSchedule }
  | {
      ok: false
      error: string
      /** The field that is wrong, when one is; absent for a wrong field count or an empty schedule. */
      field?: CronFieldName
    }

type FieldSpec = { name: CronFieldName; min: number; max: number; names?: readonly string[] }

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  // Month names map to 1-12, so their table is offset by one.
  { name: 'month', min: 1, max: 12, names: ['', ...MONTH_NAMES] },
  { name: 'weekday', min: 0, max: 7, names: DAY_NAMES },
]

const SHORTHANDS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const FIELD_LABEL: Record<CronFieldName, string> = {
  minute: 'Minute',
  hour: 'Hour',
  day: 'Day of the month',
  month: 'Month',
  weekday: 'Weekday',
}

const FIELD_RANGE_HINT: Record<CronFieldName, string> = {
  minute: '0–59',
  hour: '0–23',
  day: '1–31',
  month: '1–12 or jan–dec',
  weekday: '0–6 or sun–sat',
}

export function parseCronSchedule(text: string): CronParseResult {
  const expressions = text
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (expressions.length === 0) return { ok: false, error: 'Type a schedule, like 0 9 * * 1-5.' }
  const lines: CronLine[] = []
  for (const expression of expressions) {
    const parsed = parseCronLine(expression)
    if (!parsed.ok) return parsed
    lines.push(parsed.line)
  }
  return { ok: true, schedule: { lines } }
}

function parseCronLine(
  expression: string,
): { ok: true; line: CronLine } | { ok: false; error: string; field?: CronFieldName } {
  const expanded = SHORTHANDS[expression.toLowerCase()] ?? expression
  if (expanded.startsWith('@')) return { ok: false, error: `${expression} isn’t a shorthand cron knows.` }
  const parts = expanded.split(/\s+/u)
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `A schedule has five parts — minute hour day month weekday — and this has ${parts.length}.`,
    }
  }
  const values: number[][] = []
  for (let index = 0; index < 5; index += 1) {
    const spec = FIELD_SPECS[index] as FieldSpec
    const field = parseField(parts[index] as string, spec)
    if (!field.ok) return { ok: false, error: field.error, field: spec.name }
    values.push(field.values)
  }
  const daysOfWeek = [...new Set((values[4] as number[]).map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b)
  return {
    ok: true,
    line: {
      source: expression,
      minutes: values[0] as number[],
      hours: values[1] as number[],
      daysOfMonth: values[2] as number[],
      months: values[3] as number[],
      daysOfWeek,
      dayOfMonthOpen: isOpenField(parts[2] as string),
      dayOfWeekOpen: isOpenField(parts[4] as string),
      hourRepeats: /[*?/]/u.test(parts[1] as string),
    },
  }
}

// `*` and `?` leave a day field open; `*/1` does too, since it names every day.
function isOpenField(raw: string): boolean {
  return raw === '*' || raw === '?' || raw === '*/1'
}

function parseField(raw: string, spec: FieldSpec): { ok: true; values: number[] } | { ok: false; error: string } {
  const values = new Set<number>()
  for (const item of raw.split(',')) {
    if (item.length === 0) return { ok: false, error: `${FIELD_LABEL[spec.name]} has an empty entry.` }
    const [rangePart, stepPart, extra] = item.split('/')
    if (extra !== undefined) return { ok: false, error: `${FIELD_LABEL[spec.name]} “${item}” has two steps.` }
    let step = 1
    if (stepPart !== undefined) {
      if (!/^\d+$/u.test(stepPart) || Number(stepPart) === 0) {
        return { ok: false, error: `${FIELD_LABEL[spec.name]} step “/${stepPart}” must be a whole number above 0.` }
      }
      step = Number(stepPart)
    }
    let start: number
    let end: number
    if (rangePart === '*' || rangePart === '?') {
      start = spec.min
      end = spec.name === 'weekday' ? 6 : spec.max
    } else {
      const [fromRaw, toRaw, over] = (rangePart ?? '').split('-')
      if (over !== undefined)
        return { ok: false, error: `${FIELD_LABEL[spec.name]} “${item}” isn’t a range cron reads.` }
      const from = fieldValue(fromRaw ?? '', spec)
      if (from === null) return outOfRange(fromRaw ?? '', spec)
      start = from
      if (toRaw !== undefined) {
        const to = fieldValue(toRaw, spec)
        if (to === null) return outOfRange(toRaw, spec)
        if (to < from) {
          return { ok: false, error: `${FIELD_LABEL[spec.name]} range ${fromRaw}-${toRaw} runs backwards.` }
        }
        end = to
      } else {
        // `5/15` means from 5 to the end of the field in steps of 15.
        end = stepPart !== undefined ? spec.max : from
      }
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return { ok: true, values: [...values].sort((a, b) => a - b) }
}

function fieldValue(raw: string, spec: FieldSpec): number | null {
  const lowered = raw.toLowerCase()
  if (spec.names) {
    const named = spec.names.indexOf(lowered)
    if (named > 0 || (named === 0 && lowered.length > 0)) return named
  }
  if (!/^\d+$/u.test(raw)) return null
  const value = Number(raw)
  return value >= spec.min && value <= spec.max ? value : null
}

function outOfRange(raw: string, spec: FieldSpec): { ok: false; error: string } {
  const label = FIELD_LABEL[spec.name]
  if (/^\d+$/u.test(raw)) {
    return { ok: false, error: `${label} ${raw} doesn’t exist — use ${FIELD_RANGE_HINT[spec.name]}.` }
  }
  return { ok: false, error: `${label} “${raw}” isn’t something cron reads — use ${FIELD_RANGE_HINT[spec.name]}.` }
}

// ── When it runs ─────────────────────────────────────────────────────────────

type LocalDate = { year: number; month: number; day: number }
type LocalDateTime = LocalDate & { hour: number; minute: number }

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
// Far enough to find the next Feb 29 of a leap-day schedule; a schedule that
// matches no day at all (Feb 30) runs out here rather than looping forever.
const SEARCH_DAYS = 366 * 8 + 2
const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/**
 * The next `count` instants (ms) strictly after `after` at which the schedule
 * runs, wall-clock in `timeZone`. Fewer than `count` only for a schedule that
 * names a day no calendar has. A wall-clock time a DST change skips runs at the
 * first minute after the gap. One a DST change repeats runs once, at the first
 * of the two, on a line with fixed hours ("daily at 1:30 AM" is once a day);
 * on a line whose hour field repeats it runs at both, so an hourly schedule
 * keeps running through the repeated hour instead of going quiet for it.
 */
export function nextCronRuns(schedule: CronSchedule, timeZone: string, after: number, count: number): number[] {
  const runs: number[] = []
  let cursor = after
  while (runs.length < count) {
    const next = nextCronRun(schedule, timeZone, cursor)
    if (next === null) break
    runs.push(next)
    cursor = next
  }
  return runs
}

export function nextCronRun(schedule: CronSchedule, timeZone: string, after: number): number | null {
  let best: number | null = null
  for (const line of schedule.lines) {
    const next = nextLineRun(line, timeZone, after)
    if (next !== null && (best === null || next < best)) best = next
  }
  return best
}

function nextLineRun(line: CronLine, timeZone: string, after: number): number | null {
  const start = localDateTimeAt(after, timeZone)
  const startMinute = start.hour * 60 + start.minute
  // A repeated hour's second pass reads as an earlier wall-clock time than the
  // first pass's end, so a repeating line looks back the hour a change moves.
  const lookBack = line.hourRepeats ? 60 : 0
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const date = addDays(start, offset)
    if (!lineMatchesDate(line, date)) continue
    let best: number | null = null
    for (const hour of line.hours) {
      for (const minute of line.minutes) {
        // Before the day's start minute there is nothing to find on day 0; a
        // cheap local comparison skips resolving instants that cannot win.
        if (offset === 0 && hour * 60 + minute < startMinute - lookBack) continue
        const instants = instantsForLocal({ ...date, hour, minute }, timeZone)
        const earliest = instants[0]
        if (earliest === undefined) continue
        // A time's first instant only grows with the wall-clock, so once one
        // is past the best found nothing later on the day can beat it.
        if (best !== null && earliest >= best) return best
        for (const instant of line.hourRepeats ? instants : [earliest]) {
          if (instant > after && (best === null || instant < best)) best = instant
        }
        if (best !== null && !line.hourRepeats) return best
      }
    }
    if (best !== null) return best
  }
  return null
}

function lineMatchesDate(line: CronLine, date: LocalDate): boolean {
  if (!line.months.includes(date.month)) return false
  const daysInMonth = new Date(Date.UTC(date.year, date.month, 0)).getUTCDate()
  if (date.day > daysInMonth) return false
  const domMatch = line.daysOfMonth.includes(date.day)
  const dowMatch = line.daysOfWeek.includes(weekdayOf(date))
  if (line.dayOfMonthOpen && line.dayOfWeekOpen) return true
  if (line.dayOfMonthOpen) return dowMatch
  if (line.dayOfWeekOpen) return domMatch
  return domMatch || dowMatch
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

function localDateTimeAt(instant: number, timeZone: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') }
}

function asUtc(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
}

// The zone's offset at an instant, in ms, to the minute.
function offsetAt(instant: number, timeZone: string): number {
  const floored = Math.floor(instant / MINUTE_MS) * MINUTE_MS
  return asUtc(localDateTimeAt(floored, timeZone)) - floored
}

/**
 * The instants a wall-clock time names in a zone, earliest first. The zone's
 * offsets a day either side of it reach past any DST change near it, so both
 * instants of a repeated time are found whichever side of UTC the zone is on;
 * a skipped time answers with the first instant after the gap.
 */
function instantsForLocal(target: LocalDateTime, timeZone: string): number[] {
  const wall = asUtc(target)
  // Probing only near `wall` read as UTC lands after the change in a zone
  // east of UTC, so its earlier instant (Berlin's first 02:30) was never tried.
  const offsets = new Set([DAY_MS, 0, -DAY_MS].map((shift) => offsetAt(wall + shift, timeZone)))
  const candidates = [...offsets].map((offset) => wall - offset)
  const matches = candidates.filter((instant) => asUtc(localDateTimeAt(instant, timeZone)) === wall)
  if (matches.length > 0) return matches.sort((a, b) => a - b)
  // A gap: the wall-clock time never happens. Walk to the first minute whose
  // wall-clock is past it — the gap is an hour or less, so this is short.
  let instant = Math.min(...candidates)
  for (let step = 0; step < 24 * 60; step += 1) {
    if (asUtc(localDateTimeAt(instant, timeZone)) > wall) return [instant]
    instant += MINUTE_MS
  }
  return []
}

function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

// ── What it says ────────────────────────────────────────────────────────────

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_LONG = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * The schedule in words: "Every Sunday at 9:00 PM", "Daily at 9:00 AM and
 * 1:00 PM", "Weekdays at 9:00 AM", "Every 30 minutes, 8:00 AM–6:30 PM,
 * weekdays", "On the 1st of every month at 7:00 AM". Always a sentence that is
 * true of the schedule — a shape with no short phrasing is said field by field
 * rather than approximated.
 */
export function describeCronSchedule(schedule: CronSchedule): string {
  // Lines that run on the same days read as one sentence with every time in it.
  const groups: { days: string; lines: CronLine[] }[] = []
  for (const line of schedule.lines) {
    const days = dayKey(line)
    const group = groups.find((entry) => entry.days === days)
    if (group) group.lines.push(line)
    else groups.push({ days, lines: [line] })
  }
  return groups.map((group) => describeGroup(group.lines)).join('; ')
}

function dayKey(line: CronLine): string {
  return [
    line.dayOfMonthOpen ? '*' : line.daysOfMonth.join(','),
    line.months.join(','),
    line.dayOfWeekOpen ? '*' : line.daysOfWeek.join(','),
  ].join('|')
}

function describeGroup(lines: CronLine[]): string {
  const first = lines[0] as CronLine
  const days = describeDays(first)
  // A repeat reads better than its times listed out ("Every 6 hours", not four
  // clock times), and can only be said of a single line.
  const repeat = lines.length === 1 ? repeatingTimeWords(first) : null
  if (repeat) return days.everyDay ? repeat : `${repeat}, ${days.phrase}`
  const perLine = lines.map(explicitTimes)
  if (perLine.every((times): times is number[] => times !== null)) {
    const sorted = [...new Set(perLine.flat())].sort((a, b) => a - b)
    return `${days.lead} at ${listWords(sorted.map(clockWords))}`
  }
  return lines.map((line) => `${describeDays(line).lead} ${literalTimeWords(line)}`).join('; ')
}

type DayWords = { everyDay: boolean; phrase: string; lead: string }

function describeDays(line: CronLine): DayWords {
  const monthPhrase =
    line.months.length === 12 ? '' : ` in ${listWords(line.months.map((m) => MONTH_LONG[m] as string))}`
  const weekdayPhrase = weekdayWords(line.daysOfWeek)
  const domPhrase = `the ${listWords(line.daysOfMonth.map(ordinal))}`

  if (line.dayOfMonthOpen && line.dayOfWeekOpen) {
    if (monthPhrase) return { everyDay: false, phrase: `every day${monthPhrase}`, lead: `Every day${monthPhrase}` }
    return { everyDay: true, phrase: 'every day', lead: 'Daily' }
  }
  if (line.dayOfMonthOpen) {
    return {
      everyDay: false,
      phrase: `${weekdayPhrase.inline}${monthPhrase}`,
      lead: `${capitalise(weekdayPhrase.lead)}${monthPhrase}`,
    }
  }
  const monthly = monthPhrase ? `of ${listWords(line.months.map((m) => MONTH_LONG[m] as string))}` : 'of every month'
  if (line.dayOfWeekOpen) {
    return { everyDay: false, phrase: `on ${domPhrase} ${monthly}`, lead: `On ${domPhrase} ${monthly}` }
  }
  return {
    everyDay: false,
    phrase: `on ${domPhrase} ${monthly} and ${weekdayPhrase.inline}`,
    lead: `On ${domPhrase} ${monthly} and ${weekdayPhrase.inline}`,
  }
}

// Weekday sets people have words for, then the plain list.
function weekdayWords(days: number[]): { lead: string; inline: string } {
  const key = days.join(',')
  if (key === '1,2,3,4,5') return { lead: 'weekdays', inline: 'on weekdays' }
  if (key === '0,6') return { lead: 'weekends', inline: 'on weekends' }
  if (days.length === 7) return { lead: 'daily', inline: 'every day' }
  const names = listWords(days.map((day) => WEEKDAY_LONG[day] as string))
  return { lead: `every ${names}`, inline: `every ${names}` }
}

// Every (hour, minute) pair as minutes-past-midnight, when the pairs are few
// enough to name — otherwise null, and the time is said as a repeat.
const MAX_NAMED_TIMES = 6

function explicitTimes(line: CronLine): number[] | null {
  if (line.hours.length * line.minutes.length > MAX_NAMED_TIMES) return null
  return line.hours.flatMap((hour) => line.minutes.map((minute) => hour * 60 + minute))
}

function repeatingTimeWords(line: CronLine): string | null {
  const minuteStep = line.minutes.length === 60 ? 1 : arithmeticStep(line.minutes, 60)
  const hoursAll = line.hours.length === 24
  // Every n minutes, all day or within a run of hours.
  if (minuteStep !== null && line.minutes[0] === 0) {
    const every = minuteStep === 1 ? 'Every minute' : `Every ${minuteStep} minutes`
    if (hoursAll) return every
    if (isContiguous(line.hours)) {
      const from = (line.hours[0] as number) * 60
      const to = (line.hours[line.hours.length - 1] as number) * 60 + (line.minutes[line.minutes.length - 1] as number)
      return `${every}, ${clockWords(from)}–${clockWords(to)}`
    }
  }
  // Every n hours at a fixed minute.
  if (line.minutes.length === 1) {
    const minute = line.minutes[0] as number
    const past = minute === 0 ? '' : ` at :${pad(minute)}`
    if (hoursAll) return `Every hour${past}`
    const hourStep = arithmeticStep(line.hours, 24)
    if (hourStep !== null && line.hours[0] === 0) return `Every ${hourStep} hours${past}`
  }
  return null
}

// The step of a list that is 0, n, 2n… up to its field's end, or null.
function arithmeticStep(values: number[], size: number): number | null {
  if (values.length < 2) return null
  const step = (values[1] as number) - (values[0] as number)
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) - (values[index - 1] as number) !== step) return null
  }
  return (values[values.length - 1] as number) + step >= size ? step : null
}

function isContiguous(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value === (values[index - 1] as number) + 1)
}

// The field-by-field fallback: "at minutes 5, 10 and 40 past 9 AM and 5 PM".
function literalTimeWords(line: CronLine): string {
  const minutes =
    line.minutes.length === 60
      ? 'every minute'
      : `at ${line.minutes.length === 1 ? 'minute' : 'minutes'} ${listWords(line.minutes.map(String))}`
  const hours = line.hours.length === 24 ? 'of every hour' : `past ${listWords(line.hours.map(hourWords))}`
  return `${minutes} ${hours}`
}

function hourWords(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`
}

function clockWords(minutesPastMidnight: number): string {
  const hour = Math.floor(minutesPastMidnight / 60)
  const minute = minutesPastMidnight % 60
  const suffix = hour < 12 ? 'AM' : 'PM'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:${pad(minute)} ${suffix}`
}

function ordinal(value: number): string {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  switch (value % 10) {
    case 1:
      return `${value}st`
    case 2:
      return `${value}nd`
    case 3:
      return `${value}rd`
    default:
      return `${value}th`
  }
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

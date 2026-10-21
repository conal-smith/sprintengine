import { useEffect, useRef } from 'react'
import { relativeNowClocks } from '../../../hooks/useRelativeNow'
import { inHiddenRegion, observeLiveVisibility } from './liveVisibility'
import { clockFormatter } from '../../../utils/clockFormat'

// Seconds since a step started, ticking once a second only while the row is on
// screen in a visible window. It writes the text node directly so a tick never
// re-renders the transcript.
//
// Every counter rides the window's one shared 1 s clock (useRelativeNow's)
// rather than an interval of its own: a fan-out of agents, their running
// steps and the working line is one wakeup a second, not one per row. The
// clock stops when nothing subscribes and while the window is hidden. The
// intersection observer cannot see `visibility: hidden`, so a counter in a
// warm workspace layer (or a cold or inert one) stays subscribed but skips
// its write; it is right again within a second of being shown.
export function LiveElapsed({ startedAt }: { startedAt: number }) {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const initial = formatElapsedMs(Date.now() - startedAt)
  useEffect(() => {
    const element = textRef.current
    if (!element) return
    const update = (now: number) => {
      if (inHiddenRegion(element)) return
      const text = formatElapsedMs(now - startedAt)
      if (element.textContent !== text) element.textContent = text
    }
    let unsubscribe: (() => void) | undefined
    const stop = observeLiveVisibility(element, (visible) => {
      unsubscribe?.()
      unsubscribe = undefined
      if (!visible) return
      update(Date.now())
      unsubscribe = relativeNowClocks().subscribe(1000, update)
    })
    return () => {
      stop()
      unsubscribe?.()
    }
  }, [startedAt])
  return <span ref={textRef}>{initial}</span>
}

export function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  // The step rows' own clock (`formatStepDuration`) moves up to hours here too.
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainingSeconds}s`
}

// Each formatter is built once: `toLocale*String` with options builds a fresh
// `Intl.DateTimeFormat` (locale data and all) on every call, and a transcript
// stamps every message and step with one. The two that write a clock time are
// the app clock's (`clockFormatter`), built once per Clock setting.
const CLOCK_TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
const WEEKDAY = new Intl.DateTimeFormat([], { weekday: 'short' })
const DAY_THIS_YEAR = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' })
const DAY_OTHER_YEAR = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' })

export function formatClockTime(timestamp: number): string {
  return clockFormatter(CLOCK_TIME).format(timestamp)
}

const DAY_MS = 24 * 60 * 60 * 1000

// Calendar days between two instants in local time. Rounded, because a day
// that crosses a daylight-saving change is 23 or 25 hours long.
function calendarDaysBetween(earlier: number, later: number): number {
  const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0)
  return Math.round((midnight(later) - midnight(earlier)) / DAY_MS)
}

// When a message or step happened, worded by how long ago the day was: the
// clock alone today, "Yesterday" and then the weekday within the week, and the
// date past that (with the year once it is not this one). A time ahead of
// `now` (another machine's clock) reads as its own date unless it is today.
export function formatMessageTime(timestamp: number, now: number = Date.now()): string {
  const clock = formatClockTime(timestamp)
  const days = calendarDaysBetween(timestamp, now)
  if (days === 0) return clock
  if (days === 1) return `Yesterday ${clock}`
  if (days > 1 && days < 7) return `${WEEKDAY.format(timestamp)} ${clock}`
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear()
  return `${(sameYear ? DAY_THIS_YEAR : DAY_OTHER_YEAR).format(timestamp)}, ${clock}`
}

// The whole instant in the reader's own calendar and clock, for a tooltip:
// "Sunday, 28 September 2026 at 11:15:02" in en-GB, the local equivalent
// elsewhere. The visible stamp stays short; this is where the rest lives.
const MESSAGE_DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'medium' }

export function formatMessageDateTime(timestamp: number): string {
  return clockFormatter(MESSAGE_DATE_TIME).format(new Date(timestamp))
}

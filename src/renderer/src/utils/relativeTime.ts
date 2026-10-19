export function formatRelativeMs(ms: number | null | undefined, now: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  // Sub-minute recency stays visually blank. "Now" conflates active work with
  // something that merely became idle recently; live state has its own mark.
  if (minutes < 1) return ''
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

export function formatRelativeMsAgo(ms: number | null | undefined, now: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (Math.max(0, now - ms) < 60_000) return 'just now'
  const short = formatRelativeMs(ms, now)
  if (!short) return ''
  return `${short} ago`
}

// Spelled-out, direction-aware relative time ("in 2 minutes" / "2 hours ago"),
// backed by Intl.RelativeTimeFormat. Distinct from the terse formatters above:
// this one keeps both directions (the automations panel shows future next-run
// times) and reads as a sentence fragment. Kept here so all relative-time
// formatting lives in one module rather than being re-implemented per surface.
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function relativeFromNow(at: number, now: number): string {
  const deltaSec = Math.round((at - now) / 1000)
  if (Math.abs(deltaSec) < 60) return RELATIVE.format(deltaSec, 'second')
  // Each unit is chosen on the rounded count, so 59m50s reads "1 hour", not
  // "60 minutes", and 23h50m reads "tomorrow", not "in 24 hours".
  const minutes = Math.round(deltaSec / 60)
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute')
  const hours = Math.round(deltaSec / 3600)
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour')
  return RELATIVE.format(Math.round(deltaSec / 86400), 'day')
}

// Elapsed-since, for a duration that is genuinely in flight. Unlike
// formatRelativeMs — which blanks under a minute, because "now" conflates
// active work with something that merely became idle — a running turn's first
// seconds are the most interesting part of it, so this one counts them.
export function formatElapsedMs(since: number | null | undefined, now: number): string {
  if (typeof since !== 'number' || !Number.isFinite(since)) return ''
  const diff = Math.max(0, now - since)
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`
  return formatRelativeMs(since, now)
}

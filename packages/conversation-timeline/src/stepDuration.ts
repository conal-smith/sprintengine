// How long something in a turn took, on the one clock the transcript reads: a
// step's row, a lane's header, a stretch of reasoning, the turn's own fold and
// its meta line all word a duration the same way, so two figures side by side
// can be compared at a glance. Tenths under a second, whole seconds under a
// minute, then minutes and seconds, then hours, minutes and seconds — a
// seven-hour run reads "7h 0m 50s", not "420m 50s".
//
// Its own module because both the tool rows and the timeline rows that hold
// them need it, and the timeline already imports the rows.
export function formatStepDuration(ms: number): string {
  if (ms < 950) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  // Rounded once, before it is split: rounding the remainder alone turns
  // 1m 59.7s into "1m 60s".
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`
}

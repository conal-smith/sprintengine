// One formatter for every `+N −N` the app prints. A big diff read `+83065`,
// which is a number to count the digits of rather than read; grouped, it is
// `+83,065` at a glance. The person's own locale decides the separator, the
// way the app's other counts (tokens in the context ring, commits in the Git
// log) already read.
//
// Built once: a formatter is expensive to construct and the counts are drawn
// on every sidebar row and every changed file.
const DIFF_COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

/** A diff line (or file) count with digit grouping: 83065 → "83,065". */
export function formatDiffCount(count: number): string {
  return DIFF_COUNT_FORMAT.format(count)
}

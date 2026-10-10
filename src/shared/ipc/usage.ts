// The IPC contract for the usage dashboard: a window asks for a priced report
// over a window of time, and main reads it from every agent's session logs on
// this machine (src/main/usage). Asked for, never pushed: the dashboard asks
// again when it opens, changes its range, or is refreshed.
export const USAGE_REPORT_CHANNEL = 'usage:report'

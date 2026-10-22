import { useCallback, useEffect, useRef, useState } from 'react'

import type { UsagePeerMode, UsageReport, UsageReportRequest } from '../../../../shared/usage-report'
import { usageWindow, type UsageRange, type UsageWindow } from './usageDashboardModel'

// The dashboard's report for a range, asked of main when the range is shown
// and again on refresh. The last answer per range is kept for this session of
// the window, so reopening the dashboard or flipping back to a range draws at
// once and asks main again behind it; while an answer is on its way, the one
// on screen stays (drawn muted by the caller) rather than giving way to a
// skeleton.
//
// The machines paired over the tailnet never hold this machine's figures
// back: the first answer counts what each of them answered last, the second
// asks each of them now, and a third waits for those that said they were
// still reading their logs. `asking` is true while the second or third is on
// its way. A machine filter is answered from what was last heard, without
// asking the machines again.

type Answer = { report: UsageReport; window: UsageWindow }

const lastAnswers = new Map<string, Answer>()
const answerKey = (range: UsageRange, machine: string | null): string => `${range}\u0000${machine ?? ''}`

export type UsageReportState = {
  answer: Answer | null
  loading: boolean
  /** The paired machines are being asked; their figures may still change. */
  asking: boolean
  error: string | null
  refresh: () => void
}

type UsageApi = Partial<Pick<Window['api'], 'usageReport'>>

export function useUsageReport(
  range: UsageRange,
  /** One machine to count (`UsageReportMachine.id`), or null for every one. */
  machine: string | null = null,
  api: UsageApi | null = typeof window === 'undefined' ? null : window.api,
): UsageReportState {
  const [answer, setAnswer] = useState<Answer | null>(() => lastAnswers.get(answerKey(range, machine)) ?? null)
  const [loading, setLoading] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  // The range whose machines were last asked to the end, so a filter does not ask them again.
  const askedRange = useRef<UsageRange | null>(null)

  const ask = useCallback(
    (options: { refresh: boolean; peers: boolean }) => {
      const ticket = ++request.current
      setAsking(false)
      if (typeof api?.usageReport !== 'function') {
        setError('Usage is not available in this window.')
        return
      }
      const usageReport = api.usageReport
      const window = usageWindow(range, Date.now())
      const base: UsageReportRequest = {
        from: window.from,
        to: window.to,
        ...(machine ? { machines: [machine] } : {}),
      }
      const current = (): boolean => ticket === request.current
      const take = (report: UsageReport): void => {
        const next = { report, window }
        lastAnswers.set(answerKey(range, machine), next)
        setAnswer(next)
        setError(null)
      }
      const round = (peers: UsagePeerMode, refresh: boolean) =>
        usageReport({ ...base, peers, ...(refresh ? { refresh: true } : {}) })
      setLoading(true)
      void (async () => {
        try {
          const first = await round('cached', options.refresh)
          if (!current()) return
          setLoading(false)
          if (!first.ok) {
            setError(first.message)
            return
          }
          take(first.report)
          if (!options.peers || !first.report.machines.some((entry) => entry.status !== 'local')) return
          setAsking(true)
          const second = await round('ask', options.refresh)
          if (!current() || !second.ok) return
          take(second.report)
          askedRange.current = range
          if (!second.report.machines.some((entry) => entry.scanning)) return
          const third = await round('await', false)
          if (current() && third.ok) take(third.report)
        } catch (cause: unknown) {
          if (current()) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (current()) {
            setLoading(false)
            setAsking(false)
          }
        }
      })()
    },
    [api, range, machine],
  )

  // A new range asks every machine; a new machine filter only counts again.
  useEffect(() => {
    setAnswer((shown) => lastAnswers.get(answerKey(range, machine)) ?? shown)
    ask({ refresh: false, peers: askedRange.current !== range })
  }, [ask, range, machine])

  return {
    answer,
    loading,
    asking,
    error,
    refresh: useCallback(() => ask({ refresh: true, peers: true }), [ask]),
  }
}

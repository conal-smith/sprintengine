import { useCallback, useEffect, useRef, useState } from 'react'

import type { UsageReport } from '../../../../shared/usage-report'
import { usageWindow, type UsageRange, type UsageWindow } from './usageDashboardModel'

// The dashboard's report for a range, asked of main when the range is shown
// and again on refresh. The last answer per range is kept for this session of
// the window, so reopening the dashboard or flipping back to a range draws at
// once and asks main again behind it; while an answer is on its way, the one
// on screen stays (drawn muted by the caller) rather than giving way to a
// skeleton.

type Answer = { report: UsageReport; window: UsageWindow }

const lastAnswers = new Map<UsageRange, Answer>()

export type UsageReportState = {
  answer: Answer | null
  loading: boolean
  error: string | null
  refresh: () => void
}

type UsageApi = Partial<Pick<Window['api'], 'usageReport'>>

export function useUsageReport(
  range: UsageRange,
  api: UsageApi | null = typeof window === 'undefined' ? null : window.api,
): UsageReportState {
  const [answer, setAnswer] = useState<Answer | null>(() => lastAnswers.get(range) ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const ask = useCallback(
    (refresh: boolean) => {
      const ticket = ++request.current
      if (typeof api?.usageReport !== 'function') {
        setError('Usage is not available in this window.')
        return
      }
      const window = usageWindow(range, Date.now())
      setLoading(true)
      void api
        .usageReport({ from: window.from, to: window.to, ...(refresh ? { refresh: true } : {}) })
        .then((result) => {
          if (ticket !== request.current) return
          if (!result.ok) {
            setError(result.message)
            return
          }
          const next = { report: result.report, window }
          lastAnswers.set(range, next)
          setAnswer(next)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (ticket === request.current) setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (ticket === request.current) setLoading(false)
        })
    },
    [api, range],
  )

  useEffect(() => {
    setAnswer((shown) => lastAnswers.get(range) ?? shown)
    ask(false)
  }, [ask, range])

  return { answer, loading, error, refresh: useCallback(() => ask(true), [ask]) }
}

import React, { useId, useState, type JSX } from 'react'

import { usageAgentLabel, type UsageAgentId } from '../../../../shared/usage-report'
import { OVERLAY_SURFACE_CLASS } from '../ui/tokens'
import { monotonePath, niceScale, type UsageSeries, type UsageWindow } from './usageDashboardModel'
import { usageAgentColor } from './usageAgents'

// One area per agent, each measured from zero and drawn over the others rather
// than stacked: a stack makes every agent but the bottom one hard to read off
// the axis, and the question this chart answers is "when, and on what". The
// heaviest series is painted first so a small one is never buried under it.
//
// Hand-drawn SVG, no chart library: the plot stretches to its box
// (`preserveAspectRatio="none"`, strokes kept at 2px by `non-scaling-stroke`),
// and every word — axis ticks, period labels, the readout — is HTML beside
// it, so text never stretches with the plot.
//
// The readout lists every agent at the period under the pointer, so nobody
// has to land on a 2px line to read it. The arrow keys move it while the plot
// has focus; the breakdown table under the chart holds the same numbers for
// anyone who reads them there instead.

const WIDTH = 1000
const HEIGHT = 300
const TICKS = 2

export function UsageChart({
  title,
  series,
  window,
  formatValue,
  formatAxis = formatValue,
  formatPeriod,
  muted = false,
}: {
  title: string
  series: readonly UsageSeries[]
  window: UsageWindow
  formatValue: (value: number) => string
  formatAxis?: (value: number) => string
  formatPeriod: (start: number, unit: UsageWindow['unit']) => string
  /** Drawn faded while a new answer is on its way, so the frame holds still. */
  muted?: boolean
}): JSX.Element {
  const titleId = useId()
  const [active, setActive] = useState<number | null>(null)
  const count = window.periods.length
  const max = Math.max(0, ...series.flatMap((entry) => entry.values))
  const { top, step } = niceScale(max, TICKS)
  const x = (index: number): number => (count > 1 ? (index / (count - 1)) * WIDTH : WIDTH / 2)
  const y = (value: number): number => HEIGHT - (value / top) * HEIGHT
  const painted = [...series].filter((entry) => entry.total > 0).sort((a, b) => b.total - a.total)

  const pick = (event: React.PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width <= 0 || count === 0) return
    const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    setActive(Math.round(share * (count - 1)))
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (count === 0) return
    const last = count - 1
    const next =
      event.key === 'ArrowLeft'
        ? Math.max(0, (active ?? last) - 1)
        : event.key === 'ArrowRight'
          ? Math.min(last, (active ?? last) + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    setActive(next)
  }

  const ticks = Array.from({ length: TICKS + 1 }, (_, index) => top - index * step)
  const labelIndexes = count > 2 ? [0, Math.floor((count - 1) / 2), count - 1] : [...Array(count).keys()]
  const readout = active === null ? null : readoutAt(series, active)
  const left = active === null ? 0 : count > 1 ? (active / (count - 1)) * 100 : 50

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3" aria-labelledby={titleId}>
      <figcaption id={titleId} className="text-heading font-medium text-[color:var(--text-strong)]">
        {title}
      </figcaption>
      <div className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 ${muted ? 'opacity-50' : ''}`}>
        {/* The tick labels sit on their gridlines: the column is as tall as the plot. */}
        <div className="relative h-56 text-micro tabular-nums text-[color:var(--text-subtle)]" aria-hidden="true">
          {ticks.map((value, index) => (
            <span
              key={value}
              className="absolute right-0 -translate-y-1/2 whitespace-nowrap"
              style={{ top: `${(index / TICKS) * 100}%` }}
            >
              {formatAxis(value)}
            </span>
          ))}
          {/* Holds the column's width; the labels above are out of flow. */}
          <span className="invisible block whitespace-nowrap">{formatAxis(top)}</span>
        </div>
        <div
          className="relative h-56 rounded-sm focus-visible:focus-ring"
          tabIndex={0}
          role="group"
          aria-roledescription="chart"
          aria-label={`${title}. Use the arrow keys to read each ${window.unit === 'hour' ? 'hour' : 'day'}.`}
          onPointerMove={pick}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((current) => current ?? count - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
        >
          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {ticks.map((value) => (
              <line
                key={value}
                x1={0}
                x2={WIDTH}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--border-subtle)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {painted.map((entry) => {
              const line = monotonePath(entry.values.map((value, index) => [x(index), y(value)] as const))
              return (
                <path
                  key={`fill-${entry.agent}`}
                  d={`${line}L${x(count - 1)},${HEIGHT}L${x(0)},${HEIGHT}Z`}
                  fill={usageAgentColor(entry.agent)}
                  fillOpacity={0.12}
                />
              )
            })}
            {painted.map((entry) => (
              <path
                key={`line-${entry.agent}`}
                d={monotonePath(entry.values.map((value, index) => [x(index), y(value)] as const))}
                fill="none"
                stroke={usageAgentColor(entry.agent)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {active !== null ? (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-[color:var(--border-strong)]"
                style={{ left: `${left}%` }}
                aria-hidden="true"
              />
              <div
                role="status"
                className={`pointer-events-none absolute top-2 z-[var(--z-popover)] min-w-44 px-3 py-2 ${OVERLAY_SURFACE_CLASS}`}
                style={left > 60 ? { right: `calc(${100 - left}% + 12px)` } : { left: `calc(${left}% + 12px)` }}
              >
                <div className="mb-1.5 text-micro text-[color:var(--text-subtle)]">
                  {formatPeriod(window.periods[active]!, window.unit)}
                </div>
                {readout && readout.rows.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {readout.rows.map((row) => (
                      <div key={row.agent} className="flex items-center gap-2 text-meta">
                        <span
                          className="h-0.5 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: usageAgentColor(row.agent) }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-[color:var(--text-muted)]">
                          {usageAgentLabel(row.agent)}
                        </span>
                        <span className="tabular-nums font-medium text-[color:var(--text-strong)]">
                          {formatValue(row.value)}
                        </span>
                      </div>
                    ))}
                    {readout.rows.length > 1 ? (
                      <div className="mt-0.5 flex items-center gap-2 border-t border-[color:var(--border-subtle)] pt-1.5 text-meta">
                        <span className="flex-1 text-[color:var(--text-muted)]">Total</span>
                        <span className="tabular-nums font-medium text-[color:var(--text-strong)]">
                          {formatValue(readout.total)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-meta text-[color:var(--text-muted)]">No usage</div>
                )}
              </div>
            </>
          ) : null}
        </div>
        <div aria-hidden="true" />
        <div className="relative mt-2 h-4 text-micro text-[color:var(--text-subtle)]" aria-hidden="true">
          {labelIndexes.map((index) => (
            <span
              key={index}
              className={`absolute whitespace-nowrap ${
                index === 0 ? '' : index === count - 1 ? '-translate-x-full' : '-translate-x-1/2'
              }`}
              style={{ left: `${count > 1 ? (index / (count - 1)) * 100 : 50}%` }}
            >
              {formatPeriod(window.periods[index]!, window.unit)}
            </span>
          ))}
        </div>
      </div>
    </figure>
  )
}

function readoutAt(
  series: readonly UsageSeries[],
  index: number,
): { rows: Array<{ agent: UsageAgentId; value: number }>; total: number } {
  const rows = series
    .map((entry) => ({ agent: entry.agent, value: entry.values[index] ?? 0 }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
  return { rows, total: rows.reduce((sum, row) => sum + row.value, 0) }
}

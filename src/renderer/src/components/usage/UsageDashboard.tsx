import React, { useEffect, useId, useMemo, useState, type JSX } from 'react'

import {
  formatUsageShare,
  formatUsageTokens,
  formatUsageUsd,
  formatUsageUsdAxis,
  usageAgentLabel,
  usageTokenTotal,
  type UsageReport,
  type UsageReportMachine,
  type UsageReportModel,
} from '../../../../shared/usage-report'
import { GlobalSurfaceShell } from '../workspace/globalSurface/GlobalSurfaceShell'
import {
  EmptyState,
  IconButton,
  InlineNotice,
  MachineGlyph,
  OutlineButton,
  RefreshIcon,
  SegmentedControl,
  Select,
  Spinner,
  Tooltip,
} from '../ui'
import { Table } from '../ui/Table'
import { formatTimeOfDay } from '../../utils/clockFormat'
import { UsageChart } from './UsageChart'
import { UsageAgentKey } from './usageAgents'
import {
  USAGE_RANGES,
  usageHasPeers,
  usageHeadline,
  usageMachineLine,
  usagePeriodRows,
  usageSeries,
  usageTotalsRow,
  type UsageMetric,
  type UsageRange,
  type UsageView,
  type UsageWindow,
} from './usageDashboardModel'
import { UsageLimitsView } from './UsageLimitsView'
import { useUsageReport } from './useUsageReport'

// The usage dashboard (owner ruling 2026-10-10): what every agent CLI on this
// machine has spent, in money and in tokens, and the subscription limits the
// agents report. Machines paired over the tailnet add what they spent
// (2026-10-21), with a row each and a filter to one; the limits stay this
// machine's, since a subscription's limits are read where its agent runs. Opened from the chart glyph at the foot of the app rail, as a
// modal over the workspace like Settings: a look at the numbers and back to
// work, with nothing behind it torn down.
//
// Cost is an API estimate: what the tokens would have cost at list price. A
// subscription is billed by plan, so on one the figure says what the plan was
// worth, not what was charged. The view says so where the figure is.

const VIEWS: Array<{ value: UsageView; label: string }> = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'limits', label: 'Limits' },
]

// The choice of view and range outlives the dashboard for this session of
// the window: reopening it shows what was last looked at.
let lastView: UsageView = 'cost'
let lastRange: UsageRange = '30d'
let lastMachine: string | null = null

const ALL_MACHINES = 'all'

const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const WEEKDAY_MONTH_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

function formatPeriod(start: number, unit: UsageWindow['unit']): string {
  return unit === 'hour' ? formatTimeOfDay(start) : MONTH_DAY.format(start)
}

function formatValue(metric: UsageMetric): (value: number) => string {
  return metric === 'cost' ? formatUsageUsd : formatUsageTokens
}

export default function UsageDashboard(): JSX.Element {
  const [view, setView] = useState<UsageView>(lastView)
  const [range, setRange] = useState<UsageRange>(lastRange)
  const [machine, setMachine] = useState<string | null>(lastMachine)
  const state = useUsageReport(range, machine)
  const metric: UsageMetric = view === 'tokens' ? 'tokens' : 'cost'
  const report = state.answer?.report ?? null
  // A machine since forgotten is not a filter any more.
  useEffect(() => {
    if (machine && report && !report.machines.some((entry) => entry.id === machine)) {
      lastMachine = null
      setMachine(null)
    }
  }, [machine, report])

  const actions = (
    <>
      <SegmentedControl
        ariaLabel="Usage view"
        items={VIEWS}
        value={view}
        onChange={(next) => {
          lastView = next
          setView(next)
        }}
      />
      {/* Only with another machine to count; Limits are this machine's. */}
      {report && usageHasPeers(report) ? (
        <Select
          ariaLabel="Machine"
          size="md"
          items={[
            { value: ALL_MACHINES, label: 'All machines' },
            ...report.machines.map((entry) => ({
              value: entry.id,
              label: entry.status === 'local' ? `${entry.label} (this machine)` : entry.label,
            })),
          ]}
          disabled={view === 'limits'}
          value={machine ?? ALL_MACHINES}
          onChange={(next) => {
            const chosen = next === ALL_MACHINES ? null : next
            lastMachine = chosen
            setMachine(chosen)
          }}
        />
      ) : null}
      {/* Kept in place on Limits, so switching views never moves the bar. */}
      <SegmentedControl
        ariaLabel="Period"
        items={USAGE_RANGES.map((item) => ({ ...item, disabled: view === 'limits' }))}
        value={range}
        onChange={(next) => {
          lastRange = next
          setRange(next)
        }}
      />
      <Tooltip content="Read the logs again" placement="bottom">
        <IconButton size="md" aria-label="Refresh usage" busy={state.loading} onClick={state.refresh}>
          <RefreshIcon className="icon-md" />
        </IconButton>
      </Tooltip>
    </>
  )

  return (
    <GlobalSurfaceShell ariaLabel="Usage" bar={{ title: 'Usage', actions }}>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-8 py-6">
          {view === 'limits' ? (
            <UsageLimitsView />
          ) : (
            <UsageSpend
              metric={metric}
              answer={state.answer}
              loading={state.loading}
              asking={state.asking}
              filtered={machine !== null}
              error={state.error}
              onRetry={state.refresh}
            />
          )}
        </div>
      </div>
    </GlobalSurfaceShell>
  )
}

function UsageSpend({
  metric,
  answer,
  loading,
  asking,
  filtered,
  error,
  onRetry,
}: {
  metric: UsageMetric
  answer: { report: UsageReport; window: UsageWindow } | null
  loading: boolean
  asking: boolean
  filtered: boolean
  error: string | null
  onRetry: () => void
}): JSX.Element {
  const notice = error ? (
    <InlineNotice
      tone="error"
      title="Usage could not be read"
      detail={error}
      action={<OutlineButton onClick={onRetry}>Try again</OutlineButton>}
    />
  ) : null
  if (!answer) {
    return notice ?? <EmptyState title="Reading your agents' session logs…" />
  }
  const { report, window } = answer
  const machines = usageHasPeers(report) ? (
    <UsageMachines report={report} metric={metric} asking={asking} muted={loading} />
  ) : null
  if (usageTokenTotal(report.totals.tokens) === 0 && report.totals.costUsd === 0) {
    const anyLogs = filtered || machines !== null || report.sources.some((source) => source.found > 0)
    return (
      <>
        {notice}
        <EmptyState
          title={anyLogs ? 'No usage in this period' : 'No agent sessions on this machine yet'}
          body={
            anyLogs
              ? 'Pick a longer period to see earlier sessions.'
              : 'Usage appears once Claude Code, Codex, OpenCode, Gemini or Grok has run here, in a chat or a terminal.'
          }
        />
        {machines}
      </>
    )
  }
  return (
    <>
      {notice}
      <UsageOverview report={report} window={window} metric={metric} muted={loading} />
      {machines}
      <UsageTotals report={report} />
      <UsageBreakdown report={report} window={window} metric={metric} />
    </>
  )
}

function UsageOverview({
  report,
  window,
  metric,
  muted,
}: {
  report: UsageReport
  window: UsageWindow
  metric: UsageMetric
  muted: boolean
}): JSX.Element {
  const format = formatValue(metric)
  const series = useMemo(() => usageSeries(report, window, metric), [report, window, metric])
  const headline = usageHeadline(report, metric)
  const agents = [...report.agents].sort((a, b) =>
    metric === 'cost'
      ? b.costUsd - a.costUsd || usageTokenTotal(b.tokens) - usageTokenTotal(a.tokens)
      : usageTokenTotal(b.tokens) - usageTokenTotal(a.tokens),
  )
  const tokenTotal = usageTokenTotal(report.totals.tokens)
  const chartTitle =
    window.unit === 'hour'
      ? metric === 'cost'
        ? 'Hourly cost'
        : 'Hourly processed tokens'
      : metric === 'cost'
        ? 'Daily cost'
        : 'Daily processed tokens'
  return (
    <section aria-label="Overview" className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
      <div className={`flex min-w-0 flex-col gap-6 ${muted ? 'opacity-50' : ''}`}>
        <div className="flex flex-col gap-1">
          <div className="text-display leading-tight font-semibold tracking-tight text-[color:var(--text-strong)]">
            {format(headline)}
          </div>
          <div className="flex items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <span className="tabular-nums">
              {report.totals.sessions.toLocaleString()} {report.totals.sessions === 1 ? 'session' : 'sessions'}
            </span>
            {metric === 'cost' ? (
              <>
                <span aria-hidden="true">·</span>
                <EstimateNote report={report} />
              </>
            ) : null}
          </div>
          {report.sharedSessions > 0 ? <SharedSessionsNote count={report.sharedSessions} /> : null}
        </div>
        <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label="By agent">
          {agents.map((agent) => {
            const tokens = usageTokenTotal(agent.tokens)
            const value = metric === 'cost' ? agent.costUsd : tokens
            const share = metric === 'cost' ? report.totals.costUsd : tokenTotal
            return (
              <li
                key={agent.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-body"
              >
                <UsageAgentKey agent={agent.id} />
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium text-[color:var(--text-strong)]">
                    {usageAgentLabel(agent.id)}
                  </span>
                  <span className="shrink-0 text-meta tabular-nums text-[color:var(--text-subtle)]">
                    {agent.sessions.toLocaleString()} {agent.sessions === 1 ? 'session' : 'sessions'}
                  </span>
                </span>
                <span className="font-medium tabular-nums text-[color:var(--text-strong)]">{format(value)}</span>
                <div className="col-span-2 col-start-2 text-meta tabular-nums text-[color:var(--text-muted)]">
                  {formatUsageShare(value, share)} of {metric === 'cost' ? 'cost' : 'tokens'} ·{' '}
                  {metric === 'cost' ? `${formatUsageTokens(tokens)} tokens` : formatUsageUsd(agent.costUsd)}
                  {agent.unpricedTokens > 0 && metric === 'cost' ? ' · partly unpriced' : ''}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      <UsageChart
        title={chartTitle}
        series={series}
        window={window}
        formatValue={format}
        formatAxis={metric === 'cost' ? formatUsageUsdAxis : formatUsageTokens}
        formatPeriod={formatPeriod}
        muted={muted}
      />
    </section>
  )
}

/** "API estimate", with what that means and where the prices came from on hover or focus. */
function EstimateNote({ report }: { report: UsageReport }): JSX.Element {
  const unpriced = report.totals.unpricedTokens
  const total = usageTokenTotal(report.totals.tokens)
  const prices =
    report.pricing.source === 'bundled'
      ? 'Prices are the app’s own table; the live price list could not be reached.'
      : `Prices are the public list fetched ${
          report.pricing.fetchedAt
            ? `${MONTH_DAY.format(report.pricing.fetchedAt)}, ${formatTimeOfDay(report.pricing.fetchedAt)}`
            : 'earlier'
        }.`
  const content = [
    'What these tokens would cost at each provider’s API list price. A subscription is billed by its plan, not per token.',
    prices,
    unpriced > 0
      ? `${formatUsageShare(unpriced, total)} of tokens are on models with no known price and are left out.`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n')
  return (
    <Tooltip content={content} multiline placement="bottom">
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1 rounded-sm underline decoration-dotted underline-offset-2 focus-visible:focus-ring"
      >
        API estimate
      </span>
    </Tooltip>
  )
}

/** "3 sessions counted once across machines", with why on hover or focus. */
function SharedSessionsNote({ count }: { count: number }): JSX.Element {
  return (
    <Tooltip
      content="Found on more than one machine: a home folder synced between them, a restored backup, or a folder Windows and WSL share. Each is counted once, on this machine when it has it."
      multiline
      placement="bottom"
    >
      <span
        tabIndex={0}
        className="self-start rounded-sm text-meta tabular-nums text-[color:var(--text-muted)] underline decoration-dotted underline-offset-2 focus-visible:focus-ring"
      >
        {count.toLocaleString()} {count === 1 ? 'session' : 'sessions'} counted once across machines
      </span>
    </Tooltip>
  )
}

const machineIdentity = (machine: UsageReportMachine) => ({
  id: machine.id,
  kind: machine.kind,
  colour: machine.color,
  overridden: false,
})

function formatAt(at: number): string {
  return `${MONTH_DAY.format(at)}, ${formatTimeOfDay(at)}`
}

/**
 * Each machine's part, and where its figures came from. Every machine is
 * listed whatever the filter, so the filter never hides one that is away.
 */
function UsageMachines({
  report,
  metric,
  asking,
  muted,
}: {
  report: UsageReport
  metric: UsageMetric
  asking: boolean
  muted: boolean
}): JSX.Element {
  const headingId = useId()
  const counted = report.machines.reduce(
    (sum, machine) => sum + (metric === 'cost' ? machine.costUsd : machine.tokens),
    0,
  )
  return (
    <section aria-labelledby={headingId} className={`flex flex-col gap-3 ${muted ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2">
        <h3 id={headingId} className="m-0 text-heading font-medium text-[color:var(--text-strong)]">
          Machines
        </h3>
        {asking ? <Spinner size={14} label="Asking your other machines" /> : null}
      </div>
      <Table ariaLabel="Usage by machine">
        <thead>
          <Table.Row>
            <Table.Head sticky={false}>Machine</Table.Head>
            <Table.Head sticky={false} numeric>
              Cost
            </Table.Head>
            <Table.Head sticky={false} numeric>
              Share
            </Table.Head>
            <Table.Head sticky={false} numeric>
              Tokens
            </Table.Head>
            <Table.Head sticky={false} numeric>
              Sessions
            </Table.Head>
          </Table.Row>
        </thead>
        <tbody>
          {report.machines.map((machine) => {
            const line = usageMachineLine(machine, asking, formatAt)
            const lineText = (
              <span
                className={`text-meta ${line.tone === 'warn' ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-muted)]'}`}
              >
                {line.text}
              </span>
            )
            const shown = machine.status === 'local' || machine.status === 'ok' || machine.status === 'cached'
            return (
              <Table.Row key={machine.id}>
                <Table.Cell>
                  <span className="flex min-w-0 items-center gap-2">
                    <MachineGlyph identity={machineIdentity(machine)} className="icon-sm shrink-0" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[color:var(--text-strong)]">{machine.label}</span>
                      {machine.detail && line.tone === 'warn' ? (
                        <Tooltip content={machine.detail} multiline placement="bottom">
                          <span tabIndex={0} className="self-start rounded-sm focus-visible:focus-ring">
                            {lineText}
                          </span>
                        </Tooltip>
                      ) : (
                        lineText
                      )}
                    </span>
                  </span>
                </Table.Cell>
                <Table.Cell numeric>{shown ? formatUsageUsd(machine.costUsd) : '—'}</Table.Cell>
                <Table.Cell numeric>
                  <span className="text-[color:var(--text-muted)]">
                    {shown ? formatUsageShare(metric === 'cost' ? machine.costUsd : machine.tokens, counted) : '—'}
                  </span>
                </Table.Cell>
                <Table.Cell numeric>{shown ? formatUsageTokens(machine.tokens) : '—'}</Table.Cell>
                <Table.Cell numeric>{shown ? machine.sessions.toLocaleString() : '—'}</Table.Cell>
              </Table.Row>
            )
          })}
        </tbody>
      </Table>
    </section>
  )
}

function UsageTotals({ report }: { report: UsageReport }): JSX.Element {
  const headingId = useId()
  const items = [
    ...usageTotalsRow(report.totals.tokens).map((item) => ({ ...item, text: formatUsageTokens(item.value) })),
    {
      label: 'Cache savings',
      value: report.totals.cacheSavingsUsd,
      text: formatUsageUsd(report.totals.cacheSavingsUsd),
    },
  ]
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="m-0 text-heading font-medium text-[color:var(--text-strong)]">
        Totals
      </h3>
      <dl className="m-0 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
        {items.map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col gap-1">
            <dt className="text-meta text-[color:var(--text-muted)]">{item.label}</dt>
            <dd className="m-0 text-heading font-medium tabular-nums text-[color:var(--text-strong)]">{item.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

type BreakdownBy = 'model' | 'period'

function UsageBreakdown({
  report,
  window,
  metric,
}: {
  report: UsageReport
  window: UsageWindow
  metric: UsageMetric
}): JSX.Element {
  const headingId = useId()
  const [by, setBy] = useState<BreakdownBy>('model')
  const periodLabel = window.unit === 'hour' ? 'Hour' : 'Day'
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <h3 id={headingId} className="m-0 text-heading font-medium text-[color:var(--text-strong)]">
          Breakdown
        </h3>
        <SegmentedControl
          ariaLabel="Break down by"
          size="sm"
          items={[
            { value: 'model', label: 'Model' },
            { value: 'period', label: periodLabel },
          ]}
          value={by}
          onChange={setBy}
        />
      </div>
      {by === 'model' ? (
        <ModelTable report={report} metric={metric} />
      ) : (
        <PeriodTable report={report} window={window} periodLabel={periodLabel} />
      )}
    </section>
  )
}

function ModelTable({ report, metric }: { report: UsageReport; metric: UsageMetric }): JSX.Element {
  const models = [...report.models].sort(
    metric === 'cost'
      ? (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || usageTokenTotal(b.tokens) - usageTokenTotal(a.tokens)
      : (a, b) => usageTokenTotal(b.tokens) - usageTokenTotal(a.tokens),
  )
  const tokenTotal = usageTokenTotal(report.totals.tokens)
  const share = (model: UsageReportModel): string => {
    if (metric === 'tokens') return formatUsageShare(usageTokenTotal(model.tokens), tokenTotal)
    return model.costUsd === null ? '—' : formatUsageShare(model.costUsd, report.totals.costUsd)
  }
  return (
    <Table ariaLabel="Usage by model">
      <thead>
        <Table.Row>
          <Table.Head sticky={false}>Model</Table.Head>
          <Table.Head sticky={false} numeric>
            Cost
          </Table.Head>
          <Table.Head sticky={false} numeric>
            Share
          </Table.Head>
          <Table.Head sticky={false} numeric>
            Tokens
          </Table.Head>
        </Table.Row>
      </thead>
      <tbody>
        {models.map((model) => (
          <Table.Row key={`${model.agent}/${model.model}`}>
            <Table.Cell>
              <span className="flex min-w-0 items-center gap-2">
                <UsageAgentKey agent={model.agent} />
                <span className="sr-only">{usageAgentLabel(model.agent)}: </span>
                <span className="truncate text-[color:var(--text-strong)]">{model.model}</span>
              </span>
            </Table.Cell>
            <Table.Cell numeric>
              {model.costUsd === null ? (
                <span className="text-[color:var(--text-subtle)]">Unpriced</span>
              ) : (
                formatUsageUsd(model.costUsd)
              )}
            </Table.Cell>
            <Table.Cell numeric>
              <span className="text-[color:var(--text-muted)]">{share(model)}</span>
            </Table.Cell>
            <Table.Cell numeric>{formatUsageTokens(usageTokenTotal(model.tokens))}</Table.Cell>
          </Table.Row>
        ))}
      </tbody>
    </Table>
  )
}

function PeriodTable({
  report,
  window,
  periodLabel,
}: {
  report: UsageReport
  window: UsageWindow
  periodLabel: string
}): JSX.Element {
  const rows = useMemo(() => usagePeriodRows(report, window), [report, window])
  return (
    <Table ariaLabel={`Usage by ${periodLabel.toLowerCase()}`}>
      <thead>
        <Table.Row>
          <Table.Head sticky={false}>{periodLabel}</Table.Head>
          <Table.Head sticky={false}>Agents</Table.Head>
          <Table.Head sticky={false} numeric>
            Cost
          </Table.Head>
          <Table.Head sticky={false} numeric>
            Tokens
          </Table.Head>
        </Table.Row>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Table.Row key={row.start}>
            <Table.Cell>
              <span className="text-[color:var(--text-strong)]">
                {window.unit === 'hour' ? formatTimeOfDay(row.start) : WEEKDAY_MONTH_DAY.format(row.start)}
              </span>
            </Table.Cell>
            <Table.Cell>
              <span className="flex items-center gap-3">
                {[...row.byAgent]
                  .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
                  .map((agent) => (
                    <Tooltip
                      key={agent.agent}
                      content={`${usageAgentLabel(agent.agent)}: ${formatUsageUsd(agent.costUsd)} · ${formatUsageTokens(agent.tokens)} tokens`}
                    >
                      <span tabIndex={0} className="inline-flex rounded-sm focus-visible:focus-ring">
                        <UsageAgentKey agent={agent.agent} />
                        <span className="sr-only">
                          {usageAgentLabel(agent.agent)}: {formatUsageUsd(agent.costUsd)},{' '}
                          {formatUsageTokens(agent.tokens)} tokens
                        </span>
                      </span>
                    </Tooltip>
                  ))}
              </span>
            </Table.Cell>
            <Table.Cell numeric>{formatUsageUsd(row.costUsd)}</Table.Cell>
            <Table.Cell numeric>{formatUsageTokens(row.tokens)}</Table.Cell>
          </Table.Row>
        ))}
      </tbody>
    </Table>
  )
}

import React, { type JSX } from 'react'

import { usageAgentChartSlot, type UsageAgentId } from '../../../../shared/usage-report'
import CliIcon from '../CliIcon'

/** The chart colour an agent's series wears everywhere on the dashboard. */
export function usageAgentColor(agent: UsageAgentId): string {
  const slot = usageAgentChartSlot(agent)
  return slot ? `var(--chart-${slot})` : 'var(--chart-other)'
}

/**
 * The legend key: a square of the series colour (the mark the area is, not a
 * dot standing for a state), beside the agent's own logo.
 */
export function UsageAgentKey({ agent, className }: { agent: UsageAgentId; className?: string }): JSX.Element {
  return (
    <span className={`inline-flex shrink-0 items-center gap-2 ${className ?? ''}`} aria-hidden="true">
      <span className="size-2.5 rounded-xs" style={{ backgroundColor: usageAgentColor(agent) }} />
      <CliIcon cli={agent} className="icon-sm text-[color:var(--text-default)]" />
    </span>
  )
}

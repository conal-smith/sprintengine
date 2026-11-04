import React, { useMemo, type JSX } from 'react'

import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import { ExtensionIcon } from '../../../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../../../ui/mcpIconSlug'

/** How many marks the stack shows before it stops: a glance, not a list. */
const STACK_LIMIT = 3

/**
 * The marks of a few things this machine has installed, overlapped (owner
 * ruling 2026-11-03): what the Extensions title bar and the rail's Extensions
 * pill show beside their words, so "what do I have" is answered by
 * recognition before it is answered by a count. The MCP servers are what
 * carry a brand mark; a machine with none draws nothing.
 */
export function InstalledStack({ size = 18 }: { size?: number }): JSX.Element | null {
  const servers = useWorkspaceStore((state) => state.appSettings.mcp?.servers)
  const shown = useMemo(() => Object.values(servers ?? {}).slice(0, STACK_LIMIT), [servers])
  if (shown.length === 0) return null
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center">
      {shown.map((server, index) => (
        <span
          key={server.id}
          // Each mark overlaps the one before it by a third, ringed in the
          // ground it sits on so the overlap reads as a stack, not a smudge.
          className="inline-flex rounded-sm ring-2 ring-[color:var(--bg-surface)]"
          style={index > 0 ? { marginLeft: -Math.round(size / 3) } : undefined}
        >
          <ExtensionIcon slug={mcpIconSlug(server.id)} name={server.name} size={size} />
        </span>
      ))}
    </span>
  )
}

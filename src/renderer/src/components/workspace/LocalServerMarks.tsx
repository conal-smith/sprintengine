import React, { type JSX } from 'react'

import type { StudioLocalServer } from '../../../../../packages/studio-protocol/src/public'
import { LocalServerGlyph } from '../AppIcons'
import { GhostButton, Tooltip } from '../ui'
import { LocalServersMenu, LocalServerStateWord, localServerExitLine, localServerStateWord } from './LocalServersMenu'

// Where a person sees the local servers agents started, in the two places
// they look: the open chat's composer strip (this conversation's servers,
// running or not) and the sidebar's row (only while one is up, so scanning
// the list answers "what is running right now"). Both open the same menu
// (`LocalServersMenu`).
//
// The state is a word on both, never a dot (owner ruling 2026-09-28): the
// glyph says "a local server", the word says how it stands.

/** Whether a server is up or coming up: what the sidebar's mark counts. */
function isLive(server: StudioLocalServer): boolean {
  return server.state === 'running' || server.state === 'starting'
}

/**
 * The strip's words. One server is named, with its state: "localhost:5173 ·
 * Running". Several are counted, with how many are up: "3 servers · 2
 * running", "2 servers · 1 running, 1 starting", "2 servers · all stopped".
 * Null draws nothing.
 */
export function localServersStripCopy(
  servers: readonly StudioLocalServer[],
): { label: string; state: string; ariaLabel: string } | null {
  if (servers.length === 0) return null
  if (servers.length === 1) {
    const [server] = servers
    const state = localServerStateWord(server.state)
    const exit = localServerExitLine(server)
    return {
      label: server.title,
      state,
      ariaLabel: `Local server ${server.title}, ${state.toLowerCase()}${exit ? ` (${exit.toLowerCase()})` : ''}`,
    }
  }
  const running = servers.filter((server) => server.state === 'running').length
  const starting = servers.filter((server) => server.state === 'starting').length
  const parts = [running > 0 ? `${running} running` : null, starting > 0 ? `${starting} starting` : null].filter(
    (part): part is string => part !== null,
  )
  const state = parts.length > 0 ? parts.join(', ') : 'all stopped'
  const label = `${servers.length} servers`
  return { label, state, ariaLabel: `${servers.length} local servers, ${state}` }
}

/**
 * The sidebar mark's words: how many are up, and a line per server for the
 * tooltip. Null while none is running or starting — the mark is "something is
 * up here", and a row whose servers have all stopped looks like any other.
 */
export function localServersRowMarkCopy(
  servers: readonly StudioLocalServer[],
): { count: number; title: string; lines: string[]; ariaLabel: string } | null {
  const live = servers.filter(isLive)
  if (live.length === 0) return null
  const running = live.filter((server) => server.state === 'running').length
  const starting = live.length - running
  const words = [running > 0 ? `${running} running` : null, starting > 0 ? `${starting} starting` : null].filter(
    (part): part is string => part !== null,
  )
  const title = `${live.length === 1 ? 'Local server' : 'Local servers'}: ${words.join(', ')}`
  const lines = servers.map((server) => `${server.title} — ${localServerStateWord(server.state)}`)
  return { count: live.length, title, lines, ariaLabel: `${title}. Show local servers` }
}

/**
 * The open chat's local servers, on the composer's strip, beside the pull
 * request slot. Nothing is drawn for a conversation that linked none.
 */
export function LocalServersStripButton({
  workspaceId,
  servers,
  elsewhere,
}: {
  workspaceId: string
  servers: readonly StudioLocalServer[]
  /** The paired machine the servers run on, for a chat there. */
  elsewhere?: { machineName: string }
}): JSX.Element | null {
  const copy = localServersStripCopy(servers)
  if (!copy) return null
  const single = servers.length === 1 ? servers[0] : null
  const ariaLabel = elsewhere ? `${copy.ariaLabel}, on ${elsewhere.machineName}` : copy.ariaLabel
  return (
    <LocalServersMenu
      workspaceId={workspaceId}
      servers={servers}
      ariaLabel={single ? `Local server ${single.title}` : 'Local servers from this conversation'}
      {...(elsewhere ? { elsewhere } : {})}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <Tooltip content={ariaLabel} placement="top" wrapperClassName="flex min-w-0">
          <GhostButton
            ref={ref}
            size="xs"
            tone="subtle"
            onClick={togglePopover}
            {...triggerProps}
            aria-label={ariaLabel}
            data-strip-local-servers={servers.length}
            className="min-w-0 gap-1.5 whitespace-nowrap"
          >
            <LocalServerGlyph className="icon-xs shrink-0" />
            <span className="min-w-0 max-w-48 truncate">{copy.label}</span>
            <span aria-hidden="true">·</span>
            {single ? <LocalServerStateWord state={single.state} /> : <span className="shrink-0">{copy.state}</span>}
          </GhostButton>
        </Tooltip>
      )}
    />
  )
}

/**
 * The sidebar row's mark: the glyph and how many servers are up, while at
 * least one is. The tooltip lists them; a click opens the menu.
 */
export function LocalServersRowMark({
  workspaceId,
  servers,
  dim = false,
}: {
  workspaceId: string
  servers: readonly StudioLocalServer[]
  /** The row is background: the mark recedes with the rest of its line. */
  dim?: boolean
}): JSX.Element | null {
  const copy = localServersRowMarkCopy(servers)
  if (!copy) return null
  return (
    <LocalServersMenu
      workspaceId={workspaceId}
      servers={servers}
      ariaLabel="Local servers in this chat"
      placement="bottom-start"
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <Tooltip
          content={
            <>
              <span className="block font-medium text-[color:var(--text-strong)]">{copy.title}</span>
              {copy.lines.map((line, index) => (
                <span key={`${index}:${line}`} className="block">
                  {line}
                </span>
              ))}
            </>
          }
          multiline
          wrapperClassName="flex shrink-0 items-center"
        >
          <GhostButton
            ref={ref}
            size="inline"
            tone="subtle"
            onClick={togglePopover}
            {...triggerProps}
            aria-label={copy.ariaLabel}
            data-local-servers-mark={copy.count}
            className={`shrink-0 gap-0.5 ${dim ? 'opacity-60' : ''}`}
          >
            <LocalServerGlyph className="icon-xs shrink-0" />
            <span className="font-mono text-micro tabular-nums">{copy.count}</span>
          </GhostButton>
        </Tooltip>
      )}
    />
  )
}

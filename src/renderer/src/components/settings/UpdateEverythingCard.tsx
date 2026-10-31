import { useEffect, useMemo, useState } from 'react'

import { executionHostLabel, LOCAL_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { CliUpdateAllItem } from '../../../../shared/ipc/cli-update-all'
import { hostPlatform } from '../../clientCapabilities'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { InlineNotice, OutlineButton } from '../ui'
import { SettingCard, SettingsRow } from './SettingsAtoms'

// Settings ▸ Agents: Update everything. One press updates every agent CLI
// with a newer version published, on this machine and on each WSL
// distribution turned on, through the updater each row's Update runs, and
// shows how each went, machine by machine. Paired machines are updated on
// their own: each one's Settings has the same button.

const STATE_WORDS: Record<CliUpdateAllItem['state'], string> = {
  queued: 'Waiting',
  updating: 'Updating…',
  updated: 'Updated',
  unchanged: 'Still the same version',
  failed: 'Did not update',
}

function itemLine(item: CliUpdateAllItem): string {
  if (item.state === 'updated') return `Updated to ${item.to ?? item.latest ?? 'the latest version'}`
  if (item.state === 'failed') return item.error ? `Did not update: ${item.error}` : STATE_WORDS.failed
  if (item.state === 'queued' || item.state === 'updating')
    return `${STATE_WORDS[item.state]} ${item.from ?? '?'} → ${item.latest ?? 'latest'}`
  return `${STATE_WORDS[item.state]} (${item.from ?? 'unknown'})`
}

/** The machines in the order Settings lists them: this one first. */
export function groupByMachine(items: readonly CliUpdateAllItem[]): Array<[string, CliUpdateAllItem[]]> {
  const groups = new Map<string, CliUpdateAllItem[]>()
  for (const item of items) groups.set(item.hostId, [...(groups.get(item.hostId) ?? []), item])
  return [...groups.entries()].sort(([a], [b]) =>
    a === LOCAL_HOST_ID ? -1 : b === LOCAL_HOST_ID ? 1 : a.localeCompare(b),
  )
}

export function UpdateEverythingCard() {
  const advisories = useWorkspaceStore((s) => s.cliVersionAdvisories)
  const catalog = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  const refreshCliVersionAdvisories = useWorkspaceStore((s) => s.refreshCliVersionAdvisories)
  const [items, setItems] = useState<CliUpdateAllItem[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const outdated = useMemo(() => {
    let count = 0
    const machines = new Set<string>()
    for (const [hostId, map] of Object.entries(advisories ?? {})) {
      for (const advisory of Object.values(map ?? {})) {
        if (advisory?.status !== 'behind_latest' || !advisory.updateCommand) continue
        count += 1
        machines.add(hostId)
      }
    }
    return { count, machines: machines.size }
  }, [advisories])

  useEffect(() => {
    if (!running || typeof window.api.onCliUpdateAllProgress !== 'function') return undefined
    return window.api.onCliUpdateAllProgress(setItems)
  }, [running])

  if (typeof window.api.cliUpdateAll !== 'function') return null
  if (outdated.count === 0 && items === null) return null

  const nameOf = (cli: string) => catalog.find((entry) => entry.id === cli)?.displayName ?? cli
  const run = async () => {
    setError(null)
    setItems(null)
    setRunning(true)
    try {
      const result = await window.api.cliUpdateAll()
      if (result.ok) setItems(result.items)
      else setError(result.message)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRunning(false)
    }
    // Main detected each CLI again as its update finished; these reads take
    // the new versions up without probing anything else.
    await refreshCliAvailability({ cliRuntimes })
    void refreshCliVersionAdvisories()
  }

  const summary =
    outdated.count === 0
      ? 'Every CLI is up to date.'
      : `${outdated.count} ${outdated.count === 1 ? 'update' : 'updates'}${
          outdated.machines > 1 ? ` on ${outdated.machines} machines` : ''
        }. Paired machines update from their own Settings.`
  return (
    <SettingCard>
      <SettingsRow label="Update everything" help={summary}>
        <OutlineButton disabled={running || outdated.count === 0} onClick={() => void run()}>
          {running ? 'Updating…' : 'Update everything'}
        </OutlineButton>
      </SettingsRow>
      {items && items.length === 0 ? (
        <SettingsRow label="Nothing to update" help="Every CLI with an updater was already current.">
          {null}
        </SettingsRow>
      ) : null}
      {items
        ? groupByMachine(items).map(([hostId, machineItems]) => (
            <SettingsRow key={hostId} label={executionHostLabel(hostId as ExecutionHostId, hostPlatform())} stacked>
              <ul
                className="space-y-1"
                aria-label={`Updates on ${executionHostLabel(hostId as ExecutionHostId, hostPlatform())}`}
              >
                {machineItems.map((item) => (
                  <li key={item.cli} className="flex min-w-0 items-baseline gap-2 text-body">
                    <span className="shrink-0 text-[color:var(--text-strong)]">{nameOf(item.cli)}</span>
                    <span
                      className={`min-w-0 break-words text-meta ${
                        item.state === 'failed' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-muted)]'
                      }`}
                    >
                      {itemLine(item)}
                    </span>
                  </li>
                ))}
              </ul>
            </SettingsRow>
          ))
        : null}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    </SettingCard>
  )
}

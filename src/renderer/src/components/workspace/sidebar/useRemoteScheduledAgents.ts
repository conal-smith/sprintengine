import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ScheduledAgentView, ScheduledAgentsPause } from '../../../../../shared/scheduled-agents'
import type { MeshConnection, MeshScheduledAgentAction } from '../../../../../shared/tailnet-mesh'
import type { TailnetScope } from '../../../../../shared/tailnet'
import { tailnetScopeGrantsAccess } from '../../../../../shared/tailnet'
import type { RemoteBrowseEntry } from '../remoteBand/remoteSessionsModel'

// Each paired machine's scheduled agents, for the sidebar's Scheduled section.
// A schedule there runs on that machine, by that machine's scheduler, so it is
// listed and controlled from here over the `schedule.*` tools the machine
// serves to a paired device: on `workspace:read` to list, `workspace:operate`
// to run, pause, resume or close one.
//
// Read on the same beat as the machine's rows: whenever its browse settles —
// the mount read, a change it pushed, a machine waking — since a run starting
// over there is a chat the change feed says it has. Plus a slow re-read, so
// "in 5m" moves on for a machine with nothing else to say.

const REMOTE_SCHEDULES_CADENCE_MS = 120_000

export type RemoteScheduledMachine = {
  connectionId: string
  machineName: string
  agents: ScheduledAgentView[]
  pausedAll: ScheduledAgentsPause | null
  /** The pairing may run, pause, resume and close its schedules (`workspace:operate`). */
  operable: boolean
}

/** Whether a machine's browse says this pairing may list its schedules, and drive them. */
export function remoteScheduleAccess(entry: RemoteBrowseEntry | undefined): { read: boolean; operate: boolean } {
  const browse = entry?.browse
  if (!browse?.reachable || browse.unauthorized) return { read: false, operate: false }
  const granted = new Set<TailnetScope>(browse.scopes)
  return {
    read: tailnetScopeGrantsAccess(granted, 'workspace:read'),
    operate: tailnetScopeGrantsAccess(granted, 'workspace:operate'),
  }
}

/** What a toast says of an action that went through. */
export function remoteScheduleActionWords(action: MeshScheduledAgentAction, machineName: string): string {
  switch (action) {
    case 'run':
      return `Its chat is starting on ${machineName}.`
    case 'pause':
      return `It starts no runs on ${machineName} until resumed.`
    case 'resume':
      return `It runs on ${machineName} at its next time.`
    case 'delete':
      return `It will not run on ${machineName} again.`
  }
}

// A schedule made on a paired machine from New chat changes nothing the
// machine's browse says, so the door says it here and the section re-reads.
const changeListeners = new Set<(connectionId: string) => void>()

export function announceRemoteScheduledChange(connectionId: string): void {
  for (const listener of changeListeners) listener(connectionId)
}

export function useRemoteScheduledAgents({
  enabled,
  connections,
  browses,
}: {
  enabled: boolean
  connections: readonly MeshConnection[]
  browses: ReadonlyMap<string, RemoteBrowseEntry>
}): {
  machines: RemoteScheduledMachine[]
  refresh: (connectionId: string) => void
} {
  const [lists, setLists] = useState<
    ReadonlyMap<string, { agents: ScheduledAgentView[]; pausedAll: ScheduledAgentsPause | null }>
  >(() => new Map())
  const bridge = typeof window !== 'undefined' && typeof window.api?.meshScheduledAgents === 'function'
  // The machines that may be asked, and when each was last browsed: the beat.
  const readable = useMemo(
    () =>
      enabled && bridge
        ? connections.flatMap((connection) => {
            const entry = browses.get(connection.id)
            const access = remoteScheduleAccess(entry)
            return access.read ? [{ connection, at: entry?.at ?? 0, operate: access.operate }] : []
          })
        : [],
    [bridge, browses, connections, enabled],
  )
  const asking = useRef(new Set<string>())
  const read = useCallback((connectionId: string) => {
    if (asking.current.has(connectionId)) return
    asking.current.add(connectionId)
    void window.api
      .meshScheduledAgents({ connectionId })
      .then((result) => {
        // A machine that did not answer keeps what it last said, as its rows do.
        if (!result.ok) return
        setLists((current) =>
          new Map(current).set(connectionId, { agents: result.agents, pausedAll: result.pausedAll }),
        )
      })
      .catch(() => undefined)
      .finally(() => asking.current.delete(connectionId))
  }, [])
  useEffect(() => {
    changeListeners.add(read)
    return () => {
      changeListeners.delete(read)
    }
  }, [read])
  const beat = readable.map(({ connection, at }) => `${connection.id}@${at}`).join('|')
  useEffect(() => {
    for (const { connection } of readable) read(connection.id)
    // On the beat alone: the list's identity moves with every browse map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, read])
  const readableIds = readable.map(({ connection }) => connection.id).join('|')
  useEffect(() => {
    if (!readableIds) return
    const timer = window.setInterval(() => {
      for (const id of readableIds.split('|')) read(id)
    }, REMOTE_SCHEDULES_CADENCE_MS)
    return () => window.clearInterval(timer)
  }, [read, readableIds])

  const machines = useMemo(
    () =>
      readable.flatMap(({ connection, operate }) => {
        const list = lists.get(connection.id)
        if (!list || list.agents.length === 0) return []
        return [
          {
            connectionId: connection.id,
            machineName: connection.machineName,
            agents: list.agents,
            pausedAll: list.pausedAll,
            operable: operate,
          },
        ]
      }),
    [lists, readable],
  )
  return { machines, refresh: read }
}

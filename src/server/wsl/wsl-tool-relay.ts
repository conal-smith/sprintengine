import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import { connect, type StudioClient } from '../../../packages/agent-sdk/src/client'
import type { OfferedToolset, ToolDefinition } from '../../../packages/agent-sdk/src/tools'
import type { StudioTransport } from '../../../packages/agent-sdk/src/transport'
import {
  STUDIO_RESERVED_TOOLSET_NAMES,
  STUDIO_TOOL_NAME_PATTERN,
  STUDIO_TOOLSET_NAME_PATTERN,
} from '../../../packages/studio-protocol/src/public'
import { connectionContextOf, gatewayToolTimeoutMs } from '../../main/automation/offer-gateway-tools'
import { isStudioGatewayMutation } from '../../main/automation/studio-gateway-tools'
import { servedOnlyToPairedDevices } from '../../main/automation/tailnet/tailnet-scopes'
import { backoffDelayMs } from '../../shared/exponentialBackoff'
import { wslToWindowsPath } from '../../shared/host-paths'
import { toolError, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { WslServerConnection } from './wsl-environment-manager'

// The desktop's toolsets, for a chat agent in WSL (phase 7 spec, 3.7). An
// agent there reaches its own server's gateway, which serves the core's tools
// but has no browser, canvas, editor, tour, terminals or agent launches, and
// none of what the Windows side keeps: the person's workspace list, the
// backlog, scheduled agents, modules. So the front door is a client of each
// WSL server too, with the shell role, and offers it those as toolsets: the
// ones the desktop's shell offers the Windows-side server, each call run
// through that side's registry, which hands it to the shell; and the
// Windows-side server's own tools of those families, each call run by the
// tool's own handler there, as the shell runs its tools out of process. The
// answer goes back the same way. An agent in WSL lists the tools an agent on
// Windows does, but for two families: `conversation`, which the WSL server
// serves itself, and `tailnet`, which is served on the Windows side's
// owner-only socket and nowhere else (`tailnet-tools.ts`).
//
// In process the shell offers only the browser and the canvas, and the
// editor, tours, terminals and agent launches are the Windows gateway's own
// tools; out of process the shell offers all six (decision R78). Either way
// each family is offered once, from whichever of the two holds it.
//
// The offers follow the Windows side's: a toolset the shell offers later is
// offered on, one it withdraws is withdrawn. A tool named with a second dot
// (`cli.runtime.list`) crosses with its later dots as underscores, since a
// protocol tool name has none; an agent that rewrites dots reads the same
// name either way. A module's tool (`review_list_pending`) crosses in a
// toolset named for the part before its first underscore.
//
// Tool inputs cross as the agent wrote them, except the file paths the
// editor's tools take and the folder `workspace.create` opens: those are
// read on Windows, so an absolute Linux path is respelled the way Windows
// opens it (`/home/dev/a.ts` as `\\wsl.localhost\<distro>\home\dev\a.ts`,
// a path under the drive mount as the drive's), and a `~` path, whose home
// Windows cannot know, is refused in words. A relative path stays relative to
// the workspace, which is how the Windows side reads it.

/** The toolsets the desktop's shell offers (decision R78). */
export const RELAYED_TOOLSETS = ['browser', 'canvas', 'editor', 'tour', 'terminal', 'agent'] as const

/**
 * The families of Studio's own tools whose data the Windows side keeps, which
 * a WSL server cannot serve: the backlog (phase 7, 3.7), and the workspace
 * list, scheduled agents, the CLI catalog, modules and the marketplace, which
 * an agent on Windows is listed beside it.
 */
export const WINDOWS_SIDE_TOOLSETS = ['backlog', 'workspace', 'schedule', 'cli', 'module', 'marketplace'] as const

export type WslToolRelay = { close(): void }

/**
 * A server the desktop's toolsets are offered to: a WSL distribution's, or
 * an SSH machine's (phase 8), whose agents get the pane's browser (its tabs
 * reach that machine's network) and the canvas, and none of the toolsets
 * that act on this computer's files or processes.
 */
export type RelayTarget = {
  /** `wsl:<distro>` or `ssh:<id>`: the gateway connection id's prefix. */
  key: string
  /** For the log: "WSL: Ubuntu", "build-box". */
  name: string
  backend: { isOpen(): boolean; onClose(listener: (reason: string) => void): void }
  open(purpose: 'studio'): Promise<Duplex>
  toolsets: readonly string[]
  /** Whether the tools modules add on the Windows side are offered too (phase 5, 7.2). */
  moduleTools?: boolean
  /** A call's arguments as the desktop reads them; throws `RelayPathError` for a path it cannot open. */
  args(toolset: string, args: Record<string, unknown>): Record<string, unknown>
}

/** The toolsets offered to an SSH machine's server: none that act on this computer's files or processes. */
export const SSH_RELAYED_TOOLSETS = ['browser', 'canvas'] as const

/** A WSL server as a relay target, its editor and workspace paths respelled for Windows. */
export function wslRelayTarget(connection: WslServerConnection): RelayTarget {
  return {
    key: `wsl:${connection.distro}`,
    name: `WSL: ${connection.distro}`,
    backend: connection.backend,
    open: (purpose) => connection.open(purpose),
    toolsets: [...RELAYED_TOOLSETS, ...WINDOWS_SIDE_TOOLSETS],
    moduleTools: true,
    args: (toolset, args) => relayedToolArgs(toolset, args, connection),
  }
}

/** How long a tools stream that closed on its own, or failed to open, waits before it is opened again; doubling to the cap while it keeps failing. */
const RELAY_REOPEN_MS = 1_000
const RELAY_REOPEN_MAX_MS = 30_000

function asTarget(connection: WslServerConnection | RelayTarget): RelayTarget {
  return 'distro' in connection ? wslRelayTarget(connection) : connection
}

/** Thrown for an input path the Windows side cannot open; the call answers with it in words. */
class RelayPathError extends Error {}

/**
 * A relayed tool's arguments as the Windows side reads them: the editor's
 * file paths and a new workspace's folder in Windows spelling. Throws
 * `RelayPathError` for a `~` path.
 */
export function relayedToolArgs(
  toolset: string,
  args: Record<string, unknown>,
  where: { distro: string; driveMountRoot: string | null },
): Record<string, unknown> {
  if (toolset !== 'editor' && toolset !== 'workspace') return args
  const respell = (path: unknown): unknown => {
    if (typeof path !== 'string') return path
    const trimmed = path.trim()
    if (trimmed === '~' || trimmed.startsWith('~/'))
      throw new RelayPathError(
        `"${trimmed}": give the absolute Linux path; the home directory in WSL: ${where.distro} is not known on Windows.`,
      )
    if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return path
    return wslToWindowsPath(trimmed, {
      distro: where.distro,
      ...(where.driveMountRoot ? { driveMountRoot: where.driveMountRoot } : {}),
    })
  }
  const location = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'path' in value
      ? { ...value, path: respell((value as { path: unknown }).path) }
      : value
  const next: Record<string, unknown> = { ...args }
  if (toolset === 'workspace') {
    if (args.folderPath !== undefined) next.folderPath = respell(args.folderPath)
    return next
  }
  if (Array.isArray(args.files)) next.files = args.files.map(location)
  if (Array.isArray(args.paths)) next.paths = args.paths.map(respell)
  if (args.focus !== undefined) next.focus = location(args.focus)
  return next
}

/** A Studio protocol transport over an admitted stream: one frame per line, saying hello with `ticket`. */
export function lineTransport(stream: Duplex, ticket: string): StudioTransport {
  const decoder = new StringDecoder('utf8')
  const messageListeners: Array<(frame: string) => void> = []
  const closeListeners: Array<(error?: Error) => void> = []
  let buffer = ''
  let failure: Error | undefined
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) for (const listener of messageListeners) listener(line)
      newline = buffer.indexOf('\n')
    }
  })
  stream.on('error', (error: Error) => {
    failure = error
  })
  stream.once('close', () => {
    for (const listener of closeListeners) listener(failure)
  })
  return {
    credential: { token: ticket },
    send: (frame) => void stream.write(`${frame}\n`),
    close: () => {
      stream.end()
      stream.destroy()
    },
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    pause: () => void stream.pause(),
    resume: () => void stream.resume(),
  }
}

/** The ticket line a `studio` door says first, then the stream for the protocol. */
export function readTicket(stream: Duplex, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const done = (error: Error | null, ticket?: string) => {
      clearTimeout(timer)
      stream.off('readable', onReadable)
      stream.off('close', onClose)
      if (error) reject(error)
      else resolve(ticket!)
    }
    const onClose = () => done(new Error('The Studio server closed the connection before it gave a ticket.'))
    const onReadable = () => {
      let chunk: Buffer | null
      while ((chunk = stream.read() as Buffer | null) !== null) {
        buffer = Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) continue
        const rest = buffer.subarray(newline + 1)
        if (rest.length > 0) stream.unshift(rest)
        try {
          const line = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as { t?: unknown; ticket?: unknown }
          if (line.t !== 'ticket' || typeof line.ticket !== 'string') throw new Error('no ticket')
          done(null, line.ticket)
        } catch {
          done(new Error('The Studio server did not give a ticket.'))
        }
        return
      }
    }
    const timer = setTimeout(() => done(new Error('The Studio server gave no ticket in time.')), timeoutMs)
    timer.unref?.()
    stream.on('readable', onReadable)
    stream.once('close', onClose)
  })
}

/**
 * The toolset and tool name one of Studio's own tools crosses under: its
 * family and the rest, the rest's dots as underscores, or the part of a
 * module's tool before its first underscore and the rest. Null for a name the
 * protocol cannot carry.
 */
export function relayedToolName(name: string): { toolset: string; tool: string } | null {
  const dot = name.indexOf('.')
  const split = dot === -1 ? name.indexOf('_') : dot
  if (split === -1) return null
  const toolset = name.slice(0, split)
  const tool = name.slice(split + 1).replace(/\./gu, '_')
  return STUDIO_TOOLSET_NAME_PATTERN.test(toolset) && STUDIO_TOOL_NAME_PATTERN.test(tool) ? { toolset, tool } : null
}

type RelayedToolset = {
  title: string
  description?: string
  tools: Array<Omit<ToolDefinition, 'handler'> & { run: ToolDefinition['handler'] }>
}

/**
 * Offer the desktop's toolsets to every WSL server the Windows side connects
 * to, and keep the offers in step with the shell's.
 */
export function relayShellToolsets(input: {
  onConnected(listener: (connection: WslServerConnection | RelayTarget) => void): void
  registry: ClientToolRegistry
  /**
   * The Windows-side server's own tools, core and module. A family a target
   * takes that no client offers here is offered from these.
   */
  gatewayTools?: () => McpToolRegistration[]
  log?: (message: string) => void
  /** Stands in for the SDK's `connect` in tests. */
  connectClient?: typeof connect
}): WslToolRelay {
  const log = input.log ?? (() => undefined)
  const open = new Map<
    string,
    {
      client: StudioClient
      backend: RelayTarget['backend']
      offered: Map<string, OfferedToolset>
      syncing: Promise<void>
      stop(): void
    }
  >()
  // The newest target under each key: a reopen for one a new server start replaced is not made.
  const current = new Map<string, RelayTarget>()
  // Backends whose close is already listened for: each reopen would add another.
  const watched = new WeakSet<RelayTarget['backend']>()
  let closed = false

  /**
   * What a target is offered now, toolset by toolset: the shell's, as the
   * Windows registry describes them, then this side's own.
   */
  const wantedToolsets = (target: RelayTarget) => {
    const visible = input.registry.visibleTools({
      gatewayConnectionId: 'wsl-relay',
      metadata: { kind: 'studio-agent' },
    })
    const sets = new Map<string, RelayedToolset>()
    for (const definition of visible) {
      if (!definition.builtIn || !target.toolsets.includes(definition.toolset)) continue
      const entry = sets.get(definition.toolset) ?? {
        title: definition.title,
        ...(definition.description ? { description: definition.description } : {}),
        tools: [],
      }
      const { tool } = definition
      entry.tools.push({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        ...(tool.mutates !== undefined ? { mutates: tool.mutates } : {}),
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
        run: onRegistry(target, definition.toolset, tool.name),
      })
      sets.set(definition.toolset, entry)
    }
    const offeredByClients = new Set(sets.keys())
    for (const registration of input.gatewayTools?.() ?? []) {
      // A tool served to paired devices alone is no agent's, here or there.
      if (servedOnlyToPairedDevices(registration.name)) continue
      const named = relayedToolName(registration.name)
      if (!named || offeredByClients.has(named.toolset)) continue
      const taken =
        target.toolsets.includes(named.toolset) ||
        (target.moduleTools === true && !STUDIO_RESERVED_TOOLSET_NAMES.includes(named.toolset))
      if (!taken) continue
      const entry = sets.get(named.toolset) ?? { title: named.toolset, tools: [] }
      // Two of this side's names can cross as one (`backlog.list` and a
      // module's `backlog_list`): the first registered keeps it, as the core's
      // do on Windows, rather than the whole toolset being refused for it.
      if (entry.tools.some((tool) => tool.name === named.tool)) continue
      entry.tools.push({
        name: named.tool,
        description: registration.description,
        inputSchema: registration.inputSchema,
        // Classified as the Windows gateway classifies it for its own audit.
        mutates: registration.mutates ?? isStudioGatewayMutation(registration.name),
        timeoutMs: gatewayToolTimeoutMs(registration.name),
        run: (args, call) => registration.handler(args, connectionContextOf(call)),
      })
      sets.set(named.toolset, entry)
    }
    return sets
  }

  /** A shell tool's call, run through the Windows registry as the calling agent's own. */
  const onRegistry =
    (connection: RelayTarget, toolset: string, tool: string): ToolDefinition['handler'] =>
    async (args, call) => {
      const outcome = await input.registry.call({
        caller: {
          // One gateway connection per WSL agent connection, for the Windows
          // side's affinity and in-flight bounds.
          gatewayConnectionId: `${connection.key}:${call.context.connection.workspaceId ?? ''}:${call.context.connection.agentId ?? call.id}`,
          metadata: { ...call.context.connection, kind: call.context.connection.kind },
          ...(call.context.conversation ? { conversation: call.context.conversation } : {}),
        },
        toolset,
        tool,
        args,
        signal: call.signal,
        onProgress: (progress) => call.progress(progress),
      })
      return outcome.result
    }

  /** A call's arguments read as the Windows side reads them, then run; a path it cannot open is answered in words. */
  const relayTo =
    (connection: RelayTarget, toolset: string, run: ToolDefinition['handler']): ToolDefinition['handler'] =>
    async (args, call) => {
      let windowsArgs: Record<string, unknown>
      try {
        windowsArgs = connection.args(toolset, args as Record<string, unknown>)
      } catch (error) {
        if (error instanceof RelayPathError) return toolError('invalid_path', error.message)
        throw error
      }
      return run(windowsArgs, call)
    }

  /** One sync at a time per server: two at once would offer a toolset twice, against its offer budget. */
  function sync(connection: RelayTarget): Promise<void> {
    const entry = open.get(connection.key)
    if (!entry) return Promise.resolve()
    entry.syncing = entry.syncing
      .then(() => syncNow(connection))
      .catch((error: unknown) =>
        log(
          `The desktop's tools could not be offered to ${connection.name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    return entry.syncing
  }

  async function syncNow(connection: RelayTarget): Promise<void> {
    const entry = open.get(connection.key)
    if (!entry) return
    const wanted = wantedToolsets(connection)
    for (const [name, offered] of entry.offered) {
      if (wanted.has(name)) continue
      entry.offered.delete(name)
      await offered.withdraw().catch(() => undefined)
    }
    for (const [name, set] of wanted) {
      const current = entry.offered.get(name)
      // Offered again when its tools change, though their number may not.
      const wire = set.tools.map((tool) => `${name}.${tool.name}`).sort()
      if (current && [...current.wireNames].sort().join('\n') === wire.join('\n')) continue
      try {
        const offered = await entry.client.tools.offer({
          name,
          title: set.title,
          ...(set.description ? { description: set.description } : {}),
          // A module's family is no reserved name on the WSL server, so the
          // offer names its reach: every agent there, as on Windows.
          reach: 'all',
          tools: set.tools.map(({ run, ...tool }) => ({ ...tool, handler: relayTo(connection, name, run) })),
        })
        entry.offered.set(name, offered)
      } catch (error) {
        // A family the WSL server serves itself is refused, and stays its own.
        log(
          `The ${name} toolset was not offered to ${connection.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  input.onConnected((offered) => {
    const target = asTarget(offered)
    current.set(target.key, target)
    relay(target)
  })

  /** Open the stream again later, while its target's server is up and nobody opened one meanwhile. */
  function reopen(connection: RelayTarget, attempt: number): void {
    const delay =
      backoffDelayMs(attempt, { baseMs: RELAY_REOPEN_MS, maxMs: RELAY_REOPEN_MAX_MS }) ?? RELAY_REOPEN_MAX_MS
    setTimeout(() => {
      if (closed || current.get(connection.key) !== connection) return
      if (connection.backend.isOpen() === false || open.has(connection.key)) return
      relay(connection, attempt + 1)
    }, delay).unref?.()
  }

  function relay(connection: RelayTarget, attempt = 0): void {
    if (closed) return
    open.get(connection.key)?.stop()
    if (!watched.has(connection.backend)) {
      watched.add(connection.backend)
      connection.backend.onClose(() => {
        const entry = open.get(connection.key)
        if (entry?.backend === connection.backend) entry.stop()
      })
    }
    const doConnect = input.connectClient ?? connect
    void doConnect({
      transport: async () => {
        const stream = await connection.open('studio')
        const ticket = await readTicket(stream)
        return lineTransport(stream, ticket)
      },
      client: { name: 'SprintEngine Studio (Windows)', kind: 'desktop' },
      // A new server start reaches here as a new connection; this one ends with its server.
      reconnect: false,
    }).then(
      (client) => {
        if (closed || connection.backend.isOpen() === false) {
          client.close()
          return
        }
        const unsubscribe = input.registry.subscribe(() => void sync(connection))
        open.set(connection.key, {
          client,
          backend: connection.backend,
          offered: new Map(),
          syncing: Promise.resolve(),
          stop: () => {
            unsubscribe()
            client.close()
            open.delete(connection.key)
          },
        })
        // The tools' own stream can end while the server and its backend wire
        // stay up (each stream is its own relay): opened again, or the WSL
        // agents lose the desktop's toolsets until the server restarts.
        void client.closed
          .then(
            () => undefined,
            () => undefined,
          )
          .then(() => {
            if (open.get(connection.key)?.client !== client) return
            open.get(connection.key)?.stop()
            if (closed || connection.backend.isOpen() === false) return
            log(`The desktop's tools stream to ${connection.name} closed; opening it again.`)
            reopen(connection, 0)
          })
        void sync(connection)
      },
      (error: unknown) => {
        log(
          `The desktop's tools could not be offered to ${connection.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
        // Tried again while the server is up, or its agents go without the
        // desktop's toolsets until it restarts.
        if (!closed && connection.backend.isOpen() !== false) reopen(connection, attempt)
      },
    )
  }

  return {
    close() {
      closed = true
      for (const entry of [...open.values()]) entry.stop()
    },
  }
}

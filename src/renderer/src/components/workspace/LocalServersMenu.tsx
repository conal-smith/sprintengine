import React, { useCallback, useRef, useState, type JSX } from 'react'

import type { StudioLocalServer, StudioLocalServerState } from '../../../../../packages/studio-protocol/src/public'
import { isLoopbackUrl } from '../../../../shared/browser'
import type { TailnetShareStatus } from '../../../../shared/tailnet-share'
import { clientSupports } from '../../clientCapabilities'
import { showToast } from '../../store/toastStore'
import { MenuDivider, MenuFlyoutItem, MenuItem, Popover, Tooltip, roveMenuFocus, type PopoverProps } from '../ui'
import { useOptionalConfirmDialog, type ConfirmDialogOptions } from '../ui/ConfirmDialog'
import { MENU_LIST_CLASS } from '../ui/menuClasses'
import { openUrlInPane } from './pane/browser/openInPane'
import { isLocalServerRunConfirmed, rememberLocalServerRun, type LocalServerRun } from './localServerRunConfirmations'
import { removeLocalServer, runLocalServer, stopLocalServer, type LocalServerActionResult } from './useLocalServers'

// The one menu for the local servers a conversation's agents started, opened
// from the open chat's composer strip and from the sidebar row's mark, so the
// two places agree about what a server offers.
//
// Each server says its state in a word — Running, Starting, Stopped — and,
// when a run the Studio started has ended, how it ended ("Exited with code 1")
// with the end of what it printed a click away. Then what can be done with it:
//
//   Open               in the workspace's own browser pane
//   Open in browser    the system browser
//   Copy link
//   Share on tailnet / Copy tailnet link
//                      a loopback URL only, and only while Tailscale is up
//                      here: `tailscale serve` publishes the port and hands
//                      back an https URL a phone on the tailnet can open
//   Run again          stopped, with the command the agent gave; the
//                      first run of a command, and any run after the agent
//                      changed it, asks the person first, showing the
//                      command and its folder
//   Stop               only a run the Studio started, while its process
//                      lives; an agent's own server
//                      belongs to the agent's process
//   Remove             forget the link
//
// Rows that cannot apply are left out rather than greyed, with one exception:
// "Run again" on a stopped server the agent gave no command for stays, off,
// and says why — that is the one a person reaches for and has to be told
// about.
//
// A server a chat on a paired machine linked is that machine's, drawn from
// what its list says (`elsewhere`): it is opened from here only where its
// address reaches here (a tailnet name, the machine's own address), and
// otherwise says it is on that machine, its link still to copy. Nothing that
// acts on a server (Share, Run again, Stop, Remove) is offered: each would
// act on this computer's own servers, or its own tailnet.
//
// One server lists its actions in the menu itself. Several list one row per
// server, each opening its actions beside it, so the menu stays as tall as
// the number of servers rather than six times it.

/** The state, in the word the strip, the mark and the menu all say. */
export function localServerStateWord(state: StudioLocalServerState): string {
  if (state === 'running') return 'Running'
  if (state === 'starting') return 'Starting'
  return 'Stopped'
}

/** How the Studio's last run of a stopped server ended; null when there is nothing to say. */
export function localServerExitLine(server: StudioLocalServer): string | null {
  if (server.state !== 'stopped' || !server.lastExit) return null
  return server.lastExit.code === null ? 'Ended by a signal' : `Exited with code ${server.lastExit.code}`
}

export type LocalServerActionId =
  'open' | 'open-external' | 'copy-link' | 'share-tailnet' | 'copy-tailnet-link' | 'run' | 'stop' | 'remove'

export type LocalServerAction = {
  id: LocalServerActionId
  label: string
  /** Off, and `reason` says why. */
  disabled?: boolean
  reason?: string
  destructive?: boolean
}

/** Why "Run again" is off for a server whose agent gave no command. */
export const NO_COMMAND_REASON = "The agent didn't say how to start it, so Studio can't run it again."

/**
 * Whether a server's address names the machine it runs on and nothing else:
 * its loopback (`localhost`, `127.0.0.1`, a `*.localhost` name), which from
 * another machine is that machine's own.
 */
export function localServerListensOnlyThere(url: string): boolean {
  if (isLoopbackUrl(url)) return true
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/u.test(host)
  } catch {
    return false
  }
}

/** Why a paired machine's server on its own loopback does not open here. */
export function onlyThereReason(machineName: string): string {
  return `It listens on ${machineName} only, so it opens there, not here.`
}

/**
 * What a server offers, in menu order (see the header). Pure, so the rules
 * are testable without a menu.
 *
 * @param context.tailnet What Tailscale said when the menu opened; null when it
 *   has not answered or this shell cannot ask.
 * @param context.canOpenInPane This shell has the in-app browser pane.
 * @param context.elsewhere The paired machine the server runs on, for a chat there.
 */
export function localServerActions(
  server: StudioLocalServer,
  context: { tailnet: TailnetShareStatus | null; canOpenInPane: boolean; elsewhere?: { machineName: string } },
): LocalServerAction[] {
  const actions: LocalServerAction[] = []
  if (context.elsewhere) {
    if (localServerListensOnlyThere(server.url))
      actions.push({
        id: 'open',
        label: 'Open',
        disabled: true,
        reason: onlyThereReason(context.elsewhere.machineName),
      })
    else {
      if (context.canOpenInPane) actions.push({ id: 'open', label: 'Open' })
      actions.push({ id: 'open-external', label: 'Open in browser' })
    }
    actions.push({ id: 'copy-link', label: 'Copy link' })
    return actions
  }
  if (context.canOpenInPane) actions.push({ id: 'open', label: 'Open' })
  actions.push({ id: 'open-external', label: 'Open in browser' }, { id: 'copy-link', label: 'Copy link' })
  if (context.tailnet?.available && isLoopbackUrl(server.url)) {
    const shared = context.tailnet.shares.some((share) => share.localPort === server.port)
    if (shared) actions.push({ id: 'copy-tailnet-link', label: 'Copy tailnet link' })
    else if (context.tailnet.ladderFull)
      actions.push({
        id: 'share-tailnet',
        label: 'Share on tailnet',
        disabled: true,
        reason: 'Every tailnet port Studio can publish on is taken. Stop sharing another server first.',
      })
    else actions.push({ id: 'share-tailnet', label: 'Share on tailnet' })
  }
  // A run the Studio started is stoppable for as long as its process lives,
  // whatever its port says: one that listens somewhere else, or takes longer
  // than the Studio waits, reads as stopped and still needs a way to end it.
  // It is not run again while it lives.
  if (server.state === 'stopped' && !server.startedByStudio) {
    actions.push(
      server.command
        ? { id: 'run', label: 'Run again' }
        : { id: 'run', label: 'Run again', disabled: true, reason: NO_COMMAND_REASON },
    )
  }
  if (server.startedByStudio) actions.push({ id: 'stop', label: 'Stop' })
  actions.push({ id: 'remove', label: 'Remove', destructive: true })
  return actions
}

/** Tailscale's view of this machine's shares, or null when this shell cannot ask (a browser tab) or it did not answer. */
async function readTailnetStatus(): Promise<TailnetShareStatus | null> {
  const api = typeof window === 'undefined' ? undefined : window.api
  if (typeof api?.tailnetShareStatus !== 'function') return null
  try {
    return await api.tailnetShareStatus()
  } catch {
    return null
  }
}

function sayFailure(title: string, result: LocalServerActionResult): void {
  if (!result.ok) showToast({ tone: 'error', title, description: result.message })
}

async function copy(text: string, title: string): Promise<void> {
  try {
    await window.api.clipboardWriteText(text)
    showToast({ tone: 'good', title })
  } catch (error) {
    showToast({
      tone: 'error',
      title: 'Could not copy the link',
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

async function openExternal(url: string): Promise<void> {
  try {
    const result = await window.api.openExternal(url)
    if (result && !result.ok)
      showToast({ tone: 'error', title: 'Could not open the link', description: result.message })
  } catch (error) {
    showToast({
      tone: 'error',
      title: 'Could not open the link',
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

/** What the person is shown before an agent's command runs as them: the command, and the folder. */
export function localServerRunQuestion(server: StudioLocalServer): ConfirmDialogOptions {
  return {
    title: `Run ${server.title}?`,
    body: (
      <div className="flex flex-col gap-2">
        <span>An agent gave Studio this command to start it. Studio runs it as you, in this folder.</span>
        <span className="break-all font-mono text-meta text-[color:var(--text-strong)]" data-local-server-confirm="">
          $ {server.command}
          <span className="block break-all text-[color:var(--text-subtle)]">
            in {server.cwd ?? 'the conversation’s folder'}
          </span>
        </span>
        <span className="text-[color:var(--text-subtle)]">You are asked again if the agent changes it.</span>
      </div>
    ),
    confirmLabel: 'Run',
  }
}

/**
 * Whether to go on with "Run again": at once for the command and folder the
 * person already agreed to run for this server, else once they agree now.
 */
async function confirmRun(
  server: StudioLocalServer,
  workspaceId: string,
  ask: (options: ConfirmDialogOptions) => Promise<boolean>,
): Promise<boolean> {
  if (!server.command) return false
  const run: LocalServerRun = {
    workspaceId,
    agentId: server.agentId,
    serverId: server.id,
    command: server.command,
    cwd: server.cwd ?? null,
  }
  if (isLocalServerRunConfirmed(run)) return true
  if (!(await ask(localServerRunQuestion(server)))) return false
  rememberLocalServerRun(run)
  return true
}

async function runAction(
  action: LocalServerActionId,
  server: StudioLocalServer,
  workspaceId: string,
  tailnet: TailnetShareStatus | null,
  ask: (options: ConfirmDialogOptions) => Promise<boolean>,
): Promise<void> {
  // Run, stop and remove name the conversation that linked the server, which
  // the server itself says: a sidebar row's servers can be several agents'.
  const owner = { workspaceId, agentId: server.agentId }
  switch (action) {
    case 'open':
      // The pane refuses when it cannot take another tab; the system browser
      // still can.
      if (!openUrlInPane(workspaceId, server.url)) await openExternal(server.url)
      return
    case 'open-external':
      await openExternal(server.url)
      return
    case 'copy-link':
      await copy(server.url, 'Link copied')
      return
    case 'copy-tailnet-link': {
      const url = tailnet?.shares.find((share) => share.localPort === server.port)?.url
      if (url) await copy(url, 'Tailnet link copied')
      return
    }
    case 'share-tailnet': {
      try {
        const result = await window.api.tailnetSharePort(server.port)
        if (result.ok && result.share) {
          // The link is what the person shares it for, so it is on the
          // clipboard already.
          await window.api.clipboardWriteText(result.share.url).catch(() => undefined)
          showToast({ tone: 'good', title: 'Shared on your tailnet — link copied', description: result.share.url })
        } else {
          showToast({
            tone: 'error',
            title: 'Could not share this server',
            description: result.ok ? 'Tailscale did not say where it is published.' : result.message,
          })
        }
      } catch {
        showToast({
          tone: 'error',
          title: 'Could not share this server',
          description: 'Studio could not reach Tailscale on this machine.',
        })
      }
      return
    }
    case 'run':
      if (!(await confirmRun(server, workspaceId, ask))) return
      sayFailure(`${server.title} did not start`, await runLocalServer(owner, server.id))
      return
    case 'stop':
      sayFailure(`${server.title} did not stop`, await stopLocalServer(owner, server.id))
      return
    case 'remove':
      sayFailure(`${server.title} was not removed`, await removeLocalServer(owner, server.id))
      return
  }
}

/** The state word's ink: a reinforcement of the word, never the message. */
const STATE_INK: Record<StudioLocalServerState, string> = {
  running: 'text-[color:var(--tone-good)]',
  starting: 'text-[color:var(--text-muted)]',
  stopped: 'text-[color:var(--text-subtle)]',
}

/** The state word, as the strip, the mark and the menu draw it. */
export function LocalServerStateWord({ state }: { state: StudioLocalServerState }): JSX.Element {
  return <span className={`shrink-0 whitespace-nowrap ${STATE_INK[state]}`}>{localServerStateWord(state)}</span>
}

type MenuProps = {
  /** The workspace whose browser pane "Open" uses. */
  workspaceId: string
  servers: readonly StudioLocalServer[]
  /** The menu's accessible name. */
  ariaLabel: string
  placement?: PopoverProps['placement']
  layer?: PopoverProps['layer']
  /** The face: the strip's button, the sidebar's mark. */
  renderTrigger: PopoverProps['renderTrigger']
  /** The paired machine the servers run on, for a chat there: read-only, opened from here where they reach. */
  elsewhere?: { machineName: string }
}

export function LocalServersMenu({
  workspaceId,
  servers,
  ariaLabel,
  placement = 'top-end',
  layer,
  renderTrigger,
  elsewhere,
}: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tailnet, setTailnet] = useState<TailnetShareStatus | null>(null)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const canOpenInPane = clientSupports('browser-pane')
  const dialog = useOptionalConfirmDialog()
  // Nowhere to ask, nothing an agent wrote runs: the click says so instead.
  const ask = useCallback(
    async (options: ConfirmDialogOptions): Promise<boolean> => {
      if (dialog) return dialog.confirm(options)
      showToast({
        tone: 'error',
        title: 'Could not ask before running it',
        description: 'Run it again from the Studio window.',
      })
      return false
    },
    [dialog],
  )

  /** Which opening the tailnet read in flight is for: a read from an earlier one is not drawn. */
  const openingRef = useRef(0)

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next) return
      // Read when the menu opens, never polled: shares live in the Tailscale
      // daemon and can change from a terminal, so a remembered answer would
      // offer to share what is already shared. The last opening's answer is
      // dropped at once, so nothing tailnet is offered until this one's lands.
      const opening = ++openingRef.current
      setTailnet(null)
      // A paired machine's servers are never shared from this one's tailnet.
      if (!elsewhere && servers.some((server) => isLoopbackUrl(server.url))) {
        void readTailnetStatus().then((status) => {
          if (openingRef.current === opening) setTailnet(status)
        })
      }
    },
    [servers, elsewhere],
  )

  const focusFirstItem = useCallback((surface: HTMLElement) => {
    surfaceRef.current = surface
    requestAnimationFrame(() => {
      surface.querySelector<HTMLButtonElement>('[data-menu-item="true"]:not([disabled])')?.focus()
    })
  }, [])

  const choose = (action: LocalServerActionId, server: StudioLocalServer) => {
    setOpen(false)
    void runAction(action, server, workspaceId, tailnet, ask)
  }

  const context = { tailnet, canOpenInPane, ...(elsewhere ? { elsewhere } : {}) }

  return (
    // The hosts are click targets of their own (a sidebar row selects its chat
    // on a click), and the surface is portalled but still a React child of
    // this span: the menu's clicks and keys end here.
    <span
      className="inline-flex min-w-0"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel={ariaLabel}
        popupRole="menu"
        placement={placement}
        layer={layer}
        surfaceClassName={`min-w-[240px] max-w-[360px] ${MENU_LIST_CLASS}`}
        onOpenAutoFocus={focusFirstItem}
        className="min-w-0"
        renderTrigger={renderTrigger}
      >
        <div role="none" onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}>
          {servers.length === 1 ? (
            <ServerSection server={servers[0]} context={context} onChoose={choose} />
          ) : (
            servers.map((server) => (
              <MenuFlyoutItem
                key={server.id}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{server.title}</span>
                    <LocalServerStateWord state={server.state} />
                  </span>
                }
                ariaLabel={`${server.title}, ${localServerStateWord(server.state)}`}
                surfaceClassName="min-w-[240px] max-w-[360px]"
              >
                <ServerSection server={server} context={context} onChoose={choose} />
              </MenuFlyoutItem>
            ))
          )}
        </div>
      </Popover>
    </span>
  )
}

/** One server: what it is and how it stands, then what it offers. */
function ServerSection({
  server,
  context,
  onChoose,
}: {
  server: StudioLocalServer
  context: Parameters<typeof localServerActions>[1]
  onChoose: (action: LocalServerActionId, server: StudioLocalServer) => void
}): JSX.Element {
  const [showOutput, setShowOutput] = useState(false)
  const exit = localServerExitLine(server)
  const output = exit ? server.lastExit?.output.trimEnd() : ''
  const actions = localServerActions(server, context)
  return (
    <>
      <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-1.5" data-local-server={server.id}>
        <span className="flex min-w-0 items-center gap-2 text-meta">
          <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--text-strong)]">{server.title}</span>
          <LocalServerStateWord state={server.state} />
        </span>
        {server.title !== hostOf(server.url) ? (
          <span className="truncate font-mono text-micro text-[color:var(--text-subtle)]">{server.url}</span>
        ) : null}
        {context.elsewhere ? (
          <span className="text-micro text-[color:var(--text-subtle)]" data-local-server-elsewhere="">
            On {context.elsewhere.machineName}
          </span>
        ) : null}
        {server.command ? (
          // What "Run again" runs, and where: the agent wrote it, so the
          // person sees it before they run it.
          <span className="break-all font-mono text-micro text-[color:var(--text-subtle)]" data-local-server-command="">
            $ {server.command}
            {server.cwd ? <span className="block truncate">in {server.cwd}</span> : null}
          </span>
        ) : null}
        {exit ? (
          <span
            className={`text-micro ${
              server.lastExit?.code === 0 ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--tone-error)]'
            }`}
            data-local-server-exit=""
          >
            {exit}
          </span>
        ) : null}
      </div>
      {output ? (
        <>
          <MenuItem expanded={showOutput} onClick={() => setShowOutput((shown) => !shown)}>
            {showOutput ? 'Hide output' : 'Show output'}
          </MenuItem>
          {showOutput ? (
            // The end of what the run printed, as it printed it. Selectable,
            // so a person can copy the error out of it.
            <pre
              className="mx-2.5 my-1 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded-sm bg-[color:var(--bg-well)] px-2 py-1.5 font-mono text-micro text-[color:var(--text-muted)]"
              data-local-server-output=""
            >
              {output}
            </pre>
          ) : null}
        </>
      ) : null}
      <MenuDivider />
      {actions.map((action) => {
        const item = (
          <MenuItem
            key={action.id}
            data-local-server-action={action.id}
            disabled={action.disabled}
            variant={action.destructive ? 'danger' : undefined}
            aria-label={action.reason ? `${action.label} — ${action.reason}` : undefined}
            onClick={() => onChoose(action.id, server)}
          >
            {action.label}
          </MenuItem>
        )
        return action.reason ? (
          <Tooltip key={action.id} content={action.reason} layer="menu" multiline wrapperClassName="flex">
            {item}
          </Tooltip>
        ) : (
          item
        )
      })}
    </>
  )
}

/** A URL's host and port, which is what a server's title falls back to. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

import type { TailnetPushPayload } from '../shared/tailnet'
import type { MeshEvent } from '../shared/tailnet-mesh'

// OS notifications for pairing and reachability (pair-from-the-scan-and-
// stay-paired, phase 3): the app's first use of the system notification
// centre, and deliberately a narrow one.
//
// The in-app toast fires regardless; this fires only when no Studio window is
// focused, so a request made from the other room is not five minutes of
// silence and an answer to one this machine made finds the person who asked.
// The comparison code never rides here — same rule as the toast: the code
// belongs beside the instruction to type it, on the acting surface.
//
// Pure: what to say is decided here from events alone, and the Electron
// `Notification` is injected, so the decisions are testable without a display.

export type TailnetNotice = {
  /** Stable per subject, so a later phase of the same request replaces rather than stacks. */
  key: string
  title: string
  body: string
}

export type TailnetNotifierOptions = {
  /** Whether any Studio window has focus; the person is already looking when one does. */
  isAnyWindowFocused: () => boolean
  /** Whether the person turned these off (Settings → Remote). */
  isEnabled: () => boolean
  /** Show one, and call `onClick` when the person clicks it. */
  show: (notice: TailnetNotice, onClick: () => void) => void
  /** Bring the app forward and open the Remote popover. */
  openRemote: () => void
}

export type TailnetNotifier = {
  onTailnetEvent(payload: TailnetPushPayload): void
  onMeshEvent(event: MeshEvent): void
}

export function createTailnetNotifier(options: TailnetNotifierOptions): TailnetNotifier {
  // Machines this app has already been told revoked it, so a pane retrying
  // against a locked door announces the lock once, not once per retry.
  const revokedAnnounced = new Set<string>()

  function deliver(notice: TailnetNotice | null): void {
    if (!notice) return
    if (!options.isEnabled()) return
    if (options.isAnyWindowFocused()) return
    options.show(notice, options.openRemote)
  }

  return {
    onTailnetEvent(payload): void {
      deliver(tailnetNotice(payload))
    },
    onMeshEvent(event): void {
      if (event.kind === 'machine-reachability') {
        // Reachable again clears the memory, so the NEXT revocation is news.
        if (event.reachable) {
          revokedAnnounced.delete(event.connectionId)
          return
        }
        if (!event.unauthorized || revokedAnnounced.has(event.connectionId)) return
        revokedAnnounced.add(event.connectionId)
      }
      if (event.kind === 'machine-forgotten') revokedAnnounced.delete(event.connectionId)
      deliver(meshNotice(event))
    },
  }
}

/** What an inbound event says, or null when it is not worth a system banner. */
export function tailnetNotice(payload: TailnetPushPayload): TailnetNotice | null {
  const event = payload.event
  if (event.kind !== 'pair-request' || event.phase !== 'received') return null
  const who = event.peerNode ?? event.deviceName
  if (event.oauth) {
    return {
      key: `pair-request:${event.requestId}`,
      title: `${event.deviceName} wants access to Studio`,
      body: 'An MCP client is signing in. Open Studio and enter the code its sign-in page shows to allow it.',
    }
  }
  return {
    key: `pair-request:${event.requestId}`,
    title: `Pair request from ${who}`,
    body: 'Open Studio to enter its code and allow it. It expires in five minutes.',
  }
}

/** What an outbound event says, or null when it is not worth a system banner. */
export function meshNotice(event: MeshEvent): TailnetNotice | null {
  if (event.kind === 'pair-request') {
    const key = `pair-request:${event.request.requestId}`
    const machine = event.request.machineName
    switch (event.phase) {
      case 'approved':
        return {
          key,
          title: `Paired with ${machine}`,
          body: event.request.reverseOffered
            ? 'Both ways. Its workspaces and chats are in the Mesh, and it can open this device.'
            : 'Its workspaces and chats are in the Mesh.',
        }
      case 'denied':
        return { key, title: `${machine} declined`, body: 'Someone there said no. Ask again when it suits.' }
      case 'expired':
        return { key, title: `${machine} did not answer in time`, body: 'Ask again when someone is at it.' }
      case 'failed':
        return { key, title: `Pairing with ${machine} did not complete`, body: event.detail ?? '' }
      default:
        return null
    }
  }
  if (event.kind === 'machine-reachability' && event.unauthorized) {
    return {
      key: `revoked:${event.connectionId}`,
      title: `${event.machineName} revoked this device`,
      body: 'Its pairing was taken back over there. Pair again from Settings → Remote when you want it back.',
    }
  }
  return null
}

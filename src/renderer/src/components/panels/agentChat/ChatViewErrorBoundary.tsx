// The chat view's own error boundary. A chat renders whatever its agent and
// its transport hand it: a malformed reply, an event of a shape nobody
// expected, a lazy chunk that failed to load. Any of those throwing during
// render used to unmount everything up to the root and leave a blank window.
// Here the failure stays in the chat's pane: it says the chat stopped, that
// nothing else did, and offers to draw the chat again from what the runtime
// holds, which is the same as reopening it.
//
// A chat's code arrives as a lazy chunk, and `React.lazy` keeps the first
// answer to its import, a failed one included, so drawing it again would only
// throw the same failure. The chat view is loaded through `reloadableLazy`,
// whose failed import Reload chat starts afresh, and a failure that is a
// chunk that would not load also offers to reload the window, which fetches
// every chunk again.

import React from 'react'

import { preloadableLazy } from '../../../utils/preloadableLazy'
import { GhostButton, InlineNotice } from '../../ui'

type ChatViewErrorBoundaryProps = {
  /** The chat shown; a different chat in the same pane starts clean. */
  chatKey: string
  children: React.ReactNode
}

type ChatViewErrorBoundaryState = { failed: boolean; detail: string | null; chunk: boolean }

const CLEAN: ChatViewErrorBoundaryState = { failed: false, detail: null, chunk: false }

// The ways a browser says a module or chunk did not load: Chromium, WebKit,
// Firefox, and a bundler's own chunk loader.
const CHUNK_FAILURE =
  /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|loading (css )?chunk \S+ failed/i

/** Whether what a chat threw is its code failing to load, rather than the chat failing to render. */
export function isChunkLoadFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === 'ChunkLoadError') return true
  const message = error instanceof Error ? error.message : String(error)
  return CHUNK_FAILURE.test(message)
}

// The reloadable lazy components whose import failed, each with what starts it afresh.
const failedLoads = new Set<() => void>()

/**
 * `React.lazy` whose import can be started again once it has failed. React
 * keeps a lazy component's first answer for good, so a chunk that failed to
 * load once (a dropped connection to the dev server, an update that replaced
 * the files) would fail every later render too. A failed one is swapped for a
 * fresh lazy component when the chat boundary's Reload chat asks
 * (`retryFailedLoads`), never by itself, so a chunk that keeps failing is not
 * fetched in a loop.
 *
 * Preloadable too (utils/preloadableLazy.tsx): New chat fetches the chat's
 * code while the person types, so the first chat a window opens draws at once
 * rather than through a fallback React holds for 300 ms.
 */
export function reloadableLazy<P extends object>(
  load: () => Promise<{ default: React.ComponentType<P> }>,
): React.ComponentType<P> & { preload(): void } {
  const fresh = () =>
    preloadableLazy<P>(() =>
      load().catch((error: unknown) => {
        failedLoads.add(renew)
        throw error
      }),
    )
  const renew = () => {
    current = fresh()
  }
  let current = fresh()
  function Reloadable(props: P) {
    const Current = current.Component
    return <Current {...props} />
  }
  Reloadable.preload = () => current.preload()
  return Reloadable
}

/** Start every failed reloadable import afresh on its next render. */
function retryFailedLoads(): void {
  for (const renew of failedLoads) renew()
  failedLoads.clear()
}

// What the chat threw, first line only and bounded: a message can carry a
// path or a payload, and the notice is not the place to read either whole.
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split('\n', 1)[0]?.trim() || 'The chat failed to render.').slice(0, 300)
}

export class ChatViewErrorBoundary extends React.Component<ChatViewErrorBoundaryProps, ChatViewErrorBoundaryState> {
  state: ChatViewErrorBoundaryState = CLEAN

  static getDerivedStateFromError(error: unknown): ChatViewErrorBoundaryState {
    return { failed: true, detail: describeError(error), chunk: isChunkLoadFailure(error) }
  }

  componentDidCatch(error: unknown): void {
    console.error('[chat] the chat view crashed', error)
  }

  componentDidUpdate(previous: ChatViewErrorBoundaryProps): void {
    // A pane that moves to another chat must not carry this one's failure.
    if (previous.chatKey !== this.props.chatKey && this.state.failed) {
      // oxlint-disable-next-line react/no-did-update-set-state -- guarded reset, runs once per switch
      this.setState(CLEAN)
    }
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <ChatViewErrorFallback
        detail={this.state.detail}
        onRetry={() => {
          retryFailedLoads()
          this.setState(CLEAN)
        }}
        {...(this.state.chunk ? { onReloadWindow: () => window.location.reload() } : {})}
      />
    )
  }
}

// Exported so the failure surface is testable without a real render error.
export function ChatViewErrorFallback({
  detail,
  onRetry,
  onReloadWindow,
}: {
  detail: string | null
  onRetry: () => void
  /** Offered when the chat's code did not load: reloading the window fetches it again. */
  onReloadWindow?: () => void
}) {
  return (
    <div className="p-3">
      <InlineNotice
        tone="error"
        title={
          onReloadWindow
            ? 'This chat could not load its code. The rest of the app is unaffected.'
            : 'This chat hit a problem and stopped. The rest of the app is unaffected.'
        }
        hint={
          onReloadWindow
            ? 'Reload the chat to try again, or reload the window if it keeps failing; its conversation is kept.'
            : 'Reload the chat to draw it again; its conversation is kept.'
        }
        {...(detail ? { detail } : {})}
        action={
          <>
            <GhostButton onClick={onRetry}>Reload chat</GhostButton>
            {onReloadWindow ? <GhostButton onClick={onReloadWindow}>Reload window</GhostButton> : null}
          </>
        }
      />
    </div>
  )
}

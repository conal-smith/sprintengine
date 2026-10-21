import { Terminal } from '@xterm/xterm'
import type { IDisposable, ILinkHandler } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

import { TERMINAL_RECENT_SCROLLBACK_LINES } from '../../../shared/terminal-history'
import { TERMINAL_CELL_GEOMETRY_OPTIONS, TERMINAL_UNICODE_VERSION } from '../../../shared/terminal-options'
import { currentCodeFontStack, followCodeFont } from './fonts'
import { logPerfEvent } from './perfDiagnostics'
import { attachTerminalOsc52Clipboard } from './terminalOsc52Clipboard'
import { createTerminalSearchHandle, type TerminalSearchHandle } from './terminalSearch'
import { watchTerminalScrolledAway } from './terminalScrollAway'
import { createTerminalOscLinkHandler, type TerminalOscLinkCallbacks } from './terminalOscLinks'
import { terminalSurfaceLinkRoots, type TerminalLinkRoots, type TerminalSurface } from './terminalSurfaces'
import { bindTerminalTheme, getTerminalTheme } from './terminalTheme'
import { attachWebglRenderer, type WebglRendererHandle, type WebglRendererState } from './terminalWebglRenderer'
import type { WebglBudgetLease } from './terminalWebglBudget'
import { readTerminalWebglPresence, terminalWebglBudget, watchTerminalPresence } from './terminalWebglPresence'

/**
 * One place constructs a terminal.
 *
 * Every item in the terminal-emulation-parity epic is an option, an addon or an
 * OSC handler, so each one either lands in all the panes at once or silently
 * diverges between them. Before this, four sites each held their own copy of
 * the same option literal.
 *
 * What this owns: the option block, the Unicode width table, the theme (and
 * its live re-tint binding), the font (and its live change from Settings), the scrollback, the fit addon, the
 * web-links addon, the write-only OSC 52 clipboard, the search addon, the WebGL
 * renderer and its context-loss fallback, the `linkHandler` every OSC 8
 * hyperlink goes through, OSC handler registration, and the watch that tells a
 * pane its viewport has been scrolled away from the newest output.
 *
 * What it deliberately does NOT own: `term.open()`, keyboard handlers, and the
 * file-link provider. Those are per-pane and, in the link provider's case,
 * ORDER-SENSITIVE — see `loadWebLinks` below.
 */

/**
 * The surface type and its one rule live in `terminalSurfaces.ts` — a leaf
 * module with no xterm import, so plain-Node tests can read the same rule this
 * factory does. Re-exported here because the panes already import the types
 * from this module.
 */
export type { TerminalLinkRoots, TerminalSurface } from './terminalSurfaces'

/** Handles a click on a URL the web-links addon matched. */
export type TerminalWebLinkHandler = (event: MouseEvent, uri: string) => void

/**
 * An OSC handler, keyed by its identifier (7 = cwd, 133 = shell integration).
 * Returning true marks the sequence handled, exactly as
 * `IParser.registerOscHandler` expects. Registered and disposed by the factory
 * so no pane has to remember to tear one down.
 *
 * OSC 52 is NOT in here: the clipboard is the same on every surface, so the
 * factory owns it outright rather than trusting each pane to pass a write-only
 * one (a pane that forgot would answer clipboard READ requests).
 */
export type TerminalOscHandlers = Readonly<Record<number, (data: string) => boolean | Promise<boolean>>>

export type CreateStudioTerminalInput = {
  surface: TerminalSurface
  /**
   * What a click on an OSC 8 hyperlink DOES. Required, and only the callbacks:
   * the gate itself is built here, so no pane can construct a terminal without
   * one.
   *
   * That is not hypothetical. A pane once passed no handler at all, and
   * xterm's `OscLinkProvider` falls back to its OWN `defaultActivate` — a
   * browser `confirm()` and a `window.open()`, which this app's
   * `setWindowOpenHandler` turns into `shell.openExternal` — so an http(s)
   * hyperlink printed in that pane opened in the user's browser without ever
   * passing `resolveTerminalOscLink`.
   */
  oscLinks: TerminalOscLinkCallbacks
  oscHandlers?: TerminalOscHandlers
  /** When given, `loadWebLinks()` becomes live; otherwise it is a no-op. */
  onWebLink?: TerminalWebLinkHandler
  /**
   * Hears each time the viewport is scrolled up away from the newest output,
   * or comes back to it — what a pane's "Jump to latest" control is shown for.
   * Only flips are reported (see `terminalScrollAway.ts`), so a pane can put
   * this straight into React state without re-rendering on every write.
   */
  onScrolledAwayChange?: (scrolledAway: boolean) => void
}

export type StudioTerminal = {
  terminal: Terminal
  fitAddon: FitAddon
  /** `terminalSurfaceLinkRoots(surface)`, resolved once so panes agree with the factory. */
  linkRoots: TerminalLinkRoots
  /**
   * Loads the web-links addon, if an `onWebLink` handler was given.
   *
   * Split out rather than done at construction because xterm resolves link
   * providers in REGISTRATION ORDER and a lower-indexed provider's links
   * suppress a higher-indexed provider's on the same row (`Linkifier`'s
   * `hasLinkBefore`). A pane that also registers a file-link provider must
   * register that one first, so the moment this addon loads belongs to the
   * pane, not to the factory. Idempotent: a second call does nothing.
   */
  loadWebLinks: () => void
  /**
   * Loads the search addon and returns the pane's find handle.
   *
   * Lazy and idempotent: a pane that is never searched never pays for the
   * addon, its decoration bookkeeping or its line cache, and the panes that
   * matter most here are the ones a user leaves open all day. Repeated calls
   * hand back a handle onto the same addon — the highlights of an open find
   * must not be split across two of them.
   */
  loadSearch: () => TerminalSearchHandle
  /**
   * Enrols the pane in the window's WebGL budget, which loads the WebGL
   * renderer while the pane is on screen, gives the context back when its
   * layer goes cold, and re-acquires one after a context loss — with the
   * fallback that keeps a lost context from blanking the pane in between.
   *
   * **Call it immediately after `term.open()`.** Split out for the same reason
   * the addon itself checks `terminal.element`: loaded against an unopened
   * terminal the addon defers into xterm's internal `onWillOpen`, and a
   * context failure then throws out of `term.open()` rather than out of here.
   * See `terminalWebglRenderer.ts`. Idempotent: a second call does nothing.
   */
  loadWebglRenderer: () => void
  /**
   * Follows the code font: once its face has loaded the terminal draws in it,
   * and again each time Settings ▸ Appearance changes it, without a reload.
   * `onApplied` runs after each change of face, which is the pane's moment to
   * fit — the cell size has changed under a container that has not. Call it
   * once, after `term.open()`; the subscription ends in `dispose`.
   */
  followCodeFont: (onApplied: () => void) => void
  /** Which renderer is painting this pane. `'webgl'` only while WebGL holds. */
  webglRendererState: () => WebglRendererState
  /**
   * Tears down everything the factory created, terminal included. Call it last
   * in a pane's cleanup — anything reading `terminal` must run before it.
   */
  dispose: () => void
}

export function createStudioTerminal({
  surface,
  oscLinks,
  oscHandlers,
  onWebLink,
  onScrolledAwayChange,
}: CreateStudioTerminalInput): StudioTerminal {
  const linkHandler: ILinkHandler = createTerminalOscLinkHandler(oscLinks)
  const terminal = new Terminal({
    ...TERMINAL_CELL_GEOMETRY_OPTIONS,
    theme: getTerminalTheme(),
    fontFamily: currentCodeFontStack(),
    // Kept in step with the size `waitForMonoFontReady` preloads: a terminal
    // that fits itself against a fallback face reflows once the real one lands.
    fontSize: 13,
    cursorBlink: true,
    scrollback: TERMINAL_RECENT_SCROLLBACK_LINES,
    linkHandler,
  })

  // Before anything is written: the width table decides where every row wraps,
  // and rows already in the buffer are not re-measured when it changes. Loaded
  // here rather than by each pane because the MAIN process's headless replay
  // terminal applies the same two lines (`terminal-replay-snapshot.ts`) — if
  // one side registers version 11 and the other stays on xterm's default 6, an
  // emoji is two columns on one side and one on the other, and a replayed
  // screen reflows away from the screen the user was looking at.
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION

  const unbindTerminalTheme = bindTerminalTheme(terminal)

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const oscDisposables: IDisposable[] = []
  for (const [identifier, handler] of Object.entries(oscHandlers ?? {})) {
    oscDisposables.push(terminal.parser.registerOscHandler(Number(identifier), handler))
  }

  // OSC 52 — a program asking the terminal to touch the system clipboard.
  //
  // Every surface gets it, agent and mesh included: copying is what the
  // sequence is FOR, and a pane attached to another machine is the canonical
  // case (it is how `ssh` + tmux put a remote buffer on your local clipboard).
  // The mesh rule the epic sets is about resolving local PATHS, which this
  // does not do.
  //
  // Registered LAST so its read guard sits in front of every other OSC 52
  // handler — xterm runs them in reverse registration order. Write only; see
  // `terminalOsc52Clipboard.ts` for why read is refused and how, twice.
  oscDisposables.push(attachTerminalOsc52Clipboard({ terminal }))

  const scrollAwayWatch = onScrolledAwayChange ? watchTerminalScrolledAway(terminal, onScrolledAwayChange) : null

  // WebGL is not loaded at mount any more: the window's budget hands a context
  // to this terminal while it is on screen, takes it back when its layer goes
  // cold or another on-screen terminal needs it, and re-acquires after a
  // context loss (terminalWebglBudget.ts). In between, xterm's DOM renderer
  // paints — which, for a pane nobody can see, is painting nothing.
  let webglRenderer: WebglRendererHandle | null = null
  let webglLease: WebglBudgetLease | null = null
  let unwatchPresence: (() => void) | null = null
  let webglState: WebglRendererState = 'not-loaded'
  let releasingForBudget = false
  // Which renderer a pane ended up on decides how to read every terminal
  // timing number, so it is recorded rather than silently absorbed — a
  // machine that always falls back is a machine whose profiles mean
  // something different.
  const recordRendererState = (state: WebglRendererState, error?: unknown): void => {
    webglState = state
    logPerfEvent('terminal', 'terminal-renderer', {
      surface: surface.kind,
      state,
      ...(error === undefined ? {} : { error: String(error) }),
    })
  }
  const attachWebgl = (): WebglRendererHandle =>
    attachWebglRenderer({
      terminal,
      createAddon: () => new WebglAddon(),
      onStateChange: (state, error) => {
        if (state === 'disposed' && releasingForBudget) {
          recordRendererState('released')
          return
        }
        recordRendererState(state, error)
        if (state === 'context-lost') webglLease?.contextLost()
      },
    })
  const loadWebglRenderer = (): void => {
    if (webglRenderer || webglLease) return
    const element = terminal.element
    if (!element) {
      // Records the ordering bug exactly as before; see terminalWebglRenderer.ts.
      webglRenderer = attachWebgl()
      return
    }
    webglLease = terminalWebglBudget.join({
      presence: () => readTerminalWebglPresence(terminal.element),
      attach: () => {
        webglRenderer = attachWebgl()
        const state = webglRenderer.state()
        if (state === 'webgl') return 'webgl'
        // A driver can fire the loss while the addon is still registering; the
        // loss handler has already scheduled the retry.
        return state === 'context-lost' ? 'lost' : 'unavailable'
      },
      detach: () => {
        releasingForBudget = true
        try {
          webglRenderer?.dispose()
        } finally {
          releasingForBudget = false
          webglRenderer = null
        }
      },
    })
    unwatchPresence = watchTerminalPresence(element, () => webglLease?.update())
    webglLease.update()
  }

  let searchAddon: SearchAddon | null = null
  let searchHandle: TerminalSearchHandle | null = null
  const loadSearch = (): TerminalSearchHandle => {
    if (!searchHandle) {
      searchAddon = new SearchAddon()
      terminal.loadAddon(searchAddon)
      searchHandle = createTerminalSearchHandle(searchAddon)
    }
    return searchHandle
  }

  let webLinksAddon: WebLinksAddon | null = null
  const loadWebLinks = (): void => {
    if (!onWebLink || webLinksAddon) return
    webLinksAddon = new WebLinksAddon(onWebLink)
    terminal.loadAddon(webLinksAddon)
  }

  let unfollowCodeFont: (() => void) | null = null
  const followCodeFontHere = (onApplied: () => void): void => {
    if (unfollowCodeFont) return
    unfollowCodeFont = followCodeFont((stack) => {
      // An unchanged family is no re-measure in xterm, so the first delivery —
      // the face the terminal was built with, now loaded — only fits.
      terminal.options.fontFamily = stack
      onApplied()
    })
  }

  return {
    terminal,
    fitAddon,
    linkRoots: terminalSurfaceLinkRoots(surface),
    loadWebLinks,
    loadSearch,
    followCodeFont: followCodeFontHere,
    loadWebglRenderer,
    webglRendererState: () => webglState,
    dispose: () => {
      unwatchPresence?.()
      unwatchPresence = null
      // Before the terminal: the addon's disposal reaches back into the
      // terminal's render service to put the DOM renderer back.
      webglRenderer?.dispose()
      // Then out of the budget, which hands the context this pane just freed
      // to an on-screen pane that was turned away.
      webglLease?.dispose()
      webglLease = null
      webLinksAddon?.dispose()
      searchAddon?.dispose()
      for (const disposable of oscDisposables) disposable.dispose()
      scrollAwayWatch?.dispose()
      unfollowCodeFont?.()
      unbindTerminalTheme()
      terminal.dispose()
    },
  }
}

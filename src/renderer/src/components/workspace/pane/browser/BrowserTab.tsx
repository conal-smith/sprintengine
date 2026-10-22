import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

import {
  BROWSER_PICK_START_CHANNEL,
  BROWSER_PICK_STOP_CHANNEL,
  BROWSER_WEBPREFERENCES,
  type BrowserConfig,
  type BrowserHostKey,
  type BrowserPickedElement,
  type BrowserTabState,
} from '../../../../../../shared/browser'
import {
  normalizeBrowserViewport,
  DEFAULT_BROWSER_DEVICE_PRESET_ID,
  fitViewportScale,
  guestLayoutSize,
  presetViewport,
  type BrowserViewport,
} from '../../../../../../shared/browser-devices'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import {
  FLOAT_DEFAULT_HEIGHT,
  FLOAT_DEFAULT_WIDTH,
  FLOAT_PAGE_WIDTH,
} from '../../../../store/slices/workspacePaneSlice'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import type { EmbeddedWebviewElement, WebviewIpcMessageEvent } from '../../../../types/webview'
import { showToast } from '../../../../store/toastStore'
import { AgentPill, IconButton, OverflowMenu, Tooltip } from '../../../ui'
import { BrowserDeviceToolbar } from './BrowserDeviceToolbar'
import { BrowserStartPage } from './BrowserStartPage'
import { BrowserErrorPage } from './BrowserErrorPage'
import { AgentBrowserCursor } from './AgentBrowserCursor'
import { BrowserToolbar, type BrowserToolbarHandle } from './BrowserToolbar'
import { BrowserViewMenu } from './BrowserViewMenu'
import { BrowserRecordingIndicator } from './BrowserRecordingIndicator'
import { useTabRecording } from './useTabRecording'
import { buildBrowserElementBlock, createPickGate, readPickTheme, sendTextToFocusedAgent } from './browserPick'
import { usePaneHost } from '../paneHost'
import { replayGuestFocusAsPress } from './guestPress'

// The browser tab (browser-pane epic): a `<webview>` guest the renderer mounts
// and main drives. The element is created once per tab and never re-keyed —
// its `src` is the tab's remembered URL at mount, and every later navigation
// goes through main (`browserNavigate`), which is also where the state shown
// here comes from (`onBrowserState`). Registration hands main the guest's
// WebContents id on `dom-ready`; main refuses anything that is not a guest of
// this window.
//
// Device emulation is sizing only (epic decision 7): with a viewport set, the
// guest is laid out at that CSS size and CSS-scaled to fit the tab body on a
// `bg.app` canvas behind a 1px frame.
//
// Floating, the tab is a miniature (FloatingPlayer): no toolbar, and the guest
// laid out at `FLOAT_PAGE_WIDTH` and CSS-scaled down to the player's width, the
// same transform the device frame uses. It is a picture of the page, so it
// takes no pointer; the player's overlay owns every press.

const NO_RECENT_URLS: readonly string[] = []
const FILL: BrowserViewport = { mode: 'fill' }
// Electron enables popups when the attribute is present at all. React 19 types it
// as a boolean, but React DOM drops `true` on an attribute it does not know, so
// the string goes through a spread the element's props type does not check.
const WEBVIEW_ALLOW_POPUPS: object = { allowpopups: 'true' }

// Breathing room around a framed viewport, so the frame reads as a device
// on a canvas rather than a page cut off at the edges.
const CANVAS_INSET_PX = 12
const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 2048

let configPromise: Promise<BrowserConfig> | null = null
/**
 * This computer's partition is asked once. A workspace on an SSH machine
 * asks every time a tab is made: main opens that machine's forward for it,
 * and lets it go after the machine's last tab (phase 8).
 */
function browserConfig(workspaceId: string, onMachine: boolean): Promise<BrowserConfig> {
  if (onMachine) return window.api.browserConfig({ workspaceId })
  configPromise ??= window.api.browserConfig().catch((error: unknown) => {
    // A failed read must not brick every later tab: forget it and retry.
    configPromise = null
    throw error
  })
  return configPromise
}

// Replays a chord the guest swallowed as a keydown on this window, so the
// app's own bindings (Primary+W, the palette, the pane toggle) act as if the
// person had typed it into the chrome.
function replayHostKey(key: BrowserHostKey): void {
  const code = key.key.length === 1 ? keyToCode(key.key) : key.key
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: key.key,
      code,
      metaKey: key.meta,
      ctrlKey: key.ctrl,
      altKey: key.alt,
      shiftKey: key.shift,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function keyToCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (key === '=' || key === '+') return 'Equal'
  if (key === '-') return 'Minus'
  return key
}

// The zoom chords, shared by the guest (via host-key) and the chrome.
function zoomDirectionFor(key: string, primary: boolean): 1 | -1 | 0 | null {
  if (!primary) return null
  if (key === '=' || key === '+') return 1
  if (key === '-') return -1
  if (key === '0') return 0
  return null
}

function InspectGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d="M3 3l5 12 1.8-4.7L14.5 8.5 3 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12.5 2.5v2M13.5 3.5h-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CameraGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path
        d="M2.5 5.5A1.5 1.5 0 0 1 4 4h1.5l1-1.5h3l1 1.5H12a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8.5" r="2.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

// The window's own zoom, re-read on `resize`: a zoom step changes the
// window's CSS viewport, so each one arrives as a resize.
function subscribeToWindowZoom(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

function readWindowZoom(): number {
  const zoom: unknown = window.api.getWindowZoomFactor?.()
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

type BrowserTabProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  active: boolean
}

export function BrowserTab({ workspaceId, tab, active }: BrowserTabProps) {
  const webviewRef = useRef<EmbeddedWebviewElement | null>(null)
  const toolbarRef = useRef<BrowserToolbarHandle | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [config, setConfig] = useState<BrowserConfig | null>(null)
  const [state, setState] = useState<BrowserTabState | null>(null)
  // An agent's recording of this tab is captured and encoded here, where the
  // guest is (browser.record_start).
  useTabRecording(tab.id, workspaceId)
  const [picking, setPicking] = useState(false)
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const windowZoom = useSyncExternalStore(subscribeToWindowZoom, readWindowZoom)
  // The URL the guest starts on. Read once: a later change to the tab record
  // (main reporting a navigation) must not re-navigate the guest.
  const initialSrcRef = useRef(tab.url && tab.url !== 'about:blank' ? tab.url : 'about:blank')
  const registeredRef = useRef(false)
  const updatePaneTab = useWorkspaceStore((s) => s.updatePaneTab)
  const setPaneTabFloating = useWorkspaceStore((s) => s.setPaneTabFloating)
  const paneHost = usePaneHost()
  const notePaneRecentUrl = useWorkspaceStore((s) => s.notePaneRecentUrl)
  const workspaceRoot = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const onMachine = useWorkspaceStore((s) => Boolean(s.workspaces.find((w) => w.id === workspaceId)?.environment))
  // A stable empty list: a selector minting `[]` per call is a new snapshot
  // every render, which zustand's useSyncExternalStore turns into an update
  // loop (React #185).
  const recentUrls = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.paneState?.recentUrls ?? NO_RECENT_URLS,
  )
  const viewport: BrowserViewport = tab.viewport ?? FILL
  const isPrimary = (event: { metaKey: boolean; ctrlKey: boolean }) =>
    window.api.platform === 'darwin' ? event.metaKey : event.ctrlKey

  useEffect(() => {
    let cancelled = false
    browserConfig(workspaceId, onMachine).then(
      (next) => {
        if (!cancelled) setConfig(next)
      },
      (error: unknown) => {
        if (!cancelled)
          showToast({
            tone: 'error',
            title: 'The browser could not start',
            ...(onMachine && error instanceof Error ? { description: error.message } : {}),
          })
      },
    )
    return () => {
      cancelled = true
    }
  }, [onMachine, workspaceId])

  // Register the guest with main once it exists, and let go when the tab
  // unmounts (the tab closing, or the workspace being torn down).
  useEffect(() => {
    const element = webviewRef.current
    if (!element || !config) return
    const tabId = tab.id
    const register = () => {
      if (registeredRef.current) return
      let webContentsId: number
      try {
        webContentsId = element.getWebContentsId()
      } catch {
        return
      }
      registeredRef.current = true
      void window.api.browserRegister({ tabId, workspaceId, webContentsId }).then((result) => {
        if (result.ok) setState(result.state)
        else {
          registeredRef.current = false
          showToast({ tone: 'error', title: 'The browser tab could not start', description: result.reason })
        }
      })
    }
    // A (re)attach is a new WebContents: forget the old registration so main
    // adopts the new guest instead of driving a dead one.
    const reattach = () => {
      registeredRef.current = false
      register()
    }
    element.addEventListener('dom-ready', register)
    element.addEventListener('did-attach', reattach)
    // The attach may already have happened before this effect ran (the
    // config arrives from a promise, after paint); try once eagerly —
    // getWebContentsId throws until the guest exists, and that is caught.
    register()
    return () => {
      element.removeEventListener('dom-ready', register)
      element.removeEventListener('did-attach', reattach)
      if (registeredRef.current) {
        registeredRef.current = false
        void window.api.browserUnregister(tabId)
      }
    }
  }, [config, tab.id, workspaceId])

  // Main's view of the tab, and the record the strip reads (title, URL,
  // favicon) — written only when the NORMALIZED value changed, so a loading
  // flicker or an over-long title never churns the persisted workspace.
  useEffect(() => {
    return window.api.onBrowserState((next) => {
      if (next.tabId !== tab.id) return
      setState(next)
      const url = next.url === 'about:blank' || next.url.length > MAX_URL_LENGTH ? undefined : next.url
      const title = next.title ? next.title.slice(0, MAX_TITLE_LENGTH) : undefined
      const faviconUrl = next.faviconUrl ?? undefined
      if (url !== tab.url || title !== tab.title || faviconUrl !== tab.faviconUrl) {
        updatePaneTab(workspaceId, tab.id, { url, title, faviconUrl })
      }
      // Recents are documents, not in-page moves: a hash-routed app is one
      // entry, not eight.
      const document = next.documentUrl
      if (document && document !== 'about:blank' && !next.loading && !next.error) {
        notePaneRecentUrl(workspaceId, document)
      }
    })
  }, [notePaneRecentUrl, tab.faviconUrl, tab.id, tab.title, tab.url, updatePaneTab, workspaceId])

  // Chords typed into the guest: Primary+L lands in the address field, the
  // zoom chords zoom this tab, the app-level ones replay on this window.
  useEffect(() => {
    const offFocus = window.api.onBrowserFocusUrl((payload) => {
      if (payload.tabId === tab.id) toolbarRef.current?.focusAddress()
    })
    const offKey = window.api.onBrowserHostKey((payload) => {
      if (payload.tabId !== tab.id) return
      const zoom = zoomDirectionFor(
        payload.key.key,
        window.api.platform === 'darwin' ? payload.key.meta : payload.key.ctrl,
      )
      if (zoom !== null) {
        void window.api.browserZoomStep(tab.id, zoom)
        return
      }
      replayHostKey(payload.key)
    })
    return () => {
      offFocus()
      offKey()
    }
  }, [tab.id])

  const miniature = tab.floating === true
  // The canvas the framed viewport, or the miniature, fits into. The miniature
  // fills it edge to edge; a device frame keeps an inset around it.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || (viewport.mode === 'fill' && !miniature)) return
    const inset = miniature ? 0 : CANVAS_INSET_PX
    const measure = () => {
      const rect = canvas.getBoundingClientRect()
      setCanvasSize({
        width: Math.max(0, rect.width - inset * 2),
        height: Math.max(0, rect.height - inset * 2),
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [miniature, viewport.mode])

  const navigate = useCallback(
    (url: string) => {
      void window.api.browserNavigate(tab.id, url)
    },
    [tab.id],
  )

  const setViewport = useCallback(
    (next: BrowserViewport) => {
      updatePaneTab(workspaceId, tab.id, { viewport: next.mode === 'fill' ? undefined : next })
    },
    [tab.id, updatePaneTab, workspaceId],
  )

  // browser.resize from an agent: the viewport is renderer-owned state, so main
  // asks this tab to change it rather than changing it.
  useEffect(
    () =>
      window.api.onBrowserViewportRequest((payload) => {
        if (payload.tabId !== tab.id) return
        const next = normalizeBrowserViewport(payload.viewport)
        if (next) setViewport(next)
      }),
    [setViewport, tab.id],
  )

  // ── Inspect ────────────────────────────────────────────────────────────
  // The picker runs in the guest preload; a pick comes back over the webview
  // channel, is cropped by main, and lands at the focused agent's prompt.
  // `webview.send` throws synchronously once the guest is gone (after a
  // renderer crash, before the next load); the picker is best-effort there.
  const sendToGuest = (channel: string, ...args: unknown[]): boolean => {
    try {
      void webviewRef.current?.send(channel, ...args)
      return true
    } catch {
      return false
    }
  }

  // Whether this tab asked for a pick and has not had its answer: a pick the
  // guest reports at any other time is not one anybody started, and is dropped.
  const pickGateRef = useRef(createPickGate())

  const stopPicking = useCallback(() => {
    pickGateRef.current.stop()
    setPicking(false)
    sendToGuest(BROWSER_PICK_STOP_CHANNEL)
  }, [])

  const startPicking = useCallback(() => {
    const element = webviewRef.current
    if (!element || !config?.preloadUrl) {
      showToast({ tone: 'warn', title: 'Inspect is not available in this build' })
      return
    }
    if (!sendToGuest(BROWSER_PICK_START_CHANNEL, readPickTheme())) return
    pickGateRef.current.start()
    setPicking(true)
    element.focus()
  }, [config?.preloadUrl])

  const handlePicked = useCallback(
    async (picked: BrowserPickedElement) => {
      setPicking(false)
      let screenshotPath: string | null = null
      if (workspaceRoot) {
        const capture = await window.api.browserCapture({ tabId: tab.id, rect: picked.rect, kind: 'element' })
        if (capture.ok) screenshotPath = capture.path
      }
      const block = buildBrowserElementBlock(picked, screenshotPath)
      const sent = await sendTextToFocusedAgent(workspaceId, block)
      if (sent.ok) {
        showToast({ tone: 'good', title: 'Element sent to the agent', description: picked.selector })
        return
      }
      await window.api.clipboardWriteText(block)
      showToast({
        tone: 'neutral',
        title: 'Element copied',
        description: sent.reason === 'no_agent' ? 'No agent is focused' : 'The focused agent has no live session',
      })
    },
    [tab.id, workspaceId, workspaceRoot],
  )

  useEffect(() => {
    const element = webviewRef.current
    if (!element) return
    const onMessage = (event: Event) => {
      const message = event as WebviewIpcMessageEvent
      // What a pick reports is the page's element, described by the page:
      // nothing in it is trusted as-is (the gate re-types and caps it).
      const outcome = pickGateRef.current.hear(message.channel, message.args)
      if (!outcome) return
      if (outcome.kind === 'picked') void handlePicked(outcome.element)
      else setPicking(false)
    }
    element.addEventListener('ipc-message', onMessage)
    return () => element.removeEventListener('ipc-message', onMessage)
  }, [handlePicked, config])

  // A click into the page closes whatever menu is open, as a click anywhere
  // else in the app does (guestPress.ts).
  useEffect(() => {
    const element = webviewRef.current
    if (!element) return
    return replayGuestFocusAsPress(element)
  }, [config])

  // A new document tears the picker down: the guest's overlay went with the
  // old one, and the host un-presses to match. Keyed on the committed
  // document, not `loading` — a lazy iframe flips `loading` without replacing
  // the page the person is picking from.
  const documentUrl = state?.documentUrl
  const pickingDocumentRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!picking) {
      pickingDocumentRef.current = undefined
      return
    }
    if (pickingDocumentRef.current === undefined) pickingDocumentRef.current = documentUrl
    else if (pickingDocumentRef.current !== documentUrl) stopPicking()
  }, [documentUrl, picking, stopPicking])

  // ── Screenshot ─────────────────────────────────────────────────────────
  const capturePage = useCallback(
    async (intent: 'copy' | 'save' | 'send') => {
      if (intent === 'copy') {
        const result = await window.api.browserCopyScreenshot(tab.id)
        showToast(
          result.ok
            ? { tone: 'good', title: 'Screenshot copied' }
            : { tone: 'error', title: 'Screenshot failed', description: result.message },
        )
        return
      }
      if (!workspaceRoot) {
        showToast({ tone: 'warn', title: 'Open a project folder to save screenshots' })
        return
      }
      const result = await window.api.browserCapture({ tabId: tab.id, kind: 'screenshot' })
      if (!result.ok) {
        showToast({ tone: 'error', title: 'Screenshot failed', description: result.message })
        return
      }
      const fileName = result.path.split('/').pop() ?? result.path
      if (intent === 'save') {
        showToast({ tone: 'good', title: 'Screenshot saved', description: fileName })
        return
      }
      const sent = await sendTextToFocusedAgent(workspaceId, `Look at the screenshot at ${result.path}`)
      if (sent.ok) showToast({ tone: 'good', title: 'Screenshot sent to the agent', description: fileName })
      else {
        await window.api.clipboardWriteText(result.path)
        showToast({ tone: 'neutral', title: 'Screenshot saved, path copied', description: 'No agent is focused' })
      }
    },
    [tab.id, workspaceId, workspaceRoot],
  )

  const hasPage = Boolean(state ? state.url && state.url !== 'about:blank' : initialSrcRef.current !== 'about:blank')
  // Inspect and Screenshot act on the document the person can see; over the
  // error page the guest holds a chrome-error document nobody is looking at.
  const canCapture = hasPage && !state?.error
  // Before the first state arrives, a restored tab is loading its remembered
  // page: no empty state over it.
  const showEmpty = state
    ? !state.error && (!state.url || state.url === 'about:blank')
    : initialSrcRef.current === 'about:blank'
  // The device frame waits while the tab floats, and comes back when it docks.
  const framed = !miniature && viewport.mode !== 'fill'
  // The guest's element is sized in this window's CSS px, which the window's
  // zoom stretches, so the device's size and the miniature's page width are
  // divided by it: the page is laid out at the size asked for at any zoom.
  const deviceSize = framed ? guestLayoutSize(viewport, windowZoom) : null
  const miniaturePageWidth = guestLayoutSize({ width: FLOAT_PAGE_WIDTH, height: 0 }, windowZoom).width
  // Before the first measure, the player's own width stands in for the canvas.
  const miniatureScale = (canvasSize.width > 0 ? canvasSize.width : FLOAT_DEFAULT_WIDTH) / miniaturePageWidth
  const scale = miniature ? miniatureScale : deviceSize ? fitViewportScale(deviceSize, canvasSize) : 1
  // The guest sits in ONE frame element in both modes; only the frame's
  // geometry changes. Moving a <webview> to another parent detaches and
  // re-attaches the guest, which reloads it from its initial `src` and gives
  // it a new WebContents main no longer knows.
  const frameStyle: React.CSSProperties = deviceSize
    ? {
        width: Math.round(deviceSize.width * scale),
        height: Math.round(deviceSize.height * scale),
        left: CANVAS_INSET_PX + Math.max(0, (canvasSize.width - deviceSize.width * scale) / 2),
        top: CANVAS_INSET_PX + Math.max(0, (canvasSize.height - deviceSize.height * scale) / 2),
      }
    : { inset: 0 }
  const guestStyle: React.CSSProperties = miniature
    ? {
        position: 'absolute',
        top: 0,
        left: 0,
        width: miniaturePageWidth,
        height: Math.round((canvasSize.height > 0 ? canvasSize.height : FLOAT_DEFAULT_HEIGHT) / miniatureScale),
        transform: `scale(${miniatureScale})`,
        transformOrigin: 'top left',
        display: 'flex',
        pointerEvents: 'none',
      }
    : deviceSize
      ? {
          position: 'absolute',
          top: 0,
          left: 0,
          width: deviceSize.width,
          height: deviceSize.height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          display: 'flex',
        }
      : { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'flex' }

  return (
    <div
      className="flex h-full w-full flex-col bg-[color:var(--bg-app)]"
      onKeyDown={(event) => {
        const zoom = zoomDirectionFor(event.key, isPrimary(event))
        if (zoom === null) return
        event.preventDefault()
        void window.api.browserZoomStep(tab.id, zoom)
      }}
    >
      {miniature ? null : (
        <BrowserToolbar
          ref={toolbarRef}
          state={state}
          onNavigate={navigate}
          onBack={() => void window.api.browserBack(tab.id)}
          onForward={() => void window.api.browserForward(tab.id)}
          onReload={() => void window.api.browserReload(tab.id)}
          onStop={() => void window.api.browserStop(tab.id)}
          onAfterSubmit={() => webviewRef.current?.focus()}
          onOpenExternal={() => {
            void window.api.browserOpenExternal(tab.id).then((result) => {
              if (!result.ok) showToast({ tone: 'warn', title: result.message })
            })
          }}
          trailing={
            <>
              {state?.controller === 'agent' ? (
                // The agent violet, as on the tab and round the surface (ui/AgentPresence.tsx).
                <span className="inline-flex shrink-0 whitespace-nowrap">
                  <span className="sr-only">An agent is driving this page</span>
                  <AgentPill />
                </span>
              ) : null}
              {state?.recording ? (
                <BrowserRecordingIndicator
                  recording={state.recording}
                  onStop={() => void window.api.browserStopRecording(tab.id)}
                />
              ) : null}
              <Tooltip content={picking ? 'Stop inspecting' : 'Inspect element'} placement="bottom">
                <IconButton
                  onClick={() => (picking ? stopPicking() : startPicking())}
                  aria-label={picking ? 'Stop inspecting' : 'Inspect element'}
                  pressed={picking}
                  disabled={!canCapture}
                >
                  <InspectGlyph />
                </IconButton>
              </Tooltip>
              {/* OverflowMenu draws the trigger button itself; a custom trigger is
                its CONTENT, never a second button inside it. One menu whatever
                the page state, so a focused trigger is never unmounted under
                the person; its items disable instead. */}
              <OverflowMenu
                ariaLabel="Screenshot"
                trigger={() => <CameraGlyph />}
                items={[
                  {
                    id: 'copy',
                    label: 'Copy screenshot',
                    onSelect: () => void capturePage('copy'),
                    disabled: !canCapture,
                  },
                  {
                    id: 'save',
                    label: 'Save to workspace',
                    onSelect: () => void capturePage('save'),
                    disabled: !canCapture || !workspaceRoot,
                  },
                  {
                    id: 'send',
                    label: 'Send to agent',
                    onSelect: () => void capturePage('send'),
                    disabled: !canCapture || !workspaceRoot,
                  },
                ]}
              />
              <BrowserViewMenu
                state={state}
                deviceToolbarOn={framed}
                onHardReload={() => void window.api.browserReload(tab.id, true)}
                onOpenDevTools={() => void window.api.browserOpenDevTools(tab.id)}
                onOpenWindow={() => void window.api.browserOpenWindow(tab.id)}
                onToggleDeviceToolbar={() =>
                  setViewport(viewport.mode === 'fill' ? presetViewport(DEFAULT_BROWSER_DEVICE_PRESET_ID) : FILL)
                }
                floating={tab.floating === true}
                // A pop-out window has no workspace beside it to float over; the
                // window itself is already what floating was for.
                onToggleFloating={
                  paneHost === 'pop-out'
                    ? undefined
                    : () => setPaneTabFloating(workspaceId, tab.id, tab.floating !== true)
                }
                onColorScheme={(scheme) => void window.api.browserSetColorScheme(tab.id, scheme)}
                onZoom={(direction) => void window.api.browserZoomStep(tab.id, direction)}
                onClearCookies={() => {
                  void window.api.browserClearCookies().then((result) => {
                    if (!result.ok) {
                      showToast({ tone: 'error', title: 'Cookies were not cleared', description: result.message })
                      return
                    }
                    showToast({ tone: 'good', title: 'Cookies cleared' })
                    void window.api.browserReload(tab.id)
                  })
                }}
                onClearCache={() => {
                  void window.api.browserClearCache().then((result) => {
                    if (!result.ok) {
                      showToast({ tone: 'error', title: 'The cache was not cleared', description: result.message })
                      return
                    }
                    showToast({ tone: 'good', title: 'Cache cleared' })
                    void window.api.browserReload(tab.id, true)
                  })
                }}
              />
            </>
          }
        />
      )}
      {framed ? (
        <BrowserDeviceToolbar viewport={viewport} onChange={setViewport} onClose={() => setViewport(FILL)} />
      ) : null}
      <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className={`absolute overflow-hidden ${
            framed ? 'border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]' : ''
          }`}
          style={frameStyle}
        >
          {config ? (
            <webview
              ref={webviewRef as React.Ref<EmbeddedWebviewElement>}
              src={initialSrcRef.current}
              partition={config.partition}
              webpreferences={BROWSER_WEBPREFERENCES}
              {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
              {...WEBVIEW_ALLOW_POPUPS}
              // Hidden under the empty state or the error page while either
              // shows, but never `visibility:hidden`: macOS blanks a hidden
              // guest for good.
              style={guestStyle}
              aria-label={`Web page for ${tab.title ?? 'this tab'}`}
              tabIndex={active && !miniature ? 0 : -1}
            />
          ) : null}
          {/* The agent's hand, drawn over the guest in the frame's own space so
              it scales with the device frame. A later sibling composites above
              the <webview>; no stacking tier is needed. */}
          <AgentBrowserCursor tabId={tab.id} scale={scale} controller={state?.controller ?? 'none'} />
        </div>
        {framed ? (
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-2 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]"
          >
            {viewport.width} × {viewport.height}
          </span>
        ) : null}
        {/* Neither page is drawn in the miniature: each is laid out for a
            pane, and at a thumbnail's size it would be a crop of its corner. */}
        {showEmpty && !miniature ? (
          <div className="absolute inset-0">
            <BrowserStartPage workspaceId={workspaceId} active={active} recentUrls={recentUrls} onOpen={navigate} />
          </div>
        ) : null}
        {state?.error && !miniature ? (
          <div className="absolute inset-0">
            <BrowserErrorPage error={state.error} onReload={() => void window.api.browserReload(tab.id)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

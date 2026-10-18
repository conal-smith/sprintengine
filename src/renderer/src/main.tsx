// First, before any other module can pull the canvas editor in behind it: the
// editor reads both window globals as its chunk evaluates. See canvasAssetPath.ts.
import './canvasAssetPath'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './assets/index.css'
import { ConfirmDialogProvider } from './components/ui'
import { SshPromptDialogHost } from './components/environments/SshPromptDialog'
import { ArtifactsSetupQuestionHost } from './components/settings/ArtifactsSetupQuestion'
import AuxWindowApp from './components/auxWindows/AuxWindowApp'
import WorkspaceManager from './components/workspace/WorkspaceManager'
import { RootErrorBoundary } from './components/workspace/RootErrorBoundary'
import { loadThirdPartyRendererModules } from './modules'
import { launchSettingsReady } from './store/workspaceStore'
import { reportBuildStamp } from './utils/buildStamp'
import { isBenignRendererError } from './utils/rendererErrors'
import { bindAltClickLinks } from './utils/altClickLinks'
import { bindElectronClipboardPasteBridge } from './utils/clipboardPasteBridge'
import { bindFocusSourceAttribute } from './utils/focusSource'
import { logPerfEvent, perfDiagnosticsEnabled } from './utils/perfDiagnostics'
import { markStartup, markStartupAt } from './utils/startupTimeline'
import { monacoReady } from './utils/monacoRuntime'
import { motionClock } from './utils/motionClock'
import { setTerminalRepaintPauseReporter } from './utils/terminalRepaintPause'
import { bindWindowActivityAttribute } from './utils/windowActivity'

// Boot measurement. `timeOrigin` is this document's navigation start,
// so the pair below brackets everything that happens before a line of app code
// runs: HTML parse, eager chunk fetch, compile and evaluate — Monaco's among
// them, since it is loaded here rather than on the first editor.
markStartupAt('renderer.navigation-start', performance.timeOrigin)
markStartup('renderer.script-start')

// The diagnostics window's content (process/IPC/memory panels + report
// formatter) is heavy and only mounts in the `?view=diagnostics` window, so keep
// it out of the eager boot chunk and fetch it when that window opens.
const DiagnosticsWindowApp = React.lazy(() => import('./components/diagnostics/DiagnosticsWindowApp'))

// Build identity, reported before anything else runs: if this document
// and main are on different commits, every IPC below is suspect, and the point
// is to say so rather than let each route fail its own way.
reportBuildStamp()

// An Electron paste quirk's workaround; in a browser it would stop a paste and then fail.
if (import.meta.env.STUDIO_CLIENT !== 'web') bindElectronClipboardPasteBridge()

// Chromium saves an Option-clicked link instead of opening it; the desktop app
// opens it in the browser like any other click. A browser tab keeps its own
// convention for the chord.
if (import.meta.env.STUDIO_CLIENT !== 'web') bindAltClickLinks()

// The modal repaint pause reports through `logPerfEvent` like everything else,
// but the store itself imports nothing: it is pulled into the xterm output
// queue, whose tests bundle without `import.meta.env` defined. Injecting the
// reporter here keeps that module dependency-free and keeps the perf events in
// the one rollup the diagnostics panel reads.
setTerminalRepaintPauseReporter(logPerfEvent)

// `data-window-active` on the root: the ambient "something is working" motion
// (index.css) pauses while this window is hidden or in the background.
bindWindowActivityAttribute()

// Every looping animation runs on one shared clock a few frames a second
// instead of at the display's refresh rate (utils/motionClock.ts).
motionClock()

// `data-focus-source` on the root: the focus ring is drawn only while the
// keyboard moved focus last (index.css), never around something just clicked.
bindFocusSourceAttribute()

window.addEventListener('error', (event) => {
  if (isBenignRendererError(event.message)) return
  console.error('[RendererError]', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  console.error('[RendererUnhandledRejection]', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

try {
  const longTaskThresholdMs = perfDiagnosticsEnabled() ? 75 : 250
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      if (entry.duration >= longTaskThresholdMs) {
        console.warn('[RendererLongTask]', {
          name: entry.name,
          durationMs: Math.round(entry.duration),
          startTimeMs: Math.round(entry.startTime),
        })
        logPerfEvent('Renderer', 'long-task', {
          name: entry.name,
          durationMs: Math.round(entry.duration),
          startTimeMs: Math.round(entry.startTime),
          thresholdMs: longTaskThresholdMs,
        })
      }
    })
  })
  observer.observe({ entryTypes: ['longtask'] })
} catch {
  // Long task entries are best-effort diagnostics.
}

// Trusted third-party renderer modules register before the first render so
// every consumer (panel factory, workspace-type picker, command pipeline,
// settings rail) sees a complete registry — the same eager-at-boot lifecycle
// bundled modules get. Bounded so a wedged IPC round-trip can never hold the
// window hostage: on timeout we render without third-party contributions and
// the gap shows up in Settings → Modules rather than as a blank window.
const THIRD_PARTY_MODULE_BOOT_TIMEOUT_MS = 3000

// Main owns the agent-launch settings, and the store's copy of them arrives
// over IPC. The workspace window waits for it so no picker renders a CLI or a
// permission preset the person never chose; bounded like the modules above, so
// a main that never answers costs a moment of defaults rather than a window.
function waitForLaunchSettings(): Promise<void> {
  return Promise.race([
    launchSettingsReady,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, THIRD_PARTY_MODULE_BOOT_TIMEOUT_MS)),
  ])
}

async function bootThirdPartyRendererModules(): Promise<void> {
  try {
    await Promise.race([
      loadThirdPartyRendererModules(),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, THIRD_PARTY_MODULE_BOOT_TIMEOUT_MS)),
    ])
  } catch (error) {
    console.error('[ThirdPartyModules] renderer entry loading failed', error)
  }
}

// Tell main the app is actually on screen, which is what closes the splash and
// reveals this window. Two nested rAFs: the first runs after React has committed
// the tree, the second after the browser has painted it — so the plate is not
// pulled away before there is something behind it. `ready-to-show` would have
// been too early, which is why main waits for this instead. Main also holds a
// hard timeout, so failing to get here delays the reveal rather than losing it.
let bootCompleteSignalled = false
function signalBootComplete(): void {
  if (bootCompleteSignalled) return
  bootCompleteSignalled = true
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      markStartup('renderer.first-paint')
      if (typeof window.api?.notifyBootComplete !== 'function') return
      window.api.notifyBootComplete()
    })
  })
}

// The diagnostics window loads the same renderer bundle with `?view=diagnostics`
// and mounts only the standalone panel — no workspace shell, no third-party
// module boot (it needs none, and skipping it makes the monitor window snappy).
const searchParams = new URLSearchParams(window.location.search)
const isDiagnosticsWindow = searchParams.get('view') === 'diagnostics'
// Auxiliary windows (diff viewer, external file editor) mount a dedicated root —
// no workspace shell, no third-party module boot — branching on `?aux=<kind>`.
const auxWindowKind = searchParams.get('aux')

if (isDiagnosticsWindow) {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <RootErrorBoundary>
      <ConfirmDialogProvider>
        <React.Suspense fallback={null}>
          <DiagnosticsWindowApp />
        </React.Suspense>
      </ConfirmDialogProvider>
    </RootErrorBoundary>,
  )
} else if (auxWindowKind) {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <RootErrorBoundary>
      <ConfirmDialogProvider>
        <AuxWindowApp />
      </ConfirmDialogProvider>
    </RootErrorBoundary>,
  )
} else {
  // Monaco is part of boot (utils/monacoRuntime.ts): the window is not revealed
  // until the editor runtime it may be asked to show is in hand.
  void Promise.all([bootThirdPartyRendererModules(), waitForLaunchSettings(), monacoReady]).then(() => {
    markStartup('renderer.third-party-modules-settled')
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <RootErrorBoundary>
        <ConfirmDialogProvider>
          <WorkspaceManager />
          <SshPromptDialogHost />
          <ArtifactsSetupQuestionHost />
        </ConfirmDialogProvider>
      </RootErrorBoundary>,
    )
    markStartup('renderer.root-rendered')
    // Only the primary workspace window reveals itself. The diagnostics and aux
    // branches above share this bundle but are opened by user action long after
    // boot — a boot-complete from one of them would be answering for a window
    // the splash was never covering.
    signalBootComplete()
  })
}

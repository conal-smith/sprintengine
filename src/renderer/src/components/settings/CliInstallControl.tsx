import { useCallback, useEffect, useRef, useState } from 'react'

import type { CliDetectResult, CliInstallMethodInfo, CliInstallResult } from '../../../../shared/electron-api'
import { LOCAL_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { useAnsiPlainText } from '../../hooks/useAnsiPlainText'
import { GhostButton, InlineNotice, LifecycleGlyph, PrimaryButton, Select, Spinner, type SelectItem } from '../ui'

export type CliInstallControlProps = {
  cli: string
  displayName: string
  binary: string
  command: string
  // The machine to detect and install on (Settings ▸ Machines binds a WSL
  // distribution here). Absent is this machine.
  hostId?: ExecutionHostId
  // Called after a successful install so the parent can persist the resolved
  // binary path (e.g. into cliRuntimes) and refresh any catalogs.
  onInstalled?: (result: CliInstallResult) => void
  // When false, the status text drops the CLI name (the surrounding row already
  // names it). Onboarding leaves it true since the control is the only label.
  showName?: boolean
  // When false, the control renders no status glyph, status text, or resolved
  // path — only its actions and the install flow. Hosts that wrap it in a
  // `ProviderRow` pass false: the row's health dot, mono version, and state line
  // already carry all three, and repeating them under the row is the same fact
  // twice in two vocabularies.
  showStatus?: boolean
  // When true (and the CLI is not installed), open the install method picker on
  // mount. Lets a parent's "Install" affordance jump straight into the flow.
  autoOpenInstall?: boolean
  // Host-driven mode. The control keeps the install ENGINE — methods,
  // selection, the streamed log — and gives up every affordance: no probe of its
  // own, no Re-check, no Install, no Run install, no Cancel. The host's single
  // row button is the only way in, and progress goes back up through
  // `onInstallStateChange` so the row can report it where the button already is.
  // Two identical Install buttons a few pixels apart is what this replaces, and
  // it is opt-in precisely so Settings → Agents — which owns no button of its
  // own — keeps the pair it renders today.
  hostDriven?: boolean
  // "An install is wanted and has not started yet." The host raises it from its
  // own Install button and drops it when the progress it gets back says the
  // install finished, so a row that is collapsed and reopened later does not
  // re-run an install it already ran. Only read in host-driven mode.
  installRequested?: boolean
  onInstallStateChange?: (progress: CliInstallProgress) => void
}

// What the host needs to render the install where its button already is: whether
// one is running, and which method it runs (the row's state line names it). A
// failure is deliberately NOT here — it stays in the disclosure, beside the log
// that explains it, rather than replacing what the row says about the CLI.
export type CliInstallProgress = {
  installing: boolean
  methodLabel: string | null
}

// The method a row installs when nobody picked one: the recommended one that can
// actually run, else anything that can, else the first — so the caller can still
// report WHY it cannot run rather than silently finding nothing.
function preferredMethodId(methods: CliInstallMethodInfo[]): string {
  const preferred =
    methods.find((method) => method.recommended && method.available) ??
    methods.find((method) => method.available) ??
    methods[0]
  return preferred?.id ?? ''
}

// Detect-and-install control for a single agent CLI. Reused by the onboarding
// "Set up an agent CLI" step and the Settings → Agents per-CLI rows. Detection
// and install run in the main process against the same command and machine the
// agent will launch with; install output streams live into the log.
export function CliInstallControl({
  cli,
  displayName,
  binary,
  command,
  hostId,
  onInstalled,
  showName = true,
  showStatus = true,
  autoOpenInstall = false,
  hostDriven = false,
  installRequested = false,
  onInstallStateChange,
}: CliInstallControlProps) {
  const [detect, setDetect] = useState<CliDetectResult | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [methods, setMethods] = useState<CliInstallMethodInfo[] | null>(null)
  const [selectedMethodId, setSelectedMethodId] = useState<string>('')
  const [installing, setInstalling] = useState(false)
  const [runningMethodLabel, setRunningMethodLabel] = useState<string | null>(null)
  const [log, setLog] = useState('')
  // What the installer printed, as a terminal would leave it: no escapes, and
  // a progress bar as its last frame.
  const plainLog = useAnsiPlainText(log)
  const [installError, setInstallError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const runDetect = useCallback(async () => {
    setDetecting(true)
    try {
      const result = await window.api.cliDetect(cli, { command, ...(hostId ? { hostId } : {}) })
      if (mountedRef.current) setDetect(result)
    } finally {
      if (mountedRef.current) setDetecting(false)
    }
  }, [cli, command, hostId])

  // Re-detect whenever the CLI or its command/WSL override changes. A host-driven
  // control never probes: the host already holds the availability answer it
  // renders the row from, and a second probe per row would be a second source of
  // truth for the same fact (and eight more shell spawns on a first-run card).
  useEffect(() => {
    if (hostDriven) {
      setDetecting(false)
      return
    }
    void runDetect()
  }, [hostDriven, runDetect])

  const openInstall = useCallback(async () => {
    setExpanded(true)
    setInstallError(null)
    setMethods(null)
    const available = await window.api.cliInstallMethods(cli, { command, ...(hostId ? { hostId } : {}) })
    if (!mountedRef.current) return
    setMethods(available)
    const preferred =
      available.find((method) => method.recommended && method.available) ??
      available.find((method) => method.available) ??
      available[0]
    setSelectedMethodId(preferred?.id ?? '')
  }, [cli, command, hostId])

  // The methods list, loaded once and kept: host-driven mode needs it to answer
  // "install the recommended one" the moment the row's button is pressed, and
  // re-asking on every press would put a spinner in front of an answer that has
  // not changed. Invalidated by the same inputs the list is resolved from.
  const methodsRef = useRef<CliInstallMethodInfo[] | null>(null)
  // One probe, however many callers want the list: the panel asks for it as it
  // opens and the install asks for it in the same commit when the press is what
  // opened the panel.
  const methodsInFlightRef = useRef<Promise<CliInstallMethodInfo[]> | null>(null)
  useEffect(() => {
    methodsRef.current = null
    methodsInFlightRef.current = null
  }, [cli, command, hostId])

  const loadMethods = useCallback(async (): Promise<CliInstallMethodInfo[]> => {
    if (methodsRef.current) return methodsRef.current
    if (methodsInFlightRef.current) return methodsInFlightRef.current
    const request = window.api.cliInstallMethods(cli, { command, ...(hostId ? { hostId } : {}) })
    methodsInFlightRef.current = request
    const available = await request.finally(() => {
      if (methodsInFlightRef.current === request) methodsInFlightRef.current = null
    })
    methodsRef.current = available
    if (mountedRef.current) {
      setMethods(available)
      // Only ever a default: a method the user picked themselves survives.
      setSelectedMethodId((current) => current || preferredMethodId(available))
    }
    return available
  }, [cli, command, hostId])

  // Host-driven rows show the method picker as soon as the disclosure can render
  // it, so opening the chevron does not sit on "Loading install options…".
  useEffect(() => {
    if (!hostDriven) return
    void loadMethods()
  }, [hostDriven, loadMethods])

  // Honor a parent's request to jump straight into the install flow once the
  // probe confirms the CLI is missing. Runs once per arming.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!autoOpenInstall) {
      autoOpenedRef.current = false
      return
    }
    if (autoOpenedRef.current || detecting || detect?.installed) return
    autoOpenedRef.current = true
    void openInstall()
  }, [autoOpenInstall, detecting, detect, openInstall])

  const runInstall = useCallback(async () => {
    // Settings runs this from a picker that is already populated and already
    // disabled on an unavailable method. A host-driven row runs it from a bare
    // button, so the method has to be resolved — and refused — here instead.
    const known = methodsRef.current ?? methods
    const available = known ?? (hostDriven ? await loadMethods() : null)
    if (!available || !mountedRef.current) return
    const fallbackId = preferredMethodId(available)
    const chosen =
      available.find((method) => method.id === selectedMethodId) ??
      available.find((method) => method.id === fallbackId) ??
      null
    if (!chosen) {
      setInstallError(`No automatic installer is available for ${displayName} on this platform.`)
      return
    }
    if (!chosen.available) {
      setInstallError(
        chosen.unavailableReason
          ? `${chosen.label} is unavailable — ${chosen.unavailableReason}`
          : `${chosen.label} is unavailable on this machine.`,
      )
      return
    }
    setSelectedMethodId(chosen.id)
    setRunningMethodLabel(chosen.label)
    setInstalling(true)
    setInstallError(null)
    setLog('')
    const unsubscribe = window.api.onCliInstallOutput(
      cli,
      (chunk) => {
        if (mountedRef.current) setLog((prev) => prev + chunk)
      },
      hostId,
    )
    try {
      const result = await window.api.cliInstall(
        { cli, methodId: chosen.id },
        { command, ...(hostId ? { hostId } : {}) },
      )
      if (!mountedRef.current) return
      if (result.installed) {
        setDetect({
          cli,
          binary,
          installed: true,
          version: result.version,
          resolvedPath: result.resolvedPath,
          hostId: hostId ?? LOCAL_HOST_ID,
          error: null,
        })
        setExpanded(false)
        onInstalled?.(result)
      } else {
        setInstallError(result.error ?? 'Install did not complete. See the log above.')
      }
    } catch (error) {
      if (mountedRef.current) {
        setInstallError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      unsubscribe()
      if (mountedRef.current) {
        setInstalling(false)
        setRunningMethodLabel(null)
      }
    }
  }, [cli, binary, command, displayName, hostId, hostDriven, loadMethods, methods, selectedMethodId, onInstalled])

  // The host's Install button is the only one in host-driven mode, so the request
  // to install arrives as a prop — including on the very mount the press causes,
  // since the disclosure this control lives in is what the press opens.
  const handledInstallRequestRef = useRef(false)
  useEffect(() => {
    if (!hostDriven) return
    if (!installRequested) {
      handledInstallRequestRef.current = false
      return
    }
    if (handledInstallRequestRef.current) return
    handledInstallRequestRef.current = true
    void runInstall()
  }, [hostDriven, installRequested, runInstall])

  // Progress goes back up so the row can render it where its button already is.
  // Through a ref because the host builds this callback inline per row: depending
  // on its identity would re-report on every render of the card.
  const installStateListenerRef = useRef(onInstallStateChange)
  useEffect(() => {
    installStateListenerRef.current = onInstallStateChange
  })
  useEffect(() => {
    if (!hostDriven) return
    installStateListenerRef.current?.({ installing, methodLabel: runningMethodLabel })
  }, [hostDriven, installing, runningMethodLabel])

  const installed = detect?.installed === true
  const versionSuffix = detect?.version ? ` · ${detect.version}` : ''
  // The surrounding row names the CLI when showName is false, so the status
  // text stays terse ("Detected · 1.2.3") instead of repeating the name.
  const statusText = detecting
    ? showName
      ? `Checking for ${binary}…`
      : 'Detecting…'
    : installed
      ? showName
        ? `${displayName} detected${versionSuffix}`
        : `Detected${versionSuffix}`
      : showName
        ? `${displayName} not found`
        : 'Not found'
  const methodItems: SelectItem[] = (methods ?? []).map((method) => ({
    value: method.id,
    label: method.available ? method.label : `${method.label} — ${method.unavailableReason ?? 'unavailable'}`,
    disabled: !method.available,
  }))
  const selectedMethod = (methods ?? []).find((method) => method.id === selectedMethodId) ?? null

  return (
    <div className={showStatus ? 'py-2.5' : ''}>
      <div className="flex items-center justify-between gap-3">
        {showStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            {detecting ? (
              <Spinner className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
            ) : (
              // Status reads by shape, not a bare dot: a quiet check when the CLI
              // is present, the warn "!" when it is missing. The adjacent text
              // names the state, so the glyph never carries meaning by colour alone.
              <LifecycleGlyph
                state={installed ? 'done' : 'needs_input'}
                label={installed ? `${displayName} detected` : `${displayName} not found`}
              />
            )}
            <span className="truncate text-body text-[color:var(--text-default)]">{statusText}</span>
          </div>
        ) : null}
        {/* Host-driven rows render no actions here at all: the row above owns the
            one Install button, and a second one under it is the duplicate this
            mode exists to remove. */}
        {!detecting && !hostDriven && (
          <div className="flex shrink-0 items-center gap-2">
            <GhostButton
              size="sm"
              onClick={() => void runDetect()}
              className="h-control-sm border border-[color:var(--border-default)] text-[color:var(--text-default)]"
            >
              Re-check
            </GhostButton>
            {!installed && !expanded && (
              <PrimaryButton size="sm" onClick={() => void openInstall()} className="h-control-sm">
                Install
              </PrimaryButton>
            )}
          </div>
        )}
      </div>

      {showStatus && installed && detect?.resolvedPath && (
        <div className="mt-1 pl-6 font-mono text-meta text-[color:var(--text-subtle)] truncate">
          {detect.resolvedPath}
        </div>
      )}

      {/* Host-driven: the disclosure this control lives in IS the panel's
          visibility, so it renders whenever it is mounted and draws no box of its
          own inside the row's own indent. */}
      {(hostDriven || (expanded && !installed)) && (
        <div
          className={
            hostDriven ? '' : 'mt-2.5 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] p-3'
          }
        >
          {methods === null ? (
            <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
              <Spinner className="icon-sm" /> Loading…
            </div>
          ) : methods.length === 0 ? (
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              No installer for this platform. Install{' '}
              <span className="font-mono text-[color:var(--text-default)]">{binary}</span> yourself, then set its path{' '}
              {hostDriven ? 'in Settings → Agents.' : 'above.'}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  ariaLabel={`${displayName} install method`}
                  items={methodItems}
                  value={selectedMethodId || null}
                  onChange={setSelectedMethodId}
                  disabled={installing}
                  className="min-w-[220px]"
                />
                {/* The chevron reveals "a different way", never a second
                    "start": host-driven, the picked method is all this panel
                    offers, and the row's button runs it. */}
                {hostDriven ? null : (
                  <>
                    <PrimaryButton
                      size="sm"
                      onClick={() => void runInstall()}
                      disabled={installing || !selectedMethod?.available}
                      className="h-control-md"
                    >
                      {installing ? 'Installing…' : 'Run install'}
                    </PrimaryButton>
                    {!installing && (
                      <GhostButton
                        size="sm"
                        onClick={() => setExpanded(false)}
                        className="h-control-md text-[color:var(--text-muted)]"
                      >
                        Cancel
                      </GhostButton>
                    )}
                  </>
                )}
              </div>

              {selectedMethod && !hostDriven && (
                <div className="mt-2">
                  <div className="mb-1 text-meta text-[color:var(--text-subtle)]">Will run:</div>
                  <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[color:var(--bg-app)] px-2.5 py-1.5 font-mono text-meta text-[color:var(--text-default)]">
                    {selectedMethod.commandPreview}
                  </pre>
                </div>
              )}

              {(installing || log) && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[color:var(--bg-app)] px-2.5 py-1.5 font-mono text-meta leading-[1.5] text-[color:var(--text-muted)]">
                  {plainLog || 'Starting…'}
                </pre>
              )}

              {installError && (
                <InlineNotice tone="error" className="mt-2">
                  {installError}
                </InlineNotice>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

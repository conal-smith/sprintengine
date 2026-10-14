import React, { useCallback, useEffect, useId, useState } from 'react'

import type {
  SshEnvironmentSettings,
  SshEnvironmentSummary,
  SshPaneTraffic,
  SshResolveResult,
} from '../../../../shared/ssh-environments'
import {
  ChipButton,
  GhostButton,
  InlineNotice,
  Input,
  OutlineButton,
  ProviderRow,
  ProviderStateId,
  Select,
  useConfirmDialog,
  WorkingMark,
} from '../ui'
import { sshMachineRef } from '../../hooks/useMachineIdentity'
import { MachineGhRow } from './MachineGhRow'
import { MachineMarkPicker, MachineRowMark } from './MachineMarkPicker'
import { SettingCard, SettingsRow, SettingsSectionTitle, SettingToggle } from './SettingsAtoms'
import { isImeKey } from '../../utils/imeKey'

// Settings › Machines › SSH machines (phase 8): the machines a person reaches
// over SSH, each a Studio server of its own. One field adds one: an alias
// from their SSH config or `user@host:port`, checked with `ssh -G` and shown
// resolved before anything connects. Each row says its state in words; the
// working mark shows only while a step runs. No status dots.

type Api = Pick<
  Window['api'],
  | 'sshEnvironmentsList'
  | 'sshEnvironmentResolve'
  | 'sshEnvironmentSuggestions'
  | 'sshEnvironmentAdd'
  | 'sshEnvironmentUpdate'
  | 'sshEnvironmentConnect'
  | 'sshEnvironmentDisconnect'
  | 'sshEnvironmentStopServer'
  | 'sshEnvironmentUpgradeServer'
  | 'sshEnvironmentForget'
  | 'sshEnvironmentDiagnostics'
  | 'onSshEnvironmentsChanged'
>

const PANE_TRAFFIC_ITEMS: Array<{ value: SshPaneTraffic; label: string }> = [
  { value: 'all', label: 'Everything, through the machine' },
  { value: 'loopback', label: 'Only its localhost' },
  { value: 'off', label: 'Nothing (tabs use this computer)' },
]

const ROW_FIELD = 'w-60 max-w-full font-mono'
const MUTED = 'text-body leading-5 text-[color:var(--text-muted)]'

/** The machine list, kept current from main's pushes. */
export function useSshMachines(api: Api | null = window.api): {
  machines: SshEnvironmentSummary[]
  reload: () => Promise<void>
} {
  const [machines, setMachines] = useState<SshEnvironmentSummary[]>([])
  const reload = useCallback(async () => {
    if (typeof api?.sshEnvironmentsList !== 'function') return
    const listed = await api.sshEnvironmentsList().catch(() => [])
    setMachines(Array.isArray(listed) ? listed : [])
  }, [api])
  useEffect(() => {
    void reload()
    const off =
      typeof api?.onSshEnvironmentsChanged === 'function' ? api.onSshEnvironmentsChanged(() => void reload()) : null
    return typeof off === 'function' ? off : undefined
  }, [api, reload])
  return { machines, reload }
}

export function SshMachinesSection({ api = window.api }: { api?: Api }): React.JSX.Element {
  const { machines } = useSshMachines(api)
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <section className="space-y-2">
      <SettingsSectionTitle count={machines.length}>SSH machines</SettingsSectionTitle>
      <p className={MUTED}>
        A machine you reach over SSH runs its own Studio server, which Studio installs and starts for you. Your SSH
        config, keys and agent are used as they are; Studio keeps no password or passphrase.
      </p>
      {machines.length > 0 ? (
        <SettingCard as="ul" ariaLabel="SSH machines">
          {machines.map((machine) => (
            <ProviderRow
              key={machine.id}
              as="li"
              surface="card"
              icon={
                machine.working ? (
                  <WorkingMark
                    label={`${machine.label}: ${machine.stateText}`}
                    seed={machine.id}
                    className="size-icon-lg"
                  />
                ) : (
                  <MachineRowMark machine={sshMachineRef(machine)} />
                )
              }
              recessed={machine.state === 'unsupported'}
              name={machine.label}
              version={machine.server ? machine.server.version : null}
              stateLine={machine.stateText}
              expanded={expanded === machine.id}
              onExpandedChange={(next) => setExpanded(next ? machine.id : null)}
              actions={
                <>
                  <MachineMarkPicker machine={sshMachineRef(machine)} name={machine.label} />
                  <MachineAction machine={machine} api={api} />
                </>
              }
            >
              <SshMachineDetail machine={machine} api={api} />
            </ProviderRow>
          ))}
        </SettingCard>
      ) : null}
      <AddSshMachine api={api} />
    </section>
  )
}

function MachineAction({ machine, api }: { machine: SshEnvironmentSummary; api: Api }): React.JSX.Element | null {
  const { confirm: confirmDialog } = useConfirmDialog()
  if (machine.state === 'connected')
    return (
      <OutlineButton
        size="xs"
        aria-label={`Disconnect, ${machine.label}`}
        onClick={() => void api.sshEnvironmentDisconnect(machine.id)}
      >
        Disconnect
      </OutlineButton>
    )
  if (machine.action === 'upgrade')
    return (
      <OutlineButton
        size="xs"
        aria-label={`Update the Studio server, ${machine.label}`}
        onClick={() =>
          void confirmDialog({
            title: `Update the Studio server on ${machine.label}?`,
            body: `It was started outside this app, and may be serving other clients. Its chats are given a minute to finish, then it is replaced by this app's version.`,
            confirmLabel: 'Update it',
          }).then((yes) => (yes ? api.sshEnvironmentUpgradeServer(machine.id) : undefined))
        }
      >
        Update
      </OutlineButton>
    )
  if (machine.working || machine.action !== 'connect') return null
  // A failure is the row's own state line; nothing more to say here.
  return (
    <OutlineButton
      size="xs"
      aria-label={`Connect, ${machine.label}`}
      onClick={() => void api.sshEnvironmentConnect(machine.id)}
    >
      Connect
    </OutlineButton>
  )
}

function SshMachineDetail({ machine, api }: { machine: SshEnvironmentSummary; api: Api }): React.JSX.Element {
  const { confirm: confirmDialog } = useConfirmDialog()
  const installId = useId()
  const [installDir, setInstallDir] = useState(machine.settings.installDir ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<string | null>(null)
  const write = (patch: Partial<SshEnvironmentSettings>) =>
    void api.sshEnvironmentUpdate(machine.id, patch).then((result) => setProblem(result.ok ? null : result.message))
  const resolved = machine.resolved
  return (
    <div className="space-y-4">
      {machine.notes.map((note) => (
        <p key={note} className={MUTED}>
          {note}
        </p>
      ))}
      {problem ? <InlineNotice tone="warn" title={problem} /> : null}
      {/* The machine's GitHub CLI, as its last connect found it: its chats
          open pull requests with it. Asked again on the next connect. */}
      {machine.gh ? (
        <SettingCard>
          <MachineGhRow
            as="div"
            status={machine.gh}
            machine={{ kind: 'ssh', os: machine.gh.os }}
            machineLabel={machine.label}
          />
        </SettingCard>
      ) : null}
      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingsRow
          label="Reached as"
          help="What your SSH config resolves it to. Your config decides; Studio only reads it."
        >
          <span className="font-mono text-body text-[color:var(--text-default)]">
            {resolved
              ? `${resolved.user}@${resolved.hostname}:${resolved.port}${resolved.proxyJump ? ` via ${resolved.proxyJump}` : ''}`
              : machine.destination}
          </span>
        </SettingsRow>
        {machine.server ? (
          <SettingsRow
            label="Studio server"
            help={
              machine.server.origin === 'bootstrap'
                ? `Started by ${machine.server.startedBy || 'Studio'}. It keeps running when you disconnect, so a chat left working carries on.`
                : 'Started outside this app; this app never stops or replaces it unasked.'
            }
          >
            <span className="font-mono text-body text-[color:var(--text-default)]">{machine.server.version}</span>
          </SettingsRow>
        ) : null}
        <SettingToggle
          label="Keep the server running"
          description="Otherwise it stops five minutes after the last client leaves with no chat working."
          enabled={machine.settings.keepRunning}
          onChange={(keepRunning) => write({ keepRunning })}
        />
        <SettingsRow
          label="Browser tabs' network"
          help={`What this machine's browser tabs reach through ${machine.label}. With everything, its localhost is the machine's.`}
        >
          <Select
            ariaLabel={`What browser tabs for ${machine.label} send through it`}
            items={PANE_TRAFFIC_ITEMS}
            value={machine.settings.paneTraffic}
            onChange={(paneTraffic) => write({ paneTraffic })}
          />
        </SettingsRow>
        <SettingToggle
          label="Download Node.js on the machine"
          description="For a machine on a faster network than this computer. Checked there against the digest this app pins."
          enabled={machine.settings.remoteDownload}
          onChange={(remoteDownload) => write({ remoteDownload })}
        />
        <SettingsRow
          label="Install directory"
          help="Only for a home mounted noexec: where the runtime and server go instead."
          htmlFor={installId}
        >
          <Input
            id={installId}
            value={installDir}
            onChange={(event) => setInstallDir(event.target.value)}
            onBlur={() => write({ installDir: installDir.trim() || null })}
            placeholder="~/.local/share/sprintengine-studio"
            size="md"
            variant="well"
            fullWidth={false}
            className={ROW_FIELD}
          />
        </SettingsRow>
      </div>
      <div className="flex flex-wrap gap-2">
        {machine.server?.origin === 'bootstrap' ? (
          <GhostButton
            size="sm"
            onClick={() =>
              void confirmDialog({
                title: `Stop the Studio server on ${machine.label}?`,
                body: 'Chats still working there get a minute to finish first.',
                confirmLabel: 'Stop it',
                tone: 'danger',
              }).then((yes) => (yes ? api.sshEnvironmentStopServer(machine.id) : undefined))
            }
          >
            Stop server on {machine.label}
          </GhostButton>
        ) : null}
        <GhostButton
          size="sm"
          onClick={() =>
            void api
              .sshEnvironmentDiagnostics(machine.id)
              .then((result) => setDiagnostics(result.ok ? result.text : result.message))
          }
        >
          Diagnostics
        </GhostButton>
        <GhostButton
          size="sm"
          onClick={() =>
            void confirmDialog({
              title: `Forget ${machine.label}?`,
              body: 'Its chats stay on the machine. Its Studio server keeps running there, and stops on its own when idle.',
              confirmLabel: 'Forget',
              tone: 'danger',
            }).then((yes) => (yes ? api.sshEnvironmentForget(machine.id) : undefined))
          }
        >
          Forget
        </GhostButton>
      </div>
      {diagnostics ? (
        <pre className="whitespace-pre-wrap break-words rounded-md border border-[color:var(--border-subtle)] px-3 py-2 font-mono text-meta text-[color:var(--text-default)]">
          {diagnostics}
        </pre>
      ) : null}
    </div>
  )
}

function AddSshMachine({ api }: { api: Api }): React.JSX.Element {
  const fieldId = useId()
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [checked, setChecked] = useState<SshResolveResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (typeof api.sshEnvironmentSuggestions !== 'function') return
    void Promise.resolve(api.sshEnvironmentSuggestions())
      .then((names) => setSuggestions(Array.isArray(names) ? names : []))
      .catch(() => undefined)
  }, [api])
  const check = async (value: string) => {
    setError(null)
    setBusy(true)
    try {
      setChecked(await api.sshEnvironmentResolve(value))
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    setBusy(true)
    try {
      const result = await api.sshEnvironmentAdd({ destination: text })
      if (!result.ok) setError(result.message)
      else {
        setText('')
        setChecked(null)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <SettingsRow label="Add SSH machine" help="An alias from your SSH config, or user@host:port." htmlFor={fieldId}>
        <span className="flex items-center gap-2">
          <Input
            id={fieldId}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setChecked(null)
            }}
            onKeyDown={(event) => {
              if (isImeKey(event)) return
              if (event.key === 'Enter' && text.trim()) void check(text)
            }}
            placeholder="build-box"
            size="md"
            variant="well"
            fullWidth={false}
            className={ROW_FIELD}
          />
          <OutlineButton size="sm" disabled={busy || !text.trim()} onClick={() => void check(text)}>
            Check
          </OutlineButton>
        </span>
      </SettingsRow>
      {suggestions.length > 0 && !text ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className={MUTED}>From your SSH config:</span>
          {suggestions.slice(0, 12).map((name) => (
            <ChipButton
              key={name}
              onClick={() => {
                setText(name)
                void check(name)
              }}
            >
              {name}
            </ChipButton>
          ))}
        </div>
      ) : null}
      {checked && !checked.ok ? <InlineNotice tone="warn" title={checked.message} /> : null}
      {checked?.ok ? (
        <div className="space-y-2">
          <p className={MUTED}>
            Studio will connect to{' '}
            <ProviderStateId>
              {checked.resolved.user}@{checked.resolved.hostname}:{checked.resolved.port}
            </ProviderStateId>
            {checked.resolved.proxyJump ? (
              <>
                {' '}
                through <ProviderStateId>{checked.resolved.proxyJump}</ProviderStateId>
              </>
            ) : null}
            . On the first connection, SSH shows the machine's fingerprint for you to check.
          </p>
          {checked.resolved.notes.map((note) => (
            <p key={note} className={MUTED}>
              {note}
            </p>
          ))}
          <OutlineButton size="sm" disabled={busy} onClick={() => void add()}>
            Add {checked.destination}
          </OutlineButton>
        </div>
      ) : null}
      {error ? <InlineNotice tone="warn" title={error} /> : null}
    </div>
  )
}

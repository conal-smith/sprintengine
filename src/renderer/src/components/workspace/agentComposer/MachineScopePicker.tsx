import React from 'react'

import { LOCAL_HOST_ID, type ExecutionHostId, type ExecutionHostSummary } from '../../../../../shared/execution-host'
import type { MachineRef } from '../../../../../shared/machine-identity'
import type { SshEnvironmentSummary } from '../../../../../shared/ssh-environments'
import type { MeshConnection } from '../../../../../shared/tailnet-mesh'
import { hostMachineRef, sshMachineRef, useMachineIdentity } from '../../../hooks/useMachineIdentity'
import { RemoteMachineGlyph } from '../../AppIcons'
import { ChipButton, MachineGlyph, MENU_LIST_CLASS, MenuOption, Popover } from '../../ui'
import { MENU_GROUP_LABEL_CLASS } from '../../ui/menuClasses'
import { ChipCaretGlyph, menuRadioRowKeyDown } from './agentSpawnShared'
import type { MachineAvailability } from './newChatMachines'

/**
 * A machine's mark in a menu row's leading slot, or the empty slot the width of
 * one for this computer, which wears none (owner ruling 2026-10-04).
 */
function MachineSlot({ machine, className = 'icon-xs shrink-0' }: { machine: MachineRef; className?: string }) {
  const identity = useMachineIdentity(machine)
  return identity ? (
    <MachineGlyph identity={identity} className={className} />
  ) : (
    <span aria-hidden="true" className={className} />
  )
}

/** The trigger's mark: the picked machine's, and nothing for this computer. */
function TriggerMachineMark({ machine }: { machine: MachineRef }) {
  const identity = useMachineIdentity(machine)
  return identity ? <MachineGlyph identity={identity} /> : null
}

/**
 * The machine a scheduled agent being edited runs on, as a line and not a
 * choice: a schedule stays on the machine it was saved on. Drawn as the
 * trigger is, its mark and its name, so the strip reads the same.
 */
export function FixedMachineLine({ machineName }: { machineName: string }) {
  return (
    <span
      data-machine-line="true"
      className="inline-flex h-control-xs min-w-0 items-center gap-1.5 px-2 text-meta text-[color:var(--text-subtle)]"
    >
      <TriggerMachineMark machine={{ kind: 'paired', name: machineName }} />
      <span className="min-w-0 truncate">{machineName}</span>
    </span>
  )
}

/**
 * The machine dropdown (remote-sessions-ux / new-chat-on-a-remote-machine):
 * This device is the first entry and the default; every other machine follows
 * wearing its own mark — its kind's drawing in its colour (owner ruling
 * 2026-10-04) — under "Other machines". One dropdown — the owner rejected a
 * separate Local/Remote switch as redundant.
 *
 * On Windows the machines on THIS computer lead it (owner decision
 * 2026-09-24): "This PC (Windows)", then each WSL distribution turned on in
 * Settings ▸ Machines ("WSL: Ubuntu", the default one marked), then a divider
 * and the paired machines. With one machine here (macOS, Linux, or Windows
 * with no distribution turned on) the first row is the "This device" it
 * always was.
 */
export function MachineScopePicker({
  machines,
  selected,
  onSelect,
  sshMachines = [],
  selectedSshId = null,
  onSelectSsh,
  localHosts = [],
  selectedHostId = LOCAL_HOST_ID,
  onSelectHost,
  hostDisabledReason,
  availability,
  onOpen,
  projectName,
}: {
  machines: MeshConnection[]
  selected: MeshConnection | null
  onSelect: (connection: MeshConnection | null) => void
  /** This computer's machines, this one first. One entry (or none) draws the plain "This device" row. */
  localHosts?: ExecutionHostSummary[]
  selectedHostId?: ExecutionHostId
  onSelectHost?: (hostId: ExecutionHostId) => void
  /** Why a machine here cannot be picked right now, or null. */
  hostDisabledReason?: (host: ExecutionHostSummary) => string | null
  /** Whether each machine holds the project in hand (one-project-across-machines); `none` lists it plainly. */
  availability?: (machine: MeshConnection) => MachineAvailability
  onOpen?: () => void
  /** The project in hand, named in the dimmed rows' reasons and the list's heading. */
  projectName?: string | null
  /** SSH machines (phase 8), after this computer's: each its own Studio server. */
  sshMachines?: SshEnvironmentSummary[]
  selectedSshId?: string | null
  onSelectSsh?: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const selectedSsh = sshMachines.find((machine) => machine.id === selectedSshId) ?? null
  const availabilityOf = (machine: MeshConnection): MachineAvailability => availability?.(machine) ?? { state: 'none' }
  const chosen = (machine: MeshConnection): boolean => {
    const state = availabilityOf(machine).state
    return state !== 'lacks' && state !== 'unreachable'
  }
  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, activate: () => void) =>
    menuRadioRowKeyDown(event, '[data-machine-option="true"]', activate)
  const hostRows = localHosts.length > 1 ? localHosts : []
  const selectedHost = selected || selectedSsh ? null : (hostRows.find((host) => host.id === selectedHostId) ?? null)
  // The machine the trigger names, as its mark knows it. This computer has none.
  const selectedRef: MachineRef = selected
    ? { kind: 'paired', name: selected.machineName }
    : selectedSsh
      ? sshMachineRef(selectedSsh)
      : hostMachineRef(selectedHost?.id ?? null)
  const localSelected =
    selected === null && selectedSsh === null && (hostRows.length === 0 || selectedHostId === LOCAL_HOST_ID)
  // This machine can be ruled out too: a folder inside a distribution runs there.
  const localReason = hostRows[0] ? (hostDisabledReason?.(hostRows[0]) ?? null) : null
  const activateLocal = (): void => {
    if (localReason) return
    if (hostRows.length > 0) onSelectHost?.(LOCAL_HOST_ID)
    else onSelect(null)
    setOpen(false)
  }
  const focusChecked = React.useCallback((surface: HTMLElement) => {
    const target =
      surface.querySelector<HTMLButtonElement>('[data-machine-option="true"][aria-checked="true"]:not([disabled])') ??
      surface.querySelector<HTMLButtonElement>('[data-machine-option="true"]:not([disabled])')
    target?.focus()
    if (target && document.activeElement !== target) {
      requestAnimationFrame(() => {
        if (surface.isConnected) target.focus()
      })
    }
  }, [])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
      ariaLabel="Machine this chat runs on"
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusChecked}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The kit's quiet chip, the context strip's control (owner ruling
        // 2026-10-04): the machine's own mark, its name and the caret.
        <ChipButton ref={ref} variant="raised" onClick={togglePopover} data-machine-trigger="true" {...triggerProps}>
          <TriggerMachineMark machine={selectedRef} />
          {selected
            ? selected.machineName
            : selectedSsh
              ? selectedSsh.label
              : selectedHost && hostRows.length > 0
                ? selectedHost.label
                : 'This device'}
          <ChipCaretGlyph />
        </ChipButton>
      )}
    >
      {/* The surface is the menu; these are its rows. The leading slot is
          all-or-nothing per the menu spec, so This device renders an empty slot
          the width of the machine glyph rather than sliding its label left. */}
      <MenuOption
        role="menuitemradio"
        selected={localSelected}
        stacked={Boolean(localReason)}
        disabled={Boolean(localReason)}
        data-machine-option="true"
        tabIndex={localSelected ? 0 : -1}
        onKeyDown={(event) => rowKey(event, activateLocal)}
        onClick={activateLocal}
        icon={<span aria-hidden="true" className="icon-xs shrink-0" />}
      >
        {localReason ? (
          <>
            <span className="block truncate text-body font-medium">{hostRows[0]?.label}</span>
            <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{localReason}</span>
          </>
        ) : (
          (hostRows[0]?.label ?? 'This device')
        )}
      </MenuOption>
      {hostRows
        .filter((host) => host.id !== LOCAL_HOST_ID)
        .map((host) => {
          const reason = hostDisabledReason?.(host) ?? null
          const isSelected = selected === null && host.id === selectedHostId
          const activate = () => {
            if (reason) return
            onSelectHost?.(host.id)
            setOpen(false)
          }
          return (
            <MenuOption
              key={host.id}
              role="menuitemradio"
              selected={isSelected}
              stacked={Boolean(reason)}
              disabled={Boolean(reason)}
              data-machine-option="true"
              data-machine-host={host.id}
              tabIndex={isSelected ? 0 : -1}
              onKeyDown={(event) => rowKey(event, activate)}
              onClick={activate}
              icon={
                <MachineSlot
                  machine={hostMachineRef(host.id)}
                  className={`icon-xs shrink-0${reason ? ' mt-0.5' : ''}`}
                />
              }
              trailing={
                !reason && host.isDefaultDistro ? (
                  <span className="shrink-0 text-micro text-[color:var(--text-disabled)]">default</span>
                ) : null
              }
            >
              <span className={reason ? 'block truncate text-body font-medium' : 'block truncate'}>{host.label}</span>
              {reason ? (
                <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{reason}</span>
              ) : null}
            </MenuOption>
          )
        })}
      {/* Every machine not on this computer, under the one mark that means
          "another machine" in general. */}
      {sshMachines.length > 0 || machines.length > 0 ? (
        <div className={`${MENU_GROUP_LABEL_CLASS} flex items-center gap-1.5 pb-1 pt-2`}>
          <RemoteMachineGlyph className="icon-xs shrink-0" />
          Other machines
        </div>
      ) : null}
      {sshMachines.map((machine) => {
        // A machine Studio cannot run on, or whose server this app cannot
        // speak to, is listed with why, and cannot be picked.
        const reason = machine.state === 'unsupported' || machine.state === 'version-blocked' ? machine.stateText : null
        const isSelected = selected === null && machine.id === selectedSshId
        const hint = reason ?? (machine.state === 'connected' ? null : machine.stateText)
        const activate = () => {
          if (reason) return
          onSelectSsh?.(machine.id)
          setOpen(false)
        }
        return (
          <MenuOption
            key={machine.id}
            role="menuitemradio"
            selected={isSelected}
            stacked={Boolean(hint)}
            disabled={Boolean(reason)}
            data-machine-option="true"
            data-machine-ssh={machine.id}
            tabIndex={isSelected ? 0 : -1}
            onKeyDown={(event) => rowKey(event, activate)}
            onClick={activate}
            icon={
              <MachineSlot machine={sshMachineRef(machine)} className={`icon-xs shrink-0${hint ? ' mt-0.5' : ''}`} />
            }
          >
            <span className={hint ? 'block truncate text-body font-medium' : 'block truncate'}>{machine.label}</span>
            {hint ? <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span> : null}
          </MenuOption>
        )
      })}
      {machines.map((machine) => {
        const state = availabilityOf(machine)
        const pickable = chosen(machine)
        const activate = () => {
          if (!pickable) return
          onSelect(machine)
          setOpen(false)
        }
        // With a project in hand the row says whether the machine has it:
        // a copy's name when it does, the reason when it does not (dimmed,
        // kept in the list — the menu spec's rule for a row that cannot be
        // chosen). With none, the row is the plain machine line it always was.
        const hint =
          state.state === 'has'
            ? `Has ${projectName ?? 'the project'}${state.workspace.folderPath ? ` at ${state.workspace.folderPath}` : ''}`
            : state.state === 'lacks' || state.state === 'unreachable'
              ? state.reason
              : state.state === 'loading'
                ? 'Asking what it holds…'
                : null
        return (
          <MenuOption
            key={machine.id}
            role="menuitemradio"
            selected={selected?.id === machine.id}
            stacked={Boolean(hint)}
            disabled={!pickable}
            data-machine-option="true"
            data-machine-availability={state.state}
            tabIndex={selected?.id === machine.id ? 0 : -1}
            onKeyDown={(event) => rowKey(event, activate)}
            onClick={activate}
            icon={
              <MachineSlot
                machine={{ kind: 'paired', name: machine.machineName }}
                className={`icon-xs shrink-0${hint ? ' mt-0.5' : ''}`}
              />
            }
            trailing={
              hint ? null : (
                <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">
                  {machine.endpoint}
                </span>
              )
            }
          >
            <span className={hint ? 'block truncate text-body font-medium' : 'block truncate'}>
              {machine.machineName}
            </span>
            {hint ? <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span> : null}
          </MenuOption>
        )
      })}
    </Popover>
  )
}

import React from 'react'

import type { TailnetDevice, TailnetRemoteStatus, TailnetScope } from '../../../../shared/tailnet'
import { relativeSeen } from '../../../../shared/tailnet-machines'
import { CopyGlyphButton, GhostButton, LinkButton, Popover, PrimaryButton } from '../ui'
import { MachineList } from '../remote/MachineRow'
import { ScopePicker } from '../remote/ScopePicker'
import { SettingCard, SettingsRow, SettingsSectionTitle, SettingToggle } from './SettingsAtoms'
import { mcpHttpsHelp, mcpUrlHelp, signInEnds } from './tailnetPanelModel'

// Settings → Remote's MCP section: the URL to give an outside MCP client, the
// HTTPS front door clients sign in through, and the clients a person has let
// in.
//
// An outside client is given the URL and nothing else: it finds how to sign
// in from the endpoint itself, and the person approves it in this window
// (the sign-in arrives as a pair request, answered on the same card). Each
// one approved is a paired device with origin `oauth`, so revoking or
// re-scoping it here is the same IPC a machine's row uses; it is listed here
// rather than among the machines because it is a program, not a machine, and
// several can sign in from one laptop.

export function RemoteMcpSection({
  status,
  now,
  busy,
  onSetHttps,
  onRevoke,
  onUpdateScopes,
}: {
  status: TailnetRemoteStatus | null
  now: number
  busy: boolean
  onSetHttps: (enabled: boolean) => void
  onRevoke: (device: TailnetDevice) => void
  onUpdateScopes: (device: TailnetDevice, scopes: TailnetScope[]) => void
}) {
  const mcp = status?.mcp ?? null
  const clients = (status?.devices ?? []).filter((device) => device.origin.kind === 'oauth')
  const https = mcp?.https ?? null
  const url = mcp?.url ?? null

  return (
    <section className="space-y-2">
      <SettingsSectionTitle count={clients.length}>MCP clients</SettingsSectionTitle>
      <SettingCard>
        <SettingsRow label="MCP URL" help={mcpUrlHelp(mcp)} stacked>
          {url ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <code className="min-w-0 flex-1 select-all truncate font-mono text-meta text-[color:var(--text-default)]">
                {url}
              </code>
              <CopyGlyphButton text={url} label="Copy the MCP URL" />
            </div>
          ) : null}
        </SettingsRow>
        <SettingToggle
          label="HTTPS with Tailscale Serve"
          description={mcpHttpsHelp(https)}
          enabled={https?.enabled ?? false}
          onChange={onSetHttps}
          disabled={busy || !status?.running || https?.state === 'starting'}
          requirement={status?.running ? undefined : 'Needs remote control on'}
        />
      </SettingCard>
      {clients.length > 0 ? (
        <MachineList ariaLabel="MCP clients">
          {clients.map((device) => (
            <McpClientRow
              key={device.id}
              device={device}
              now={now}
              busy={busy}
              onRevoke={() => onRevoke(device)}
              onUpdateScopes={(scopes) => onUpdateScopes(device, scopes)}
            />
          ))}
        </MachineList>
      ) : null}
    </section>
  )
}

function McpClientRow({
  device,
  now,
  busy,
  onRevoke,
  onUpdateScopes,
}: {
  device: TailnetDevice
  now: number
  busy: boolean
  onRevoke: () => void
  onUpdateScopes: (scopes: TailnetScope[]) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<TailnetScope[]>(device.scopes)
  React.useEffect(() => {
    if (!open) setDraft(device.scopes)
  }, [open, device.scopes])
  const seen = relativeSeen(device.lastSeenAt, now)
  const ends = signInEnds(device.signInEndsAt ?? null, now)
  const supporting: React.ReactNode[] = [
    <span key="from">{device.lastPeerNode ? `On ${device.lastPeerNode}` : 'Not used yet'}</span>,
    <Popover
      key="scopes"
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`What ${device.name} may do`}
      popupRole="dialog"
      placement="bottom-start"
      className="align-baseline"
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <LinkButton ref={ref} {...triggerProps} ink="quiet" onClick={togglePopover}>
          {device.scopes.length === 1 ? '1 scope' : `${device.scopes.length} scopes`}
        </LinkButton>
      )}
    >
      <div className="flex min-w-[280px] max-w-[340px] flex-col gap-2 px-3 py-2">
        <ScopePicker value={draft} onChange={setDraft} disabled={busy} idPrefix={`mcp-client-${device.id}`} />
        <div className="flex justify-end gap-1.5">
          <GhostButton size="sm" onClick={() => setOpen(false)}>
            Cancel
          </GhostButton>
          <PrimaryButton
            size="sm"
            disabled={busy}
            onClick={() => {
              onUpdateScopes(draft)
              setOpen(false)
            }}
          >
            Save
          </PrimaryButton>
        </div>
      </div>
    </Popover>,
  ]
  if (ends) supporting.push(<span key="ends">{ends}</span>)
  if (seen.short)
    supporting.push(
      <span key="seen" className="font-mono tabular-nums" title={seen.long}>
        {seen.short}
      </span>,
    )

  return (
    <li className="flex items-center gap-3 px-4 py-3" data-mcp-client={device.id}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{device.name}</span>
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-meta text-[color:var(--text-muted)]">
          {supporting.map((node, index) => (
            <React.Fragment key={index}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-[color:var(--text-subtle)]">
                  ·
                </span>
              ) : null}
              {node}
            </React.Fragment>
          ))}
        </div>
      </div>
      <GhostButton size="xs" tone="danger" disabled={busy} onClick={onRevoke}>
        Revoke
      </GhostButton>
    </li>
  )
}

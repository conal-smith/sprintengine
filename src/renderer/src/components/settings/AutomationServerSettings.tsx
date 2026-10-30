import { useCallback, useEffect, useState } from 'react'

import type { AutomationServerStatus } from '../../../../shared/automation'
import { STUDIO_MCP_SERVER_NAME } from '../../../../shared/product-identity'
import { IconButton, InlineNotice, Tooltip } from '../ui'
import { CopyIcon } from '../AppIcons'
import { McpHttpSettings } from './McpHttpSettings'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Settings → MCPs: read-only diagnostics for the always-on SprintEngine Studio
// MCP gateway. Studio agents receive it automatically; the bridge command is
// retained for external local MCP clients.

export function AutomationServerSettings() {
  const [status, setStatus] = useState<AutomationServerStatus | null>(null)

  const refresh = useCallback(async () => {
    if (typeof window.api.automationGetStatus !== 'function') return
    try {
      setStatus(await window.api.automationGetStatus())
    } catch {
      // Status stays unknown; the diagnostics section does not render.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!status) return null

  const bridgeCommand = status.bridgeScriptPath
    ? `claude mcp add sprintengine-studio -- node "${status.bridgeScriptPath}"`
    : null

  // Two rows, no prose: the server and where it listens, and the one command
  // an outside MCP client needs — behind a copy glyph, since a path nobody can
  // retype is a thing to copy rather than to read.
  return (
    // No top rule on the section: the card draws its own edge, and a section
    // rule above it doubled the boundary.
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>Automation</SettingsSectionTitle>
      <SettingCard>
        <SettingsRow
          label={STUDIO_MCP_SERVER_NAME}
          help={
            status.running && status.socketPath ? (
              <span className="break-all font-mono text-meta">{status.socketPath}</span>
            ) : (
              'Not running'
            )
          }
        >
          <span className="text-body text-[color:var(--text-muted)]">{status.running ? 'Always on' : 'Off'}</span>
        </SettingsRow>
        {bridgeCommand ? (
          <SettingsRow label="Bridge command" help="For an MCP client outside Studio.">
            <Tooltip content="Copy the bridge command">
              <IconButton
                aria-label="Copy the bridge command"
                onClick={() => void window.api.clipboardWriteText(bridgeCommand)}
              >
                <CopyIcon className="icon-sm" />
              </IconButton>
            </Tooltip>
          </SettingsRow>
        ) : null}
      </SettingCard>
      {status.lastError ? <InlineNotice tone="error">{status.lastError}</InlineNotice> : null}
      <McpHttpSettings />
    </section>
  )
}

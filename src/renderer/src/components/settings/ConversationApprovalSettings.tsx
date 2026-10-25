import { useCallback, useEffect, useState } from 'react'
import type { ConversationApprovalRule } from '../../../../shared/conversation/approvalRules'
import type { MeshApprovalRulesResult } from '../../../../shared/tailnet-mesh'
import { GhostButton, InlineNotice, SettingCard, SettingRow, Spinner } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'

export function ConversationApprovalSettings() {
  const [rules, setRules] = useState<ConversationApprovalRule[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const load = useCallback(async () => {
    try {
      setError(undefined)
      const result = await window.api.conversationApprovalRules()
      if (!result.ok) throw new Error(result.message)
      setRules(result.rules)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  async function revoke(rule: ConversationApprovalRule) {
    setBusy(rule.id)
    try {
      const result = await window.api.conversationRevokeApprovalRule({ ruleId: rule.id })
      if (!result.ok) throw new Error(result.message)
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <section className="space-y-3 pt-2" aria-labelledby="conversation-permissions-title">
      <SettingsSectionTitle id="conversation-permissions-title" count={rules?.length}>
        Remembered chat permissions
      </SettingsSectionTitle>
      <p className="text-body text-[color:var(--sem-color-text-muted)]">
        Workspace grants apply only to the named tool and matcher. Removing one makes future requests ask again.
        Conversation-only grants expire when that chat session closes.
      </p>
      {error ? (
        <InlineNotice
          tone="error"
          action={
            <GhostButton size="inline" onClick={() => void load()}>
              Retry
            </GhostButton>
          }
        >
          {error}
        </InlineNotice>
      ) : !rules ? (
        <Spinner label="Loading chat permissions" />
      ) : rules.length ? (
        <SettingCard>
          {rules.map((rule) => (
            <SettingRow key={rule.id} label={rule.label} help={rule.workspaceRoot}>
              <GhostButton
                size="sm"
                aria-label={`Revoke ${rule.label}`}
                disabled={Boolean(busy)}
                onClick={() => void revoke(rule)}
              >
                {busy === rule.id ? 'Removing…' : 'Revoke'}
              </GhostButton>
            </SettingRow>
          ))}
        </SettingCard>
      ) : (
        <p className="text-body text-[color:var(--sem-color-text-muted)]">
          No workspace permissions have been remembered.
        </p>
      )}
      <PairedMachineApprovalRules />
    </section>
  )
}

type MachineRules = {
  connectionId: string
  machineName: string
  /** Its rules, or why they could not be read. */
  answer: MeshApprovalRulesResult
}

/**
 * The "always allow" rules each paired machine's chats run with, beside this
 * computer's: a chat followed from there asks that machine's rules, not
 * these, so they are listed under it and revoked there (`approval-rules`). A
 * machine that does not share them is said so, and one that cannot be reached
 * says why. A pairing that may only follow its chats sees the Revoke refused
 * in that machine's words.
 */
function PairedMachineApprovalRules() {
  const [machines, setMachines] = useState<MachineRules[]>([])
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const read = useCallback(async (connection: { id: string; machineName: string }): Promise<MachineRules> => {
    const answer = await window.api
      .meshApprovalRules({ connectionId: connection.id })
      .catch((failure: unknown) => ({ ok: false as const, code: 'failed', message: String(failure) }))
    return { connectionId: connection.id, machineName: connection.machineName, answer }
  }, [])
  const load = useCallback(async () => {
    if (typeof window.api?.meshListConnections !== 'function' || typeof window.api.meshApprovalRules !== 'function')
      return
    const connections = await window.api.meshListConnections().catch(() => [])
    setMachines(await Promise.all(connections.map(read)))
  }, [read])
  useEffect(() => {
    void load()
  }, [load])
  async function revoke(machine: MachineRules, ruleId: string) {
    setBusy(`${machine.connectionId}:${ruleId}`)
    try {
      setError(undefined)
      const result = await window.api.meshRevokeApprovalRule({ connectionId: machine.connectionId, ruleId })
      if (!result.ok) throw new Error(result.message)
      const next = await read({ id: machine.connectionId, machineName: machine.machineName })
      setMachines((current) => current.map((entry) => (entry.connectionId === machine.connectionId ? next : entry)))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }
  if (machines.length === 0) return null
  return (
    <div className="space-y-3 pt-2">
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {machines.map((machine) => {
        const answer = machine.answer
        const rules = answer.ok ? answer.rules : null
        return (
          <div key={machine.connectionId} className="space-y-2">
            <SettingsSectionTitle count={rules?.length}>On {machine.machineName}</SettingsSectionTitle>
            {!answer.ok ? (
              <p className="text-body text-[color:var(--sem-color-text-muted)]">{answer.message}</p>
            ) : answer.rules.length ? (
              <SettingCard>
                {answer.rules.map((rule) => (
                  <SettingRow key={rule.id} label={rule.label} help={rule.project}>
                    <GhostButton
                      size="sm"
                      aria-label={`Revoke ${rule.label} on ${machine.machineName}`}
                      disabled={Boolean(busy)}
                      onClick={() => void revoke(machine, rule.id)}
                    >
                      {busy === `${machine.connectionId}:${rule.id}` ? 'Removing…' : 'Revoke'}
                    </GhostButton>
                  </SettingRow>
                ))}
              </SettingCard>
            ) : (
              <p className="text-body text-[color:var(--sem-color-text-muted)]">
                No workspace permissions have been remembered there.
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

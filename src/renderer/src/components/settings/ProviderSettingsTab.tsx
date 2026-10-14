// ProviderSettingsTab — Settings -> Providers. Lists installed conversation
// provider plugins and lets you set or remove each provider's API key. This
// surface is deliberately separate from Settings -> Agents (the installed CLI
// override table) so model providers never read as launchable terminal CLIs.
//
// Secrets are write-only from the renderer: the saved raw value is never read
// back. A configured provider shows a masked placeholder and a Remove control;
// an unconfigured one shows an input and Save. Pure state derivation lives in
// `providerSettings.ts`.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { ConversationProviderListResult, ConversationSecretStatusResult } from '../../../../shared/electron-api'
import {
  type ActionResult,
  ActionResultMessage,
  EmptyState,
  InlineNotice,
  Input,
  LoadingOverlay,
  OutlineButton,
  PrimaryButton,
  Spinner,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { SettingCard, SettingsPageHeader, SettingsSectionTitle } from './SettingsAtoms'
import {
  type ConversationProviderListEntry,
  type ProviderSecretView,
  canClearProviderSecret,
  deriveProviderSecretView,
  deriveProviderTabState,
  readCachedProviderList,
  writeCachedProviderList,
} from './providerSettings'
import { isImeKey } from '../../utils/imeKey'

// The field is `ui/Input`; this module used to carry a copy of SettingsPanel's
// `INPUT_CLASS` under the same name. `font-mono` stays because an API
// key is an identifier, not prose.
const MONO_FIELD = 'font-mono'

// The local `Note` this file used to declare was the forbidden left tone-bar in
// four tones. Failures and degraded states are the kit's notice;
// everything else here is a plain line of copy.
type ProviderMessage = ActionResult | undefined
type PendingKind = 'saving' | 'clearing'

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export function ProviderSettingsTab() {
  const dialog = useConfirmDialog()
  const ipcAvailable = typeof window.api.conversationProvidersList === 'function'

  // The last launch's list, drawn at once; the real one is read behind it.
  const [listResult, setListResult] = useState<ConversationProviderListResult | null>(() =>
    ipcAvailable ? readCachedProviderList(browserStorage()) : null,
  )
  const [refreshing, setRefreshing] = useState(false)
  const [secretViews, setSecretViews] = useState<Record<string, ProviderSecretView | undefined>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Record<string, PendingKind | undefined>>({})
  const [messages, setMessages] = useState<Record<string, ProviderMessage>>({})

  const tabState = useMemo(() => deriveProviderTabState(listResult, ipcAvailable), [listResult, ipcAvailable])

  const setMessage = useCallback((providerId: string, message: ProviderMessage) => {
    setMessages((current) => ({ ...current, [providerId]: message }))
  }, [])

  const loadProviders = useCallback(async () => {
    if (!ipcAvailable) return
    // A list already on screen stays while it is read again; only an error
    // (or nothing yet) goes back to loading.
    setListResult((current) => (current?.ok ? current : null))
    setRefreshing(true)
    try {
      const result = await window.api.conversationProvidersList()
      setListResult(result)
      // The list is current now; each row says for itself while its key is
      // still being checked.
      setRefreshing(false)
      writeCachedProviderList(browserStorage(), result)
      if (!result.ok) return
      const entries = await Promise.all(
        result.providers.map(async (entry) => {
          try {
            const statusResult = await window.api.conversationSecretStatus({ providerId: entry.id })
            return [entry.id, deriveProviderSecretView(statusResult)] as const
          } catch (err) {
            return [
              entry.id,
              { kind: 'error', message: errText(err, 'Key status unavailable.') } as ProviderSecretView,
            ] as const
          }
        }),
      )
      setSecretViews(Object.fromEntries(entries))
    } catch (err) {
      setListResult({ ok: false, message: errText(err, 'Conversation providers are unavailable.') })
    } finally {
      setRefreshing(false)
    }
  }, [ipcAvailable])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  const applyStatusResult = useCallback((providerId: string, result: ConversationSecretStatusResult) => {
    setSecretViews((current) => ({ ...current, [providerId]: deriveProviderSecretView(result) }))
  }, [])

  const saveKey = useCallback(
    async (provider: ConversationProviderListEntry) => {
      const draft = (drafts[provider.id] ?? '').trim()
      if (!draft) {
        setMessage(provider.id, { tone: 'warn', text: 'Enter an API key before saving.' })
        return
      }
      setPending((current) => ({ ...current, [provider.id]: 'saving' }))
      setMessage(provider.id, undefined)
      try {
        const result = await window.api.conversationSecretSet({ providerId: provider.id, value: draft })
        if (result.ok) {
          applyStatusResult(provider.id, result)
          setDrafts((current) => ({ ...current, [provider.id]: '' }))
          setMessage(provider.id, { tone: 'info', text: 'API key saved.' })
        } else {
          setMessage(provider.id, { tone: 'error', text: result.message })
        }
      } catch (err) {
        setMessage(provider.id, { tone: 'error', text: errText(err, 'Could not save the API key.') })
      } finally {
        setPending((current) => ({ ...current, [provider.id]: undefined }))
      }
    },
    [applyStatusResult, drafts, setMessage],
  )

  const clearKey = useCallback(
    async (provider: ConversationProviderListEntry) => {
      const confirmed = await dialog.confirm({
        title: `Remove ${provider.displayName} API key?`,
        body: 'The stored key is removed from this device. You can add it again at any time.',
        confirmLabel: 'Remove key',
      })
      if (!confirmed) return
      setPending((current) => ({ ...current, [provider.id]: 'clearing' }))
      setMessage(provider.id, undefined)
      try {
        const result = await window.api.conversationSecretClear({ providerId: provider.id })
        if (result.ok) {
          applyStatusResult(provider.id, result)
          setMessage(provider.id, { tone: 'info', text: 'API key removed.' })
        } else {
          setMessage(provider.id, { tone: 'error', text: result.message })
        }
      } catch (err) {
        setMessage(provider.id, { tone: 'error', text: errText(err, 'Could not remove the API key.') })
      } finally {
        setPending((current) => ({ ...current, [provider.id]: undefined }))
      }
    },
    [applyStatusResult, dialog, setMessage],
  )

  return (
    <div role="tabpanel" id="settings-panel-providers" aria-labelledby="settings-tab-providers" className="space-y-5">
      <SettingsPageHeader
        title="Providers"
        // The one sign a remembered list is being read again: quiet, in the
        // header's chrome, and gone when main has answered.
        actions={
          refreshing && tabState.kind === 'ready' ? (
            <span className="inline-flex" role="status" aria-label="Checking for changes">
              <Spinner className="icon-sm" />
            </span>
          ) : undefined
        }
      />

      {tabState.kind === 'unavailable' ? (
        <p className="text-body leading-5 text-[color:var(--text-muted)]">{tabState.message}</p>
      ) : null}

      {tabState.kind === 'loading' ? (
        // The kit's loading state, not a bare word: the same working mark and
        // one sentence every other surface still fetching shows.
        <LoadingOverlay label="Loading providers…" className="py-8" />
      ) : null}

      {tabState.kind === 'error' ? (
        <InlineNotice
          tone="error"
          title="Could not load the conversation providers."
          hint={tabState.message}
          action={
            <OutlineButton size="xs" onClick={() => void loadProviders()}>
              Retry
            </OutlineButton>
          }
        />
      ) : null}

      {tabState.kind === 'empty' ? <EmptyState density="list" title="No providers installed." /> : null}

      {tabState.kind === 'ready'
        ? tabState.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              secretView={secretViews[provider.id]}
              draft={drafts[provider.id] ?? ''}
              pending={pending[provider.id]}
              message={messages[provider.id]}
              onDraftChange={(value) => setDrafts((current) => ({ ...current, [provider.id]: value }))}
              onSave={() => void saveKey(provider)}
              onClear={() => void clearKey(provider)}
            />
          ))
        : null}
    </div>
  )
}

function ProviderRow({
  provider,
  secretView,
  draft,
  pending,
  message,
  onDraftChange,
  onSave,
  onClear,
}: {
  provider: ConversationProviderListEntry
  secretView: ProviderSecretView | undefined
  draft: string
  pending: PendingKind | undefined
  message: ProviderMessage
  onDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}) {
  const headingId = `provider-${provider.id}-heading`
  const inputId = `provider-key-${provider.id}`
  const busy = pending !== undefined
  const configured = secretView?.kind === 'configured'
  const canClear = canClearProviderSecret(secretView)

  return (
    // No rule between providers: each one's card draws its own edge, and the
    // border-t was a second boundary right beside it.
    <section aria-labelledby={headingId} className="space-y-2">
      <SettingsSectionTitle id={headingId}>{provider.displayName}</SettingsSectionTitle>

      <SettingCard>
        <div className="px-3 py-2.5">
          {secretView === undefined ? (
            // A remembered row whose key main has not answered for yet: an
            // input here would ask for a key the provider may already have.
            <p className="text-body leading-5 text-[color:var(--text-muted)]">Checking the key…</p>
          ) : secretView.kind === 'error' ? (
            <InlineNotice tone="error">{secretView.message}</InlineNotice>
          ) : secretView?.kind === 'none-required' ? (
            <p className="text-body leading-5 text-[color:var(--text-muted)]">No API key needed.</p>
          ) : configured ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                {/* The saved key is shown as the field it will be edited in,
                    read-only — not as a div wearing a copy of the field's chrome.
                    The value IS the mask, so the accessible name says so. */}
                <Input
                  readOnly
                  value="••••••••••••"
                  aria-label={`${provider.displayName} API key is saved`}
                  size="md"
                  className="tracking-[0.3em] text-[color:var(--text-muted)]"
                />
                {canClear ? (
                  <OutlineButton size="md" onClick={onClear} disabled={busy} className="shrink-0">
                    {pending === 'clearing' ? 'Removing…' : 'Remove'}
                  </OutlineButton>
                ) : null}
              </div>
              {!canClear ? (
                <p className="text-meta leading-5 text-[color:var(--text-subtle)]">Set from the environment.</p>
              ) : secretView.persistence === 'session' ? (
                <p className="text-meta leading-5 text-[color:var(--tone-warn)]">Kept for this session only.</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor={inputId} className="sr-only">
                {provider.displayName} API key
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={inputId}
                  type="password"
                  value={draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (isImeKey(event)) return
                    if (event.key === 'Enter' && draft.trim() && !busy) onSave()
                  }}
                  placeholder="Paste API key"
                  autoComplete="off"
                  disabled={busy}
                  size="md"
                  fullWidth={false}
                  className={`min-w-0 flex-1 ${MONO_FIELD}`}
                />
                <PrimaryButton size="md" onClick={onSave} disabled={busy || !draft.trim()} className="shrink-0">
                  {pending === 'saving' ? 'Saving…' : 'Save'}
                </PrimaryButton>
              </div>
            </div>
          )}
        </div>
        {/* `empty:hidden` matters more inside a card: the card draws a hairline
            before every child after the first, so a live region with nothing
            in it would show as a rule under an otherwise single-row card.
            `ActionResultMessage` returns null with no message, so the div is
            genuinely `:empty` and the variant fires. */}
        <div aria-live="polite" className="px-3 py-2.5 empty:hidden">
          <ActionResultMessage message={message} />
        </div>
      </SettingCard>
    </section>
  )
}

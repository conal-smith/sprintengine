import React, { createContext, memo, useCallback, useContext, useEffect, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'

import type { ConversationMcpServerActionResult } from '../../../../../../shared/conversation-runtime'
import type { InstalledPluginRecord } from '../../../../../../shared/ipc/skills'
import { scanPlugins, type AgentMcpServer, type ScannedPlugin, type SkillSource } from '../../../../../../shared/skills'

import { showToast } from '../../../../store/toastStore'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { OutlineButton, PrimaryButton } from '../../../ui'
import { ExtensionIcon } from '../../../ui/ExtensionIcon'
import { extensionIconProps, pluginArtwork } from '../../../workspace/globalSurface/extensions/catalogue/pluginArtwork'
import { dispatchExtensionsSurfaceTarget } from '../../../workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { useConversationLinkContext } from '../conversationLinks'
import type { TranscriptToolEntry } from '../conversationProjection'
import { useConversationTransport } from '../conversationTransport'
import { PluginInstallDialog } from './PluginInstallDialog'
import {
  installedRecord,
  pluginOfferAction,
  pluginOfferIds,
  serverConnected,
  serverNeedingSignIn,
  type PluginOfferIds,
} from './pluginOfferModel'

// The plugin an agent offered with Studio's `plugin.offer`: its icon, its
// name, one line, and one button (owner ruling 2026-11-02). Install opens the
// dialog where the person sees and picks what it adds; once it is in, the
// button signs this chat in to a server that needs it, or opens the plugin in
// the Extensions door to manage it.
//
// Everything on the card is read from the catalogue and this workspace, never
// from what the agent wrote: the agent only names the plugin.

/** What the chat around the card lends it: its CLI, and its hand on its own servers. */
export type PluginOfferChat = {
  /** The chat's CLI, whose servers' state the card reads. */
  cli: string | null
  /** Signs this chat in to one of its servers; null where it cannot. */
  signIn: ((serverId: string) => Promise<ConversationMcpServerActionResult>) | null
}

const PluginOfferChatContext = createContext<PluginOfferChat>({ cli: null, signIn: null })
export const PluginOfferChatProvider = PluginOfferChatContext.Provider

const ICON_SIZE = 40

type Loaded =
  | { status: 'loading' }
  | { status: 'missing'; message: string }
  | {
      status: 'ready'
      source: SkillSource
      plugin: ScannedPlugin
      record: InstalledPluginRecord | null
      servers: AgentMcpServer[]
    }

async function readOffer(ids: PluginOfferIds, workspaceRoot: string, cli: string | null): Promise<Loaded> {
  const scan = await window.api.skillsGetScan({ sourceId: ids.sourceId })
  if (!scan.ok) return { status: 'missing', message: scan.message }
  const plugin = scanPlugins(scan.scan).find((candidate) => candidate.id === ids.pluginId)
  if (!plugin) return { status: 'missing', message: `No longer in ${scan.source.name}` }
  const installed = workspaceRoot
    ? await window.api.skillsListInstalledPlugins({ workspaceRoot }).catch(() => null)
    : null
  const record = installed?.ok ? installedRecord(installed.plugins, ids) : null
  // How the servers it added are doing, as chats here last reported them.
  const capabilities =
    record && record.mcpServerIds.length > 0 && cli
      ? await window.api.agentCapabilities({ workspaceRoot, pluginId: cli }).catch(() => null)
      : null
  const servers = capabilities?.ok ? (capabilities.servers ?? []) : []
  return { status: 'ready', source: scan.source, plugin, record, servers }
}

export const PluginOfferCard = memo(function PluginOfferCard({
  tool,
  fallback,
}: {
  tool: TranscriptToolEntry
  /** Drawn instead where there is no card to draw: no ids, or a chat on another machine. */
  fallback: React.ReactNode
}): React.ReactNode {
  const ids = pluginOfferIds(tool.input)
  const sourceId = ids?.sourceId ?? ''
  const pluginId = ids?.pluginId ?? ''
  const workspaceRoot = useConversationLinkContext()?.workspaceRoot ?? ''
  const transport = useConversationTransport()
  // A chat on another machine has that machine's plugins, which this one
  // cannot read or install; a read-only view acts on nothing; and a plugin
  // installs into a workspace, so a chat without one has nowhere to put it.
  const drawable = !transport.remoteExtensions && transport.capabilities.operate && workspaceRoot !== ''
  const chat = useContext(PluginOfferChatContext)
  const openExtensionsSurface = useWorkspaceStore((state) => state.openExtensionsSurface)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  const [installing, setInstalling] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const reread = useCallback(() => setReads((count) => count + 1), [])

  useEffect(() => {
    if (!sourceId || !pluginId || !drawable) return
    let cancelled = false
    readOffer({ sourceId, pluginId }, workspaceRoot, chat.cli)
      .then((next) => {
        if (!cancelled) setLoaded(next)
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoaded({ status: 'missing', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [chat.cli, drawable, pluginId, reads, sourceId, workspaceRoot])

  // A sign-in finishes in the browser; coming back to the window is when to
  // look again at whether it took.
  useEffect(() => {
    window.addEventListener('focus', reread)
    return () => window.removeEventListener('focus', reread)
  }, [reread])

  if (!ids || !drawable) return fallback
  if (loaded.status === 'loading') return null
  // Gone from its source, or the source cannot be read: the card would have
  // only the agent's own words to show, so the call stays its tool row.
  if (loaded.status === 'missing') return fallback

  const { source, plugin, record } = loaded
  const signInServerId = serverNeedingSignIn(record, loaded.servers)
  const action = pluginOfferAction({
    installed: record !== null,
    signInServerId,
    canSignIn: chat.signIn !== null,
  })
  const line =
    record === null
      ? plugin.description || `From ${source.name}`
      : signInServerId
        ? 'Installed · Sign in to connect'
        : serverConnected(record, loaded.servers)
          ? 'Connected'
          : 'Installed'

  const manage = (): void => {
    openExtensionsSurface({ view: 'plugins' })
    dispatchExtensionsSurfaceTarget({ view: 'plugins', sourceId: source.id, pluginId: plugin.id })
  }
  const signIn = async (): Promise<void> => {
    if (!chat.signIn || !signInServerId || signingIn) return
    setSigningIn(true)
    try {
      const result = await chat.signIn(signInServerId)
      if (!result.ok) {
        showToast({ tone: 'error', title: `Could not sign in to ${plugin.name}`, description: result.message })
        return
      }
      if (result.authUrl) void window.api.openExternal(result.authUrl)
      reread()
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <>
      <OfferFrame>
        <ExtensionIcon
          name={plugin.name}
          size={ICON_SIZE}
          {...extensionIconProps(pluginArtwork(plugin, source, ICON_SIZE))}
        />
        <OfferText name={plugin.name} line={line} />
        {action === 'install' ? (
          <PrimaryButton size="sm" aria-label={`Install ${plugin.name}`} onClick={() => setInstalling(true)}>
            Install
          </PrimaryButton>
        ) : action === 'sign-in' ? (
          <PrimaryButton
            size="sm"
            aria-label={`Sign in to ${plugin.name}`}
            disabled={signingIn}
            onClick={() => void signIn()}
          >
            Sign in
          </PrimaryButton>
        ) : (
          <OutlineButton size="sm" aria-label={`Manage ${plugin.name}`} onClick={manage}>
            Manage
          </OutlineButton>
        )}
      </OfferFrame>
      {/* Portalled to the body: the card sits in the transcript's virtual
          list, whose rows contain their paint, so a dialog opened in the row
          is clipped to it rather than drawn over the window. Keys and pastes
          stop at its edge, or the chat would take typing meant for the dialog
          into its composer. */}
      {installing
        ? createPortal(
            <div onKeyDown={stopPropagation} onPaste={stopPropagation}>
              <PluginInstallDialog
                source={source}
                plugin={plugin}
                workspaceRoot={workspaceRoot}
                onClose={() => setInstalling(false)}
                onInstalled={() => {
                  setInstalling(false)
                  reread()
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  )
})

function stopPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

function OfferFrame({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      data-copy-exclude=""
      className={
        // One width whatever it says, so the card does not jump as it changes state.
        'mb-3 flex w-full max-w-lg items-center gap-3 rounded-lg border ' +
        'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] py-2.5 pl-2.5 pr-3'
      }
    >
      {children}
    </div>
  )
}

function OfferText({ name, line }: { name: string; line: string }): JSX.Element {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-body font-semibold text-[color:var(--text-strong)]">{name}</div>
      <div className="truncate text-meta text-[color:var(--text-muted)]" title={line}>
        {line}
      </div>
    </div>
  )
}

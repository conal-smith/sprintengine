import React, { useDeferredValue, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { requestConversationJump } from '../../../../utils/conversationHistoryNavigation'
import { EmptyState, InlineNotice, PanelHeader, RowButton, SegmentedControl, Spinner } from '../../../ui'
import { useLocalChatBinding } from '../../../panels/agentChat/chatBinding'
import { deriveChatActivity, type ChatImage } from '../../../panels/agentChat/chatActivity'
import { projectConversation } from '../../../panels/agentChat/conversationProjection'
import { useChatViewActive } from '../../../panels/agentChat/chatViewActivity'
import { useConversationSession } from '../../../panels/agentChat/useConversationSession'
import { ConversationTransportProvider } from '../../../panels/agentChat/conversationTransport'
import { useRemoteChat } from '../../../panels/agentChat/remoteChatRegistry'
import { StoredAttachmentThumbnail } from '../../../panels/agentChat/storedAttachments'
import { useToolImage } from '../../../panels/agentChat/useLocalImage'
import { BrowserGlyph, CanvasGlyph } from '../paneKinds'

// The Library tab: every picture in the focused chat, newest first — what the
// person attached to their messages and what the agent's steps returned (its
// browser and canvas screenshots, any other step's picture) — so a run's
// pictures can be looked over without scrolling the transcript for them. Each
// one jumps back to the turn it came in.
//
// It follows the focused chat as the Agents tab does, reading the chat's own
// session rather than anything the chat view holds, so it shows the chat even
// when its view is not mounted.

type Filter = 'all' | 'you' | 'agent'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'you', label: 'From you' },
  { value: 'agent', label: 'From the agent' },
]

export function LibraryTab({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const focusedAgentId = useWorkspaceStore((s) => s.focusedAgentByWorkspaceId[workspaceId] ?? null)
  const local = useLocalChatBinding(workspaceId, focusedAgentId ?? '')
  // A chat on a paired machine has no record here; it is read through the
  // transport its pane holds, as the Agents tab reads it.
  const remote = useRemoteChat(workspaceId, local ? null : focusedAgentId)
  const remoteShown = !local && remote !== null
  const agentId = remoteShown ? remote.agentId : focusedAgentId
  const binding = local ?? (remoteShown ? remote.binding : null)
  const root = binding ? (binding.sessionRoot ?? binding.workspaceRoot) : null

  if (!agentId || !binding || !root) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
        <PanelHeader title="Library" />
        <EmptyState
          title="No chat in focus"
          body="Open a chat, and every picture in it shows up here: the ones you attached and the ones the agent took."
        />
      </div>
    )
  }
  const library = (
    <ChatLibrary
      key={`${workspaceId}:${agentId}`}
      workspaceId={workspaceId}
      agentId={agentId}
      root={root}
      chatName={binding.agent.name}
      active={active}
    />
  )
  return remoteShown ? (
    <ConversationTransportProvider value={remote.transport}>{library}</ConversationTransportProvider>
  ) : (
    library
  )
}

function ChatLibrary({
  workspaceId,
  agentId,
  root,
  chatName,
  active,
}: {
  workspaceId: string
  agentId: string
  root: string
  chatName: string
  active: boolean
}) {
  // Nobody can see a collapsed pane, another tab's or a background
  // workspace's; the subscription rests there as a hidden chat's does.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const placed = useChatViewActive(rootRef)
  const session = useConversationSession(root, workspaceId, agentId, { active: active && placed })
  const events = useDeferredValue(session.events)
  const images = useMemo(() => deriveChatActivity(projectConversation(events).entries).images, [events])
  const [filter, setFilter] = useState<Filter>('all')
  const shown = images.filter((image) => filter === 'all' || (filter === 'you') === (image.from === 'you'))

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
      <PanelHeader title="Library" subtitle={chatName} count={images.length || undefined} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">
        {!session.hydrated && !session.error ? (
          <div className="flex items-center gap-2 px-1 py-3 text-meta text-[color:var(--text-muted)]">
            <Spinner />
            <span role="status">Reading the chat…</span>
          </div>
        ) : null}
        {session.error ? <InlineNotice tone="error" title="Couldn't read this chat." detail={session.error} /> : null}
        {session.hydrated && images.length === 0 ? (
          <EmptyState
            title="No pictures yet"
            body="Pictures you attach, and the screenshots the agent takes of a page or a board, show up here."
          />
        ) : null}
        {images.length > 0 ? (
          <>
            <SegmentedControl<Filter>
              ariaLabel="Whose pictures"
              size="sm"
              value={filter}
              onChange={setFilter}
              items={FILTERS}
            />
            {shown.length ? (
              <ul className="mt-3 grid grid-cols-2 gap-2.5" aria-label="Pictures">
                {shown.map((image) => (
                  <LibraryTile key={image.key} image={image} workspaceId={workspaceId} agentId={agentId} />
                ))}
              </ul>
            ) : (
              <p className="mt-6 text-center text-meta text-[color:var(--text-subtle)]">No pictures from here yet.</p>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

const SOURCE_LABEL: Record<ChatImage['from'], string> = {
  you: 'You',
  browser: 'Browser screenshot',
  canvas: 'Canvas',
  agent: 'The agent',
}

function LibraryTile({ image, workspaceId, agentId }: { image: ChatImage; workspaceId: string; agentId: string }) {
  const time = image.at ? new Date(image.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  const SourceGlyph = image.from === 'browser' ? BrowserGlyph : image.from === 'canvas' ? CanvasGlyph : null
  const jump =
    image.turnSeq !== undefined ? () => requestConversationJump(workspaceId, agentId, image.turnSeq!) : undefined
  return (
    <li className="min-w-0">
      <RowButton
        density="flush"
        onClick={jump}
        disabled={!jump}
        aria-label={`${image.caption}${jump ? ', jump to its message' : ''}`}
        className="group block min-w-0 p-0"
      >
        <span className="relative block aspect-[16/10] overflow-hidden rounded-lg border border-[color:var(--border-default)] bg-[color:var(--bg-well)]">
          <LibraryPicture image={image} />
          {jump ? (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-black/65 px-2 py-0.5 text-micro text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Jump to message
            </span>
          ) : null}
        </span>
        <span className="mt-1.5 block truncate text-meta text-[color:var(--text-default)]">{image.caption}</span>
        <span className="flex items-center gap-1 text-micro text-[color:var(--text-subtle)]">
          {SourceGlyph ? <SourceGlyph className="icon-xs" /> : null}
          {SOURCE_LABEL[image.from]}
          {time ? ` · ${time}` : null}
        </span>
      </RowButton>
    </li>
  )
}

const PICTURE_CLASS = 'block h-full w-full object-cover'

function LibraryPicture({ image }: { image: ChatImage }) {
  const source = image.source
  if (source.kind === 'attachment')
    return (
      <img
        src={`data:${source.attachment.mediaType};base64,${source.attachment.dataBase64}`}
        alt=""
        className={PICTURE_CLASS}
      />
    )
  if (source.kind === 'stored')
    return <StoredAttachmentThumbnail attachment={source.attachment} className={PICTURE_CLASS} />
  return <ToolPicture toolUseId={source.toolUseId} path={source.path} />
}

function ToolPicture({ toolUseId, path }: { toolUseId: string; path: string }) {
  const picture = useToolImage(toolUseId, path)
  if (picture.src) return <img src={picture.src} alt="" className={PICTURE_CLASS} />
  return (
    <span className="flex h-full items-center justify-center px-2 text-center text-micro text-[color:var(--text-subtle)]">
      {!picture.resolved ? (
        'On another machine'
      ) : picture.failed ? (
        'No longer available'
      ) : (
        <Spinner label="Loading picture" />
      )}
    </span>
  )
}

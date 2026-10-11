// "Edit from here" on a user message: the conversation goes back to before
// it — that message and every turn after it leave the agent's context and the
// transcript — and the message returns to the composer to be edited and sent
// again. Restoring the files those turns changed is offered alongside, from
// the turn's checkpoint, and never assumed: a person editing a prompt may well
// want to keep what the agent wrote.

import { useState } from 'react'
import type {
  ConversationCheckpointFile,
  ConversationImageAttachment,
  ConversationKey,
} from '../../../../../shared/conversation-runtime'
import type { ConversationMentionRef } from '../../../../../shared/conversation/mentions'
import { attachedFilePaths } from '../../../utils/attachedFiles'
import { Checkbox, GhostButton, Tooltip } from '../../ui'
import { useConfirmDialog } from '../../ui/ConfirmDialog'
import { showToast } from '../../../store/toastStore'
import type { TranscriptEntry } from './conversationProjection'
import { useConversationLinkContext } from './conversationLinks'
import { useConversationTransport, type ConversationTransport } from './conversationTransport'
import { formatDiffCount } from '../../../utils/diffCount'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>

/** What goes back into the composer: the message as it was sent. */
export type EditFromHereDraft = {
  text: string
  attachments: ConversationImageAttachment[]
  mentions: ConversationMentionRef[]
  skills: string[]
  /** The files it attached by path, as the composer's cards. */
  files: string[]
}

type EditFromHereProps = {
  entry: UserEntry
  running: boolean
  // The turn has a checkpoint this machine can restore its files from.
  canRestoreFiles: boolean
  onRestoreDraft: (draft: EditFromHereDraft) => void
  className?: string
}

export function EditFromHereAction(props: EditFromHereProps) {
  // Only a transport that can rewind offers it; the provider's own `rewind`
  // capability is the caller's gate.
  const transport = useConversationTransport()
  return props.entry.seq !== undefined && typeof transport.rewind === 'function' ? (
    <EditFromHereButton {...props} />
  ) : null
}

function EditFromHereButton({ entry, running, canRestoreFiles, onRestoreDraft, className }: EditFromHereProps) {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  const dialog = useConfirmDialog()
  const [pending, setPending] = useState(false)
  async function editFromHere() {
    const turnSeq = entry.seq
    if (!context?.agentId || running || pending || turnSeq === undefined || !transport.rewind) return
    setPending(true)
    const key: ConversationKey = {
      workspaceRoot: context.workspaceRoot,
      workspaceId: context.workspaceId,
      agentId: context.agentId,
    }
    try {
      // The files a restore would put back, asked before the dialog so it can
      // name them; a turn that changed nothing offers no restore at all.
      let files: ConversationCheckpointFile[] = []
      if (canRestoreFiles && transport.revert) {
        const preview = await transport.revert({ key, turnSeq })
        if (preview.ok) files = preview.files
      }
      const choice = { restoreFiles: false }
      const accepted = await dialog.confirm({
        title: 'Edit from here?',
        tone: 'danger',
        confirmLabel: 'Edit from here',
        body: <EditFromHereBody files={files} onRestoreFilesChange={(value) => (choice.restoreFiles = value)} />,
      })
      if (!accepted) return
      // Read before the rewind takes the message out of view.
      const draft = await editFromHereDraft(entry, transport)
      // The conversation goes back first: a rewind that is refused then leaves
      // everything as it was, where files restored ahead of it would stay
      // restored under a conversation that never moved.
      const rewound = await transport.rewind({ key, turnSeq })
      if (!rewound.ok) throw new Error(rewound.message)
      onRestoreDraft(draft)
      if (choice.restoreFiles && files.length > 0) {
        const restoreError = await restoreTurnFiles(transport, key, turnSeq, files)
        if (restoreError)
          showToast({
            tone: 'error',
            title: `The conversation went back to before this message, but its files were not restored: ${restoreError}`,
          })
      }
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not edit from here: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setPending(false)
    }
  }
  return (
    <Tooltip
      content={
        running
          ? 'Stop the running turn before editing an earlier message'
          : 'Go back to before this message and edit it'
      }
    >
      <span className={className}>
        <GhostButton size="inline" disabled={running || pending} onClick={() => void editFromHere()}>
          {pending ? 'Preparing…' : 'Edit from here'}
        </GhostButton>
      </span>
    </Tooltip>
  )
}

// Put back the files the dialog listed, from the turn's checkpoint. The
// reason it could not, or null once it has.
async function restoreTurnFiles(
  transport: ConversationTransport,
  key: ConversationKey,
  turnSeq: number,
  files: ConversationCheckpointFile[],
): Promise<string | null> {
  if (!transport.revert) return 'this conversation’s files cannot be restored from here.'
  try {
    const reverted = await transport.revert({
      key,
      turnSeq,
      confirmed: true,
      files: files.map((file) => file.path),
    })
    if (reverted.ok) return null
    return reverted.changed ? 'they changed while the dialog was open.' : reverted.message
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// The dialog's own state: whether to restore files, and the list that answer
// would touch, shown only once it is asked for.
function EditFromHereBody({
  files,
  onRestoreFilesChange,
}: {
  files: ConversationCheckpointFile[]
  onRestoreFilesChange: (value: boolean) => void
}) {
  const [restoreFiles, setRestoreFiles] = useState(false)
  return (
    <>
      <p>
        This message and everything after it leave the conversation, and the agent forgets them. The message goes back
        into the composer so you can change it and send it again.
      </p>
      {files.length > 0 ? (
        <div className="mt-3">
          <Checkbox
            checked={restoreFiles}
            onChange={(value) => {
              setRestoreFiles(value)
              onRestoreFilesChange(value)
            }}
            label={`Also restore ${files.length === 1 ? '1 file' : `${files.length} files`} to before this message`}
            size="body"
          />
          {restoreFiles ? (
            <ul className="mt-2 max-h-60 overflow-auto text-meta text-[color:var(--text-muted)]">
              {files.map((file) => (
                <li key={file.path}>
                  {file.path} · +{formatDiffCount(file.addedLines)} −{formatDiffCount(file.removedLines)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-[color:var(--text-muted)]">Files are left as they are.</p>
      )}
    </>
  )
}

/**
 * The message as the composer should get it back. Images come from the live
 * send when it is still in memory, else from the store the transcript names
 * them in; one that can no longer be read is left out rather than failing the
 * edit.
 */
export async function editFromHereDraft(
  entry: UserEntry,
  transport: Pick<ConversationTransport, 'attachment'>,
): Promise<EditFromHereDraft> {
  let attachments = entry.attachments ?? []
  if (!attachments.length && entry.storedAttachments?.length && transport.attachment) {
    const read = await Promise.all(
      entry.storedAttachments.map(async (stored): Promise<ConversationImageAttachment | null> => {
        const result = await transport.attachment?.({ ref: stored.ref }).catch(() => null)
        return result?.ok
          ? {
              id: stored.id,
              mediaType: result.mediaType,
              dataBase64: result.dataBase64,
              byteLength: stored.byteLength,
              ...(stored.name ? { name: stored.name } : {}),
            }
          : null
      }),
    )
    attachments = read.filter((attachment): attachment is ConversationImageAttachment => attachment !== null)
  }
  return {
    text: entry.text,
    attachments,
    mentions: entry.mentions ?? [],
    skills: entry.skills ?? [],
    files: attachedFilePaths(entry.files),
  }
}

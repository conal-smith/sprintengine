import React, { useCallback, useState } from 'react'

import type { WorkspaceId } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { showToast } from '../../store/toastStore'
import { useConfirmDialog } from '../ui'
import { remoteConversationTitle } from '../workspace/remoteBand/remoteSessionsModel'
import { deletionConfirmation, deletionToast } from './settledChatDeletion'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function titleOf(workspaceId: string): string {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  return workspace ? remoteConversationTitle(workspace) : 'this chat'
}

/**
 * Delete settled chats, one or many, the way every surface that offers it
 * does: main says what would go (`planSettledChatDeletion`), the app's confirm
 * dialog says it to the person, and only then does main delete, checking
 * everything again. The records leave the store on main's broadcast, as a
 * removal from any window does. Resolves with the ids that were deleted.
 */
export function useDeleteSettledChats(): {
  deleteChats: (workspaceIds: readonly WorkspaceId[]) => Promise<WorkspaceId[]>
  deleting: ReadonlySet<WorkspaceId>
} {
  const dialog = useConfirmDialog()
  const [deleting, setDeleting] = useState<ReadonlySet<WorkspaceId>>(new Set())

  const deleteChats = useCallback(
    async (workspaceIds: readonly WorkspaceId[]): Promise<WorkspaceId[]> => {
      if (workspaceIds.length === 0) return []
      const api = window.api
      const failed = (description: string) =>
        showToast({
          tone: 'error',
          title: workspaceIds.length === 1 ? 'The chat was not deleted' : 'The chats were not deleted',
          description,
        })
      if (typeof api?.planSettledChatDeletion !== 'function' || typeof api.deleteSettledChats !== 'function') {
        failed('Deleting chats is not available here.')
        return []
      }
      let plans
      try {
        plans = await api.planSettledChatDeletion([...workspaceIds])
      } catch (error) {
        failed(errorText(error))
        return []
      }
      const deletable = plans.filter((plan) => !plan.refused)
      if (deletable.length === 0) {
        failed(plans.find((plan) => plan.refused)?.refused ?? 'Nothing could be deleted.')
        return []
      }
      const confirmation = deletionConfirmation(deletable, titleOf, plans.length - deletable.length)
      const confirmed = await dialog.confirm({
        title: confirmation.title,
        body: (
          <div className="space-y-2">
            {confirmation.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        ),
        confirmLabel: confirmation.confirmLabel,
        tone: 'danger',
      })
      if (!confirmed) return []
      const ids = deletable.map((plan) => plan.workspaceId)
      // Titles are read before the records go: the toast names what was deleted.
      const titles = new Map(ids.map((id) => [id, titleOf(id)]))
      setDeleting((current) => new Set([...current, ...ids]))
      try {
        const outcomes = await api.deleteSettledChats(ids)
        showToast(deletionToast(outcomes, (id) => titles.get(id) ?? 'this chat'))
        return outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.workspaceId)
      } catch (error) {
        failed(errorText(error))
        return []
      } finally {
        setDeleting((current) => new Set([...current].filter((id) => !ids.includes(id))))
      }
    },
    [dialog],
  )

  return { deleteChats, deleting }
}

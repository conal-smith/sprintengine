import React, { useCallback, useState } from 'react'

import type { WorkspaceId } from '../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { showToast } from '../store/toastStore'
import { useConfirmDialog } from '../components/ui/ConfirmDialog'
import {
  remoteConversationTitle,
  remoteOriginChatWorkspaceId,
} from '../components/workspace/remoteBand/remoteSessionsModel'
import { deletionConfirmation, deletionToast } from '../utils/settledChatDeletion'

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
  /** Delete a paired machine's settled chat there, then this computer's record of it; whether it went. */
  deleteThere: (workspaceId: WorkspaceId) => Promise<boolean>
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

  // A settled chat opened here from a paired machine that deletes its chats
  // from here (`chat-delete`): deleted there, for every device that follows
  // it, as that machine plans it, and then this computer's record of it. The
  // confirmation says what goes there; there is no undo on either machine.
  const deleteThere = useCallback(
    async (workspaceId: WorkspaceId): Promise<boolean> => {
      const api = window.api
      const origin = useWorkspaceStore
        .getState()
        .workspaces.find((workspace) => workspace.id === workspaceId)?.remoteOrigin
      const title = titleOf(workspaceId)
      const failed = (description: string) =>
        showToast({ tone: 'error', title: 'The chat was not deleted', description })
      if (
        !origin ||
        typeof api?.meshConversationDeletePlan !== 'function' ||
        typeof api.meshChangeConversation !== 'function' ||
        typeof api.deleteSettledChats !== 'function'
      ) {
        failed('Deleting chats on another machine is not available here.')
        return false
      }
      const target = { connectionId: origin.connectionId, workspaceId: remoteOriginChatWorkspaceId(origin) }
      setDeleting((current) => new Set([...current, workspaceId]))
      try {
        const plan = await api.meshConversationDeletePlan(target)
        const refused = !plan.ok ? plan.message : plan.refused
        if (!plan.ok || refused) {
          failed(refused ?? 'Nothing could be deleted.')
          return false
        }
        // Gone there already: only this computer's record is left to take.
        if (!plan.gone) {
          const confirmation = deletionConfirmation(
            [
              {
                workspaceId,
                remoteMachine: null,
                worktrees: plan.worktrees.map((tree) => ({ ...tree, path: tree.name })),
              },
            ],
            () => title,
          )
          const confirmed = await dialog.confirm({
            title: `Delete “${title}” on ${origin.machineName}?`,
            body: (
              <div className="space-y-2">
                {[
                  `It runs on ${origin.machineName}, and is deleted there, for every device that follows it.`,
                  ...confirmation.paragraphs,
                ].map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            ),
            confirmLabel: 'Delete',
            tone: 'danger',
          })
          if (!confirmed) return false
          const deleted = await api.meshChangeConversation({ ...target, change: { kind: 'delete' } })
          if (!deleted.ok) {
            failed(deleted.message)
            return false
          }
        }
        const [removed] = await api.deleteSettledChats([workspaceId])
        if (removed && !removed.ok) {
          failed(`It was deleted on ${origin.machineName}, but not removed here: ${removed.message}`)
          return false
        }
        showToast({ tone: 'good', title: `Deleted “${title}” on ${origin.machineName}` })
        return true
      } catch (error) {
        failed(errorText(error))
        return false
      } finally {
        setDeleting((current) => new Set([...current].filter((id) => id !== workspaceId)))
      }
    },
    [dialog],
  )

  return { deleteChats, deleteThere, deleting }
}

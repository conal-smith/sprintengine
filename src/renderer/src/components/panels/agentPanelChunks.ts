import type React from 'react'

import type AgentPanel from './AgentPanel'
import { reloadableLazy } from './agentChat/ChatViewErrorBoundary'
import { preloadableLazy, type PreloadableLazy } from '../../utils/preloadableLazy'

// The code a chat is drawn with, in the two chunks it arrives as: the agent
// tab's panel (WorkspaceLayout.tsx), and the chat view inside it
// (AgentPanel.tsx). Both are lazy so boot does not evaluate them; a window's
// first chat used to pay for that on Enter, through a Suspense fallback
// React holds for 300 ms however fast the chunks came. New chat fetches
// both while the person types (`preloadAgentPanelChunks`), so Enter lands on
// the chat at once.

export const agentPanelChunk: PreloadableLazy<React.ComponentProps<typeof AgentPanel>> = preloadableLazy(
  () => import('./AgentPanel'),
)

// Reloadable, so the chat boundary's Reload chat can fetch a chunk that failed.
export const AgentChatView = reloadableLazy(() => import('./AgentChatView'))

/** Fetch a chat's code ahead of the chat. Best effort, and once: a fetched chunk is kept. */
export function preloadAgentPanelChunks(): void {
  agentPanelChunk.preload()
  AgentChatView.preload()
}

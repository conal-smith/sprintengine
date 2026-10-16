// What the chat shows before there is a conversation: the readiness states.

import { ChatGlyph } from '../../AppIcons'
import { OutlineButton, PrimaryButton } from '../../ui'

// ── Readiness gating ────────────────────────────────────────────────────────

export type ChatReadiness =
  | { kind: 'loading' }
  | { kind: 'no-workspace-folder' }
  | { kind: 'provider-unavailable'; providerId: string }
  | { kind: 'model-unavailable'; providerId: string; modelId: string }
  | { kind: 'missing-key'; providerId: string }
  | { kind: 'error'; message: string }
  // A New chat opened before its worktree (utils/newChatWorktree.ts): nothing
  // starts until the worktree is the chat's folder, or the attempt failed.
  | { kind: 'preparing-worktree' }
  | { kind: 'worktree-failed'; message: string }
  | { kind: 'ready' }

export const READINESS_COPY: Record<Exclude<ChatReadiness['kind'], 'ready' | 'loading' | 'worktree-failed'>, string> = {
  'no-workspace-folder': 'Open a workspace folder before starting a conversation agent.',
  'preparing-worktree': 'Preparing worktree…',
  'provider-unavailable': 'This conversation provider is not installed. Reinstall it to use this agent.',
  'model-unavailable': 'The selected model is not offered by this provider. Pick another model in settings.',
  'missing-key': 'Add an API key for this provider in Settings → Providers before starting.',
  error: 'Conversation providers are unavailable.',
}

export function readinessLabel(readiness: ChatReadiness): string {
  if (readiness.kind === 'ready') return 'Ready'
  if (readiness.kind === 'loading') return 'Checking provider…'
  if (readiness.kind === 'error' || readiness.kind === 'worktree-failed') return readiness.message
  return READINESS_COPY[readiness.kind]
}

// Provider-not-ready is a full centered state with a plain-language next step —
// never a bare red sentence. Real actions only.
export function ReadinessState({
  readiness,
  canSwitchModel,
  onSwitchModel,
  worktreeActions,
}: {
  readiness: ChatReadiness
  canSwitchModel: boolean
  onSwitchModel: () => void
  /** A worktree that could not be made: try again, or run in the project instead. */
  worktreeActions?: { onRetry: () => void; onStartInProject: () => void }
}) {
  if (readiness.kind === 'loading' || readiness.kind === 'preparing-worktree') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-meta text-[color:var(--text-muted)]">{readinessLabel(readiness)}</p>
      </div>
    )
  }
  if (readiness.kind === 'worktree-failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center" role="alert">
        <ChatGlyph className="mb-4 h-[30px] w-[30px] text-[color:var(--text-subtle)]" />
        <h2 className="mb-1 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
          The worktree couldn’t be made
        </h2>
        <p className="mb-5 max-w-[44ch] text-body leading-[1.55] text-[color:var(--text-muted)]">
          {readiness.message} Nothing was sent; your message is back in the box below.
        </p>
        {worktreeActions ? (
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={worktreeActions.onRetry}>Retry</PrimaryButton>
            <OutlineButton onClick={worktreeActions.onStartInProject}>Start in the project</OutlineButton>
          </div>
        ) : null}
      </div>
    )
  }
  const title =
    readiness.kind === 'provider-unavailable'
      ? 'This conversation provider isn’t installed'
      : readiness.kind === 'model-unavailable'
        ? 'This model isn’t available'
        : readiness.kind === 'missing-key'
          ? 'Add an API key to start'
          : readiness.kind === 'no-workspace-folder'
            ? 'Open a workspace folder first'
            : 'Conversation is unavailable'
  const offerSwitch =
    canSwitchModel &&
    (readiness.kind === 'provider-unavailable' ||
      readiness.kind === 'model-unavailable' ||
      readiness.kind === 'missing-key')
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <ChatGlyph className="mb-4 h-[30px] w-[30px] text-[color:var(--text-subtle)]" />
      <h2 className="mb-1 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">{title}</h2>
      <p className="mb-5 max-w-[44ch] text-body leading-[1.55] text-[color:var(--text-muted)]">
        {readinessLabel(readiness)}
      </p>
      {offerSwitch ? <OutlineButton onClick={onSwitchModel}>Use another model</OutlineButton> : null}
    </div>
  )
}

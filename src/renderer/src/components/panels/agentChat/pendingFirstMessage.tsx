// The first message of a chat that is not ready to send it yet — a New chat
// whose worktree is still being made, or whose provider is still being
// checked. Enter on New chat opened the chat at once, so it reads as the chat
// already at work: the person's bubble and the working line every turn shows,
// "Thinking…". What it is actually waiting on (the worktree, its dependency
// install, the agent starting) is folded under that line for whoever opens it,
// not put in front of everyone. The bubble is the one a sent message draws; it
// gives way to that one when the message goes.

import React, { useRef, useSyncExternalStore } from 'react'

import { newChatWorktreeBranch, subscribeNewChatWorktreeAttempts } from '../../../utils/newChatWorktree'
import { CheckIcon } from '../../AppIcons'
import { Spinner } from '../../ui'
import { UserTimelineRow, WorkingTimelineRow } from './timelineRows'
import { useWorktreeInstallOnBranch } from './worktreeInstallRow'

/** The label every turn's working line opens on, so the line reads the same before and after the agent starts. */
export const STARTING_WORKING_LABEL = 'Thinking…'

export type ChatSetupStep = { id: string; label: string; detail?: string | null; done: boolean }

/**
 * What a chat waiting on its first send is doing, in order, as far as it got:
 * its worktree (on its branch, once known), the dependency install when one
 * runs, then the agent starting. Pure, for the tests.
 */
export function chatSetupSteps(input: {
  hadWorktree: boolean
  preparingWorktree: boolean
  branch: string | null
  install: { command: string; lastLine: string | null } | null
  installed: string | null
  agentName: string
}): ChatSetupStep[] {
  const steps: ChatSetupStep[] = []
  if (input.hadWorktree) {
    steps.push({
      id: 'worktree',
      label: input.branch ? `Worktree on ${input.branch}` : 'Worktree',
      // Main answers the worktree once its install has run, so an install
      // running means the worktree itself is made.
      done: !input.preparingWorktree || input.install !== null,
    })
  }
  const command = input.install?.command ?? input.installed
  if (command) {
    steps.push({
      id: 'install',
      label: `Dependencies (${command})`,
      detail: input.install?.lastLine ?? null,
      done: input.install === null,
    })
  }
  if (!input.preparingWorktree) steps.push({ id: 'agent', label: `Starting ${input.agentName}`, done: false })
  return steps
}

export function PendingFirstMessage({
  text,
  files,
  since,
  workspaceId,
  preparingWorktree,
  agentName,
}: {
  text: string
  /** The files and images the message carries, by path, drawn as its cards. */
  files: readonly string[]
  /** When the chat began waiting: its working line counts from here. */
  since: number
  workspaceId: string
  /** Its worktree is still being made (utils/newChatWorktree.ts). */
  preparingWorktree: boolean
  /** Who is starting: "Claude", "Codex". */
  agentName: string
}) {
  const branch = useSyncExternalStore(subscribeNewChatWorktreeAttempts, () => newChatWorktreeBranch(workspaceId))
  const install = useWorktreeInstallOnBranch(preparingWorktree ? branch : null)
  // What the steps have been through, kept once the attempt that told them is over.
  const seen = useRef<{ worktree: boolean; branch: string | null; installed: string | null }>({
    worktree: false,
    branch: null,
    installed: null,
  })
  if (preparingWorktree) seen.current.worktree = true
  if (branch) seen.current.branch = branch
  if (install) seen.current.installed = install.command
  const steps = chatSetupSteps({
    hadWorktree: seen.current.worktree,
    preparingWorktree,
    branch: seen.current.branch,
    install: install ? { command: install.command, lastLine: install.lastLine } : null,
    installed: seen.current.installed,
    agentName,
  })
  return (
    <div className="chat-column-gutter h-full overflow-y-auto py-4" data-pending-first-message="">
      <UserTimelineRow
        entry={{
          kind: 'user',
          id: 'pending-first-message',
          text,
          createdAt: since,
          ...(files.length ? { files: files.map((path) => ({ path })) } : {}),
        }}
      />
      <WorkingTimelineRow
        row={{
          kind: 'working',
          id: 'pending-first-message-working',
          stage: 'thinking',
          label: STARTING_WORKING_LABEL,
          startedAt: since,
        }}
        details={<ChatSetupStepList steps={steps} />}
      />
    </div>
  )
}

function ChatSetupStepList({ steps }: { steps: readonly ChatSetupStep[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-[color:var(--text-subtle)]">
      {steps.map((step) => (
        <li key={step.id} className="flex min-w-0 items-start gap-1.5" data-setup-step={step.id}>
          <span aria-hidden className="flex size-icon-sm shrink-0 items-center justify-center">
            {step.done ? <CheckIcon className="icon-xs" /> : <Spinner size={12} />}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{step.label}</span>
            {step.detail ? (
              <span className="block truncate font-mono text-micro text-[color:var(--text-disabled)]">
                {step.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

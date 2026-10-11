// What a chat's agent is told about Studio's worktree pool.
//
// The gateway's `worktree.lease` is how an agent should get a worktree of its
// own (owner ruling 2026-10-05), but its description alone does not reach the
// model: Claude Code defers MCP tools, so the model sees the tool's name and
// never the sentence asking it to prefer the tool, and runs `git worktree add`
// as it always has. So a chat that has the gateway is told once, in the
// instructions its CLI takes beside the system prompt, and a Claude chat that
// runs `git worktree add` anyway is pointed at the tool once more.

import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mcpToolWireName } from '../../shared/modules/mcp-tools'
import { STUDIO_MCP_SERVER_ID } from '../../shared/product-identity'
import { WORKTREE_LEASE_TOOL, WORKTREE_RELEASE_TOOL } from '../worktree-pool/worktree-pool-tools'

/** The pool's two tools as a CLI shows them to its model, and the server they are on when the names do not say. */
export type WorktreeLeaseToolNames = { lease: string; release: string; server?: string }

/** As Claude Code files the gateway's tools: `mcp__<server id>__<tool, dots as underscores>`. */
export const CLAUDE_WORKTREE_LEASE_TOOLS: WorktreeLeaseToolNames = {
  lease: `mcp__${STUDIO_MCP_SERVER_ID}__${mcpToolWireName(WORKTREE_LEASE_TOOL)}`,
  release: `mcp__${STUDIO_MCP_SERVER_ID}__${mcpToolWireName(WORKTREE_RELEASE_TOOL)}`,
}

/**
 * For a CLI whose spelling of an MCP tool's name is not pinned: Codex has
 * changed how it prefixes and namespaces them between releases, so it is
 * given the gateway's own names and the server they are on.
 */
export const GATEWAY_WORKTREE_LEASE_TOOLS: WorktreeLeaseToolNames = {
  lease: WORKTREE_LEASE_TOOL,
  release: WORKTREE_RELEASE_TOOL,
  server: STUDIO_MCP_SERVER_ID,
}

const leaseAndRelease = (tools: WorktreeLeaseToolNames) =>
  `\`${tools.lease}\`${tools.server ? ` from its \`${tools.server}\` MCP server` : ''} ` +
  `(and \`${tools.release}\` when done)`

const WHAT_IT_GIVES =
  'it gives you a pooled worktree on a fresh branch off the default branch, with dependencies installed when ' +
  'the project has turned that on.'

/** The one instruction a chat with the gateway is given about worktrees. */
export function worktreeLeaseInstruction(tools: WorktreeLeaseToolNames): string {
  return (
    `To work in a separate git worktree, call the SprintEngine Studio tool ${leaseAndRelease(tools)} ` +
    `instead of running \`git worktree add\`: ${WHAT_IT_GIVES}`
  )
}

/** What a Claude chat's first `git worktree add` is answered with, in place of running it. */
export function worktreeLeaseRedirect(tools: WorktreeLeaseToolNames): string {
  return (
    `SprintEngine Studio did not run this. To work in a separate git worktree, call ${leaseAndRelease(tools)} ` +
    `instead: ${WHAT_IT_GIVES} If the person explicitly asked for \`git worktree add\`, or the worktree is of ` +
    'another repository, run the same command again and it will go through.'
  )
}

// A shell word: a quoted string, or a run of anything but whitespace and the
// characters that end a command.
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|()]+)`
// `git`, as a command of its own (after the start, a separator, a subshell or
// a path), then any of its global options, the ones that take a value given
// with the value, then `worktree add`. Matched across the whole command line,
// so a chained `cd x && git -C y worktree add z` is caught where it stands.
const GIT_WORKTREE_ADD = new RegExp(
  String.raw`(?:^|[\s;&|()\x60/])git(?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)\s+${WORD}|\s+-${WORD})*\s+worktree\s+add(?=$|[\s;&|)])`,
  'u',
)

/**
 * Whether a shell command runs `git worktree add`. Errs on the side of a
 * match (an `echo` that quotes the command is one): a match costs the agent
 * one redirect, and the same command again goes through.
 */
export function runsGitWorktreeAdd(command: unknown): boolean {
  return typeof command === 'string' && GIT_WORKTREE_ADD.test(command)
}

/**
 * Whether a folder is in a git checkout: a `.git` (a folder, or a worktree's
 * file) in it or a folder above it. A few stats, where asking git would start
 * a process on every chat launch.
 */
export async function isInGitCheckout(folder: string | undefined | null): Promise<boolean> {
  if (!folder) return false
  let current = folder
  for (let depth = 0; depth < 64; depth++) {
    if (
      await lstat(join(current, '.git')).then(
        () => true,
        () => false,
      )
    )
      return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
  return false
}

import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  cliStderrSummary,
  looksLikePermissionSettingRefusal,
  permissionModeAllows,
  permissionModeApprovalLabel,
  type PermissionModeRequest,
} from './permissionModes'
import { approvalRuleCandidate } from './approvalRules'

const root = '/Users/dev/app'
const edit = (input: unknown): PermissionModeRequest => ({ action: 'Edit', toolKind: 'file_edit', input })
const command: PermissionModeRequest = { action: 'Bash', toolKind: 'command', input: { command: 'npm test' } }
const read: PermissionModeRequest = { action: 'Read', toolKind: 'file_read', input: { file_path: 'src/a.ts' } }

test('none and manual answer nothing', () => {
  for (const mode of ['none', 'manual', undefined] as const) {
    assert.equal(permissionModeAllows(mode, read, root), false)
    assert.equal(permissionModeAllows(mode, edit({ file_path: 'src/a.ts' }), root), false)
    assert.equal(permissionModeAllows(mode, command, root), false)
  }
})

test('bypass answers every tool request', () => {
  assert.equal(permissionModeAllows('bypass', command, root), true)
  assert.equal(permissionModeAllows('bypass', edit({ file_path: '/etc/hosts' }), root), true)
  assert.equal(permissionModeAllows('bypass', { action: 'mcp__github__create_pr', toolKind: 'mcp' }, root), true)
})

test('no mode answers a question, a plan, or a request the runtime says a person must answer', () => {
  for (const mode of ['bypass', 'auto'] as const) {
    assert.equal(permissionModeAllows(mode, { action: 'AskUserQuestion', requestKind: 'question' }, root), false)
    assert.equal(permissionModeAllows(mode, { action: 'ExitPlanMode', requestKind: 'plan' }, root), false)
    assert.equal(permissionModeAllows(mode, { ...read, mustAsk: true }, root), false)
    assert.equal(permissionModeAllows(mode, { ...read, defaultToNo: true }, root), false)
  }
})

test('auto answers reads and edits inside the workspace', () => {
  assert.equal(permissionModeAllows('auto', read, root), true)
  assert.equal(
    permissionModeAllows('auto', { action: 'Grep', toolKind: 'search', input: { pattern: 'x' } }, root),
    true,
  )
  assert.equal(permissionModeAllows('auto', { action: 'TodoWrite', toolKind: 'todo', input: {} }, root), true)
  assert.equal(
    permissionModeAllows('auto', { action: 'Glob', toolKind: 'list', input: { pattern: `${root}/src/**/*.ts` } }, root),
    true,
  )
  assert.equal(permissionModeAllows('auto', edit({ file_path: `${root}/src/a.ts` }), root), true)
  assert.equal(
    permissionModeAllows('auto', { action: 'Write', toolKind: 'file_write', input: { path: 'README.md' } }, root),
    true,
  )
  // A patch across files, as Codex asks for one.
  assert.equal(permissionModeAllows('auto', edit({ edits: [{ path: 'a.ts' }, { path: `${root}/b.ts` }] }), root), true)
  // A multi-edit of one file, whose edits name none.
  assert.equal(permissionModeAllows('auto', edit({ file_path: 'a.ts', edits: [{ old_string: 'a' }] }), root), true)
})

test('auto answers MCP tools, but never the gateway tools that start an agent', () => {
  assert.equal(permissionModeAllows('auto', { action: 'mcp__github__create_pr', toolKind: 'mcp' }, root), true)
  assert.equal(
    permissionModeAllows('auto', { action: 'mcp__sprintengine-studio__agent_launch', toolKind: 'mcp' }, root),
    false,
  )
  assert.equal(
    permissionModeAllows('auto', { action: 'github create_pr', toolKind: 'mcp' }, root),
    false,
    'unread name',
  )
})

test('auto asks, every time, before a gateway tool that publishes this machine’s files', () => {
  for (const tool of ['artifacts_publish', 'artifacts.publish', 'artifacts_update', 'artifacts_setup']) {
    assert.equal(
      permissionModeAllows('auto', { action: `mcp__sprintengine-studio__${tool}`, toolKind: 'mcp' }, root),
      false,
      tool,
    )
    assert.equal(
      approvalRuleCandidate({ action: `mcp__sprintengine-studio__${tool}`, toolKind: 'mcp' }, root),
      null,
      `${tool}: no rule remembers it`,
    )
  }
  // The reads beside them are still answered.
  assert.equal(
    permissionModeAllows('auto', { action: 'mcp__sprintengine-studio__artifacts_list', toolKind: 'mcp' }, root),
    true,
  )
})

test('auto asks before commands, the network and subagents', () => {
  assert.equal(permissionModeAllows('auto', command, root), false)
  assert.equal(permissionModeAllows('auto', { action: 'WebFetch', toolKind: 'web', input: {} }, root), false)
  assert.equal(permissionModeAllows('auto', { action: 'Task', toolKind: 'subagent' }, root), false)
  assert.equal(permissionModeAllows('auto', { action: 'SomethingElse', toolKind: 'other' }, root), false)
})

test('auto asks before anything outside the workspace or inside its git directory', () => {
  assert.equal(
    permissionModeAllows('auto', { ...read, input: { file_path: '/Users/dev/.ssh/id_ed25519' } }, root),
    false,
  )
  assert.equal(permissionModeAllows('auto', { ...read, input: { file_path: '~/notes.md' } }, root), false)
  assert.equal(permissionModeAllows('auto', edit({ file_path: '../other/a.ts' }), root), false)
  assert.equal(permissionModeAllows('auto', edit({ file_path: '.git/hooks/pre-commit' }), root), false)
  assert.equal(permissionModeAllows('auto', edit({ edits: [{ path: 'a.ts' }, { path: '/tmp/b.ts' }] }), root), false)
  // A path outside, under a key this module does not know, or as a glob.
  assert.equal(permissionModeAllows('auto', { ...read, input: { target_file: '/Users/dev/.ssh/config' } }, root), false)
  assert.equal(
    permissionModeAllows('auto', { action: 'Glob', toolKind: 'list', input: { pattern: '/Users/dev/.ssh/*' } }, root),
    false,
  )
  assert.equal(
    permissionModeAllows('auto', { action: 'Grep', toolKind: 'search', input: { pattern: 'x', path: '..' } }, root),
    false,
  )
  // An edit that names no file cannot be placed.
  assert.equal(permissionModeAllows('auto', edit({}), root), false)
  assert.equal(permissionModeAllows('auto', edit({ edits: [{ old_string: 'a' }] }), root), false)
  // Nor can anything without a workspace to hold it to.
  assert.equal(permissionModeAllows('auto', read, ''), false)
})

test('auto asks before a lookup it cannot place, or one that climbs out under a key it does not know', () => {
  // An ACP agent may send no input at all, or name its file only in `locations`.
  assert.equal(permissionModeAllows('auto', { ...read, input: undefined }, root), false)
  assert.equal(permissionModeAllows('auto', { ...read, input: {} }, root), false)
  assert.equal(
    permissionModeAllows('auto', { ...read, input: { locations: [{ path: '/Users/dev/.aws/credentials' }] } }, root),
    false,
  )
  assert.equal(
    permissionModeAllows('auto', { ...read, input: { locations: [{ path: `${root}/src/a.ts` }] } }, root),
    true,
  )
  assert.equal(permissionModeAllows('auto', { ...read, input: { target_file: 'docs/../../secret/.env' } }, root), false)
  assert.equal(
    permissionModeAllows('auto', { action: 'Grep', toolKind: 'search', input: { glob: 'a/../../../**' } }, root),
    false,
  )
  assert.equal(permissionModeAllows('auto', { ...read, input: { file_path: '.git/config' } }, root), false)
})

test('auto asks before an edit that moves its file outside the workspace', () => {
  assert.equal(
    permissionModeAllows('auto', edit({ edits: [{ path: 'src/a.ts', movePath: '/Users/dev/.zshrc' }] }), root),
    false,
  )
  assert.equal(permissionModeAllows('auto', edit({ edits: [{ path: 'src/a.ts', movePath: 'src/b.ts' }] }), root), true)
})

test('auto leaves a request the runtime would not let be remembered to the person', () => {
  assert.equal(permissionModeAllows('auto', { ...read, suppressAlwaysAllowRule: true }, root), false)
})

test('an automatic answer names the mode that gave it', () => {
  assert.equal(permissionModeApprovalLabel('bypass'), 'Bypass permissions mode')
  assert.equal(permissionModeApprovalLabel('auto'), 'Auto mode')
})

test('a failure reads as a refused permission setting only when it names the setting and refuses it', () => {
  for (const refusal of [
    "error: unknown option '--permission-mode'",
    "error: option '--permission-mode <mode>' argument 'auto' is invalid. Allowed choices are default, plan.",
    'Claude Code process exited with code 1\nerror: unknown option --dangerously-skip-permissions',
    'Invalid params: unknown variant `untrusted`, expected one of `on-request`, `never`',
    "error: unexpected argument '--approve-for-me' found",
    "error: unknown option '--force'",
    'Error loading config.toml: unknown variant `auto_review`, expected `user` or `auto_reviewer`',
    'invalid value for approval_policy: expected one of untrusted, on_failure, on_request, never',
  ])
    assert.equal(looksLikePermissionSettingRefusal(refusal), true, refusal)
  for (const other of [
    'Codex app-server did not start in time.',
    'ACP agent startup timed out.',
    'read ECONNRESET',
    'Invalid API key. Run claude login.',
    'Claude Code process exited with code 1',
    'There is no conversation to compact yet.',
    '',
  ])
    assert.equal(looksLikePermissionSettingRefusal(other), false, other)
})

test('the stderr a failure quotes is the line refusing the setting, however much usage text follows it', () => {
  const usage = [
    "error: unknown option '--permission-mode'",
    '',
    'Usage: agent [options] [command] [prompt...]',
    '',
    'Start the agent.',
    '',
    'Options:',
    ...Array.from({ length: 24 }, (_, index) => `  --option-${index} <value>   what option ${index} does`),
    '  -h, --help                display help for command',
  ].join('\n')
  assert.equal(cliStderrSummary(usage), "error: unknown option '--permission-mode'")
  assert.equal(looksLikePermissionSettingRefusal(`Agent process exited. (${cliStderrSummary(usage)})`), true)
  // Codex reads its config before it says anything else.
  const codex = [
    'Error: error loading config: unknown variant `auto_review`, expected `user` or `auto`',
    'in `approvals_reviewer`',
    '',
    'For more information, try --help.',
  ].join('\n')
  assert.match(cliStderrSummary(codex), /unknown variant `auto_review`/)
  // Nothing refused: the last lines, as before.
  assert.equal(cliStderrSummary('starting\nloading\nconnection reset\nbye'), 'loading\nconnection reset\nbye')
  assert.equal(cliStderrSummary(''), '')
})

test('auto asks, every time, before a gateway tool that changes which machines can reach this one', () => {
  for (const tool of [
    'tailnet_set_enabled',
    'tailnet.offer_pairing',
    'tailnet_approve_pair_request',
    'tailnet_revoke_device',
  ]) {
    const request = { action: `mcp__sprintengine-studio__${tool}`, toolKind: 'mcp' as const }
    assert.equal(permissionModeAllows('auto', request, root), false, tool)
    assert.equal(approvalRuleCandidate(request, root), null, `${tool}: no rule remembers it`)
  }
  // Reading the status is still answered.
  assert.equal(
    permissionModeAllows('auto', { action: 'mcp__sprintengine-studio__tailnet_status', toolKind: 'mcp' }, root),
    true,
  )
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'vitest'

import {
  AGENT_BRANCH_PREFIX,
  branchNamespaceParents,
  isReservedFirstComponent,
  remoteShadowedBy,
  worktreeBranchPrefixWarning,
  effectiveWorktreeBranchPrefix,
  isStudioBranch,
  sanitizeWorktreeBranchPrefix,
  studioBranchPrefixes,
  worktreeBranchExample,
  worktreeBranchName,
} from './worktree-branch'

test('a plain prefix, and one with namespaces, are kept as typed', () => {
  assert.equal(sanitizeWorktreeBranchPrefix('feat'), 'feat')
  assert.equal(sanitizeWorktreeBranchPrefix('jane/wip'), 'jane/wip')
  assert.equal(sanitizeWorktreeBranchPrefix('Team_2.x'), 'Team_2.x')
})

test('slashes are trimmed from both ends and repeated ones collapsed', () => {
  assert.equal(sanitizeWorktreeBranchPrefix('/feat/'), 'feat')
  assert.equal(sanitizeWorktreeBranchPrefix('  jane//wip///  '), 'jane/wip')
  assert.equal(sanitizeWorktreeBranchPrefix('///'), '')
})

test('empty, or nothing but what git refuses, is no prefix', () => {
  assert.equal(sanitizeWorktreeBranchPrefix(''), '')
  assert.equal(sanitizeWorktreeBranchPrefix('   '), '')
  assert.equal(sanitizeWorktreeBranchPrefix('..'), '')
  assert.equal(sanitizeWorktreeBranchPrefix('.-.'), '')
})

test('spaces, control characters and ~^:?*[\\ become one dash', () => {
  assert.equal(sanitizeWorktreeBranchPrefix('my team'), 'my-team')
  assert.equal(sanitizeWorktreeBranchPrefix('a\tb\u0001c\u007fd'), 'a-b-c-d')
  assert.equal(sanitizeWorktreeBranchPrefix('a~b^c:d?e*f[g\\h'), 'a-b-c-d-e-f-g-h')
  assert.equal(sanitizeWorktreeBranchPrefix('a - b'), 'a-b')
})

test('a component never starts with a dot or a dash', () => {
  assert.equal(sanitizeWorktreeBranchPrefix('.hidden'), 'hidden')
  assert.equal(sanitizeWorktreeBranchPrefix('-feat'), 'feat')
  assert.equal(sanitizeWorktreeBranchPrefix('jane/.wip/-x'), 'jane/wip/x')
})

test('a component never ends in .lock or a dot', () => {
  assert.equal(sanitizeWorktreeBranchPrefix('feat.lock'), 'feat')
  assert.equal(sanitizeWorktreeBranchPrefix('feat.lock/wip.'), 'feat/wip')
  assert.equal(sanitizeWorktreeBranchPrefix('a.lock.'), 'a')
  assert.equal(sanitizeWorktreeBranchPrefix('a.lock.lock'), 'a')
})

test('two dots in a row, and @{, are never kept', () => {
  assert.equal(sanitizeWorktreeBranchPrefix('a..b'), 'a.b')
  assert.equal(sanitizeWorktreeBranchPrefix('a@{1}'), 'a-1}')
})

test('a prefix past the length limit is cut and still legal', () => {
  const cut = sanitizeWorktreeBranchPrefix(`${'a'.repeat(63)}.b`)
  assert.equal(cut, 'a'.repeat(63))
  assert.ok(sanitizeWorktreeBranchPrefix('x'.repeat(200)).length <= 64)
})

test('whatever is typed, the branch it names passes git check-ref-format', () => {
  const typed = [' my team ', '..x..', '-a/.b/c.lock', 'a@{b', 'x~y^z', '//', 'a.lock.', 'ünïcode/ok', '\u0000bad']
  for (const raw of typed) {
    const branch = worktreeBranchName(raw, 'fix-login')
    assert.doesNotThrow(
      () => execFileSync('git', ['check-ref-format', '--branch', branch], { stdio: 'ignore' }),
      `${JSON.stringify(raw)} named ${JSON.stringify(branch)}`,
    )
  }
})

test('a never-chosen prefix reads as agent; an empty one is no prefix', () => {
  assert.equal(effectiveWorktreeBranchPrefix(null), AGENT_BRANCH_PREFIX)
  assert.equal(effectiveWorktreeBranchPrefix(undefined), AGENT_BRANCH_PREFIX)
  assert.equal(effectiveWorktreeBranchPrefix(''), '')
  assert.equal(effectiveWorktreeBranchPrefix(' feat/ '), 'feat')
})

test('a branch is the prefix and the slug, or the slug alone', () => {
  assert.equal(worktreeBranchName('agent', 'chat-a1b2'), 'agent/chat-a1b2')
  assert.equal(worktreeBranchName('jane/wip', 'chat-a1b2'), 'jane/wip/chat-a1b2')
  assert.equal(worktreeBranchName('', 'chat-a1b2'), 'chat-a1b2')
  assert.equal(worktreeBranchExample('feat'), 'feat/fix-login')
  assert.equal(worktreeBranchExample(''), 'fix-login')
})

test('the configured prefix and agent are both Studio’s namespaces, once each', () => {
  assert.deepEqual(studioBranchPrefixes('feat'), ['feat/', 'agent/'])
  assert.deepEqual(studioBranchPrefixes('agent'), ['agent/'])
  assert.deepEqual(studioBranchPrefixes(''), ['agent/'])
  assert.deepEqual(studioBranchPrefixes('/agent/'), ['agent/'])
})

test('a branch under the configured prefix or agent/ is Studio’s', () => {
  assert.equal(isStudioBranch('feat/chat-a1b2', 'feat'), true)
  assert.equal(isStudioBranch('agent/chat-a1b2', 'feat'), true)
  assert.equal(isStudioBranch('jane/wip/fix', 'jane/wip'), true)
})

test('no other branch is Studio’s', () => {
  for (const branch of ['main', 'feature/x', 'feat', 'feat/', 'agent', 'agent/', 'agents/x', 'jane/fix', 'xfeat/a']) {
    assert.equal(isStudioBranch(branch, 'feat'), false, branch)
  }
  assert.equal(isStudioBranch('jane/fix', 'jane/wip'), false)
  assert.equal(isStudioBranch(null, 'feat'), false)
})

test('with no prefix, only agent/ branches are Studio’s, never an unprefixed one', () => {
  assert.equal(isStudioBranch('agent/chat-a1b2', ''), true)
  assert.equal(isStudioBranch('chat-a1b2', ''), false)
  assert.equal(isStudioBranch('main', ''), false)
  assert.equal(isStudioBranch('feature/x', ''), false)
})

test('the branches that would block one are its parents', () => {
  assert.deepEqual(branchNamespaceParents('agent/fix'), ['agent'])
  assert.deepEqual(branchNamespaceParents('jane/wip/fix'), ['jane', 'jane/wip'])
  assert.deepEqual(branchNamespaceParents('fix'), [])
})

test('a leading name git keeps for itself is left out of the prefix', () => {
  assert.equal(sanitizeWorktreeBranchPrefix('HEAD'), '')
  assert.equal(sanitizeWorktreeBranchPrefix('refs/heads/feat'), 'feat')
  assert.equal(sanitizeWorktreeBranchPrefix('Remotes/jane'), 'jane')
  assert.equal(sanitizeWorktreeBranchPrefix('tags'), '')
  // Only where git would read it as its own: further in, it is just a name.
  assert.equal(sanitizeWorktreeBranchPrefix('jane/refs'), 'jane/refs')
  assert.equal(isReservedFirstComponent('head'), true)
  assert.equal(isReservedFirstComponent('feat'), false)
})

test('the field warns about a name git keeps for itself, and about a common remote’s', () => {
  assert.match(worktreeBranchPrefixWarning('refs') ?? '', /“refs” is a name git keeps for itself/)
  assert.match(worktreeBranchPrefixWarning('HEAD/x') ?? '', /“HEAD” is a name git keeps/)
  assert.match(worktreeBranchPrefixWarning(' origin/ ') ?? '', /hide the branches of a remote named origin/)
  assert.match(worktreeBranchPrefixWarning('Upstream') ?? '', /remote named Upstream/)
  for (const fine of ['', 'feat', 'jane/origin', 'originals'])
    assert.equal(worktreeBranchPrefixWarning(fine), null, fine)
})

test('a branch hides a remote whose name its first part is, in any case', () => {
  assert.equal(remoteShadowedBy('origin/main', ['origin']), 'origin')
  assert.equal(remoteShadowedBy('Origin/main', ['origin', 'fork']), 'origin')
  assert.equal(remoteShadowedBy('fork/x', ['origin', 'Fork']), 'Fork')
  assert.equal(remoteShadowedBy('feat/main', ['origin']), null)
  assert.equal(remoteShadowedBy('origin', ['origin']), null, 'no namespace, nothing hidden')
  assert.equal(remoteShadowedBy('jane/origin/x', ['origin']), null)
})

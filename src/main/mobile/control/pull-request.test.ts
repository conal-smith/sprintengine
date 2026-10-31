import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseFilesView } from '../../github/pull-request-detail-read'
import type { PullRequestWatchRead } from '../../github/pull-request-watch-read'
import { MobileControlCommandService, mobileControlProtocolVersion, type MobileControlCommand } from './command'
import { validateMobileControlCommand } from './command-validation'
import { buildPullRequestDetail, fileDiffSection, pageFileDiff, type MobileControlPullRequestReader } from './pull-request'
import { mobilePullRequestLimits } from './protocol'

const URL = 'https://github.com/acme/app/pull/42'
const now = new Date('2026-10-30T12:00:00.000Z')

function summary(overrides: Partial<Extract<PullRequestWatchRead, { settled: true }>> = {}) {
  return {
    settled: true as const,
    state: 'open' as const,
    isDraft: false,
    stateAt: 0,
    headRefName: 'feature',
    title: 'Add the thing',
    openedAt: 1000,
    number: 42,
    headSha: 'abcdef1',
    baseRefName: 'main',
    author: 'dev',
    checks: [
      { name: 'lint', workflow: 'CI', status: 'passed' as const, outcome: 'SUCCESS', url: null },
      { name: 'build', workflow: 'CI', status: 'failed' as const, outcome: 'FAILURE', url: null },
      { name: 'tests', workflow: 'CI', status: 'pending' as const, outcome: 'IN_PROGRESS', url: null },
    ],
    requiredChecks: ['CI\0build'],
    reviewDecision: 'changes-requested' as const,
    remarks: [
      { id: 'r1', kind: 'review' as const, author: 'acme', body: 'Please fix', verdict: 'changes-requested' as const, url: null, at: 3000, own: false },
      { id: 'r2', kind: 'review' as const, author: 'acme', body: '', verdict: 'approved' as const, url: null, at: 1000, own: false },
      { id: 'c1', kind: 'comment' as const, author: 'dev', body: 'x'.repeat(1000), url: null, at: 2000, own: true },
    ],
    mergeState: 'blocked',
    mergeable: 'mergeable' as const,
    autoMerge: false,
    ...overrides,
  }
}

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  'diff --git a/src/old.ts b/src/new.ts',
  'similarity index 90%',
  'rename from src/old.ts',
  'rename to src/new.ts',
  '@@ -3 +3 @@',
  '-x',
  '+y',
  '',
].join('\n')

function command(type: MobileControlCommand['type'], payload: Record<string, unknown>): MobileControlCommand {
  return {
    protocolVersion: mobileControlProtocolVersion,
    commandId: `cmd-${Math.random()}`,
    type,
    issuedAt: now.toISOString(),
    deviceId: 'android-phone',
    idempotencyKey: 'same-key',
    payload,
  } as MobileControlCommand
}

function fakeReader(): MobileControlPullRequestReader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    summary: async () => (calls.push('summary'), summary()),
    files: async () => (
      calls.push('files'),
      parseFilesView({ files: [{ path: 'src/a.ts', additions: 1, deletions: 1, changeType: 'MODIFIED' }], additions: 1, deletions: 1, changedFiles: 1 })
    ),
    diff: async () => (calls.push('diff'), { settled: true as const, diff: DIFF }),
  }
}

test('a pull request detail counts every check and remark, and lists the failing checks first', () => {
  const detail = buildPullRequestDetail(URL, summary(), parseFilesView({ files: [], changedFiles: 0 }))
  assert.equal(detail.title, 'Add the thing')
  assert.deepEqual(
    { passed: detail.checks.passed, failed: detail.checks.failed, pending: detail.checks.pending },
    { passed: 1, failed: 1, pending: 1 },
  )
  assert.deepEqual(
    detail.checks.items.map((check) => [check.name, check.required]),
    [
      ['build', true],
      ['tests', false],
      ['lint', false],
    ],
  )
  assert.deepEqual(detail.reviews, { approved: 1, changesRequested: 1, commented: 0 })
  assert.equal(detail.remarks.total, 3)
  assert.deepEqual(
    detail.remarks.latest.map((remark) => remark.at),
    [3000, 2000, 1000],
    'newest first',
  )
  assert.ok(detail.remarks.latest[1].excerpt.length <= mobilePullRequestLimits.remarkChars)
  assert.ok(detail.remarks.latest[1].excerpt.endsWith('…'))
})

test('a pull request detail holds its lists to their bounds, and says when the files could not be read', () => {
  const checks = Array.from({ length: 80 }, (_, i) => ({
    name: `check-${i}`,
    workflow: 'CI',
    status: 'passed' as const,
    outcome: 'SUCCESS',
    url: null,
  }))
  const files = parseFilesView({
    files: Array.from({ length: 150 }, (_, i) => ({ path: `f${i}`, additions: 1, deletions: 0 })),
    changedFiles: 400,
  })
  const detail = buildPullRequestDetail(URL, summary({ checks }), files)
  assert.equal(detail.checks.items.length, mobilePullRequestLimits.checks)
  assert.equal(detail.checks.passed, 80)
  assert.equal(detail.files?.items.length, mobilePullRequestLimits.files)
  assert.equal(detail.files?.total, 400)
  assert.equal(buildPullRequestDetail(URL, summary(), { settled: false, reason: 'timeout' }).files, null)
})

test("a file's section is cut from the whole diff, by either name of a renamed file", () => {
  assert.deepEqual(fileDiffSection(DIFF, 'src/a.ts')?.slice(-2), ['-old', '+new'])
  assert.equal(fileDiffSection(DIFF, 'src/new.ts')?.[0], 'diff --git a/src/old.ts b/src/new.ts')
  assert.equal(fileDiffSection(DIFF, 'src/old.ts')?.at(-1), '+y', "the diff's own last newline is not a line")
  assert.equal(fileDiffSection(DIFF, 'src/none.ts'), null)
})

test('a diff is paged between hunks, a long hunk is cut at the page, and a long line is held to its bound', () => {
  const pageLines = mobilePullRequestLimits.diffPageLines
  const hunk = (n: number) => ['@@ -1 +1 @@', ...Array.from({ length: n }, (_, i) => `+line ${i}`)]
  const section = ['diff --git a/f b/f', '--- a/f', '+++ b/f', ...hunk(10), ...hunk(pageLines)]
  const first = pageFileDiff(URL, 'f', section, 0)
  assert.equal(first.nextOffset, 14, 'the second hunk starts the next page')
  assert.equal(first.patch.split('\n').length, 14)
  const second = pageFileDiff(URL, 'f', section, first.nextOffset ?? 0)
  assert.equal(second.patch.split('\n').length, pageLines, 'a hunk longer than a page is cut where it ends')
  const last = pageFileDiff(URL, 'f', section, second.nextOffset ?? 0)
  assert.equal(last.nextOffset, null)
  assert.equal(last.totalLines, section.length)

  const long = pageFileDiff(URL, 'f', ['+' + 'y'.repeat(5000)], 0)
  assert.equal(long.patch.length, mobilePullRequestLimits.diffLineChars)
})

test('pull request reads are validated, answered afresh each time, and kept out of the audit log', async () => {
  assert.equal(validateMobileControlCommand(command('pullRequest.read', {})).ok, false)
  assert.equal(validateMobileControlCommand(command('pullRequest.diff', { url: URL })).ok, false)
  assert.equal(validateMobileControlCommand(command('pullRequest.diff', { url: URL, path: 'f', offset: -1 })).ok, false)
  assert.equal(validateMobileControlCommand(command('pullRequest.read', { url: 'x'.repeat(600) })).ok, false)
  assert.equal(validateMobileControlCommand(command('pullRequest.diff', { url: URL, path: 'f', offset: 3 })).ok, true)

  const reader = fakeReader()
  const service = new MobileControlCommandService({ now: () => now, pullRequests: reader })
  const first = await service.dispatch(command('pullRequest.read', { url: URL }))
  assert.equal(first.ok, true)
  assert.equal(first.ok ? (first.data as { number: number }).number : null, 42)
  // The same key again is read again, not replayed.
  await service.dispatch(command('pullRequest.read', { url: URL }))
  assert.deepEqual(reader.calls, ['summary', 'files', 'summary', 'files'])

  const page = await service.dispatch(command('pullRequest.diff', { url: URL, path: 'src/a.ts' }))
  assert.equal(page.ok, true)
  assert.match(page.ok ? (page.data as { patch: string }).patch : '', /\+new$/)
  const missing = await service.dispatch(command('pullRequest.diff', { url: URL, path: 'nope.ts' }))
  assert.equal(missing.ok ? null : missing.error.code, 'invalid_payload')
  assert.deepEqual(
    service.getAuditLog().map((entry) => entry.status),
    ['rejected'],
    'only the refusal is audited; a read changes nothing',
  )
})

test('a pull request read that could not be made is refused in words, retryable where waiting helps', async () => {
  const reader: MobileControlPullRequestReader = {
    ...fakeReader(),
    summary: async () => ({ settled: false, reason: 'rate-limited' }),
  }
  const service = new MobileControlCommandService({ now: () => now, pullRequests: reader })
  const result = await service.dispatch(command('pullRequest.read', { url: URL }))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal_error')
    assert.equal(result.error.retryable, true)
    assert.match(result.error.message, /rate limit/)
  }
})

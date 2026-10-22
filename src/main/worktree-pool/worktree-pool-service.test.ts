import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, test } from 'vitest'

import { cleanupAgentWorktrees } from '../agent-worktree-cleanup'
import { lockAgentWorktree, setAgentWorktreeLockProfile } from '../agent-worktree-lock'
import { createGitWorktree, removeGitWorktree, restoreGitWorktree } from '../git'
import { listGitWorktrees } from '../git-worktree-list'
import { installWorktreePool } from './active-pool'
import { createDependencyInstaller, DEPENDENCY_INSTALL_RECORD, installDependencyInstaller } from './dependency-install'
import { acquireInstanceLock, createPoolStore, POOL_RECORD_VERSION, poolIdFor, type PoolRecord } from './pool-store'
import { agentLeaseKey } from '../../shared/ipc/worktree-pool'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { bindGatewayConversation } from '../../server/tools/client-tool-gateway'
import { defaultSlotGitRunner, parseSlotStatus, type SlotGitRunner } from './slot-git'
import type { MeasureDiskUsage } from './disk-usage'
import { createWorktreeInventory } from './worktree-inventory'
import { createWorktreePoolService, type PoolChat } from './worktree-pool-service'
import { createWorktreePoolTools } from './worktree-pool-tools'

const execFileAsync = promisify(execFile)
const identity = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}
const saved: Record<string, string | undefined> = {}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...identity },
  })
  return stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

let scratch = ''
let caseDir = ''
let origin = ''
let repo = ''
let container = ''
let userData = ''
let caseNumber = 0

const HOUR = 60 * 60_000

const GB = 1024 ** 3

/** A stand-in for `du`: every tree measures `bytes`, or what `sizes` says for its path. */
function fakeMeasure(bytes: number, sizes: Map<string, number> = new Map()) {
  return async (path: string) => ({
    bytes: sizes.get(path) ?? bytes,
    measuredAt: Date.now(),
    parts: [{ name: 'node_modules', bytes: sizes.get(path) ?? bytes }],
  })
}

function makeService(
  options: {
    live?: string[]
    now?: () => number
    instanceId?: string
    measure?: MeasureDiskUsage
    knownWorkspaceIds?: () => Iterable<string> | null
    git?: SlotGitRunner
    fetchBackoffMs?: number
    userData?: string
    branchPrefix?: string
    recorded?: Array<[string, string]>
    /** The chats on record, as worktree-services.ts reads them off the registry; left out, unknown. */
    chats?: PoolChat[]
  } = {},
) {
  const live = options.live ?? []
  /** Where a chat's session works now (a turn, a live child); also live, as `liveWorkPaths` has them. */
  const sessions: string[] = []
  /** Paths the pool said it gave back while their chat or agent still exists. */
  const givenBack: string[] = []
  const chats = options.chats
  const clock = { offset: 0 }
  const prefix = options.branchPrefix
  const service = createWorktreePoolService({
    store: createPoolStore(options.userData ?? userData),
    ...(options.git ? { git: options.git } : {}),
    ...(options.fetchBackoffMs !== undefined ? { fetchBackoffMs: options.fetchBackoffMs } : {}),
    livePaths: () => [...live, ...sessions],
    liveSessionPaths: () => sessions,
    ...(chats ? { chats: () => chats } : {}),
    onGivenBack: ({ path }) => givenBack.push(path),
    log: process.env.POOL_TEST_LOG ? (line) => console.log(line) : () => {},
    timers: false,
    fetchFreshMs: 0,
    now: options.now ?? (() => Date.now() + clock.offset),
    instanceId: options.instanceId,
    measure: options.measure ?? fakeMeasure(GB),
    ...(options.knownWorkspaceIds ? { knownWorkspaceIds: options.knownWorkspaceIds } : {}),
    ...(prefix !== undefined ? { branchPrefix: () => prefix } : {}),
    branchLedger: {
      record: async (repoRoot: string, branch: string) => {
        options.recorded?.push([repoRoot, branch])
      },
    },
  })
  return { service, live, sessions, givenBack, chats, clock }
}

type Harness = ReturnType<typeof makeService>

async function snapshot(harness: Harness) {
  const value = await harness.service.snapshot(repo)
  assert.ok(value, 'the repository has a pool')
  return value
}

async function slotAt(harness: Harness, slotId: string) {
  const found = (await snapshot(harness)).slots.find((slot) => slot.id === slotId)
  assert.ok(found, `slot ${slotId} exists`)
  return found
}

async function lease(harness: Harness, name: string, extra: { agentId?: string } = {}) {
  const result = await harness.service.lease({ repoRoot: repo, name, owner: `agent-${name}`, ...extra })
  assert.equal(result.ok, true, result.ok ? '' : `${result.reason}: ${result.message}`)
  return result as Extract<typeof result, { ok: true }>
}

/** Return every slot nothing protects, with the clock past the unclaimed-lease window. */
async function returnAll(harness: Harness, protectedPaths: string[] = []) {
  harness.clock.offset += 2 * HOUR
  return harness.service.returnUnused({ repoRoot: repo, protectedPaths, agentIds: new Set() })
}

async function pushToOrigin(file: string, content: string): Promise<string> {
  const seed = join(caseDir, 'pusher')
  if (!(await exists(seed))) await git(caseDir, 'clone', '-q', origin, seed)
  await git(seed, 'pull', '-q', 'origin', 'main')
  await writeFile(join(seed, file), content)
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', `edit ${file}`)
  await git(seed, 'push', '-q', 'origin', 'HEAD:main')
  return git(seed, 'rev-parse', 'HEAD')
}

async function lockReason(path: string): Promise<string | null> {
  const listed = await git(repo, 'worktree', 'list', '--porcelain')
  let current: string | null = null
  for (const line of listed.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (current && (await realpath(current).catch(() => current)) === (await realpath(path).catch(() => path))) {
      if (line === 'locked' || line.startsWith('locked ')) return line.slice('locked'.length).trim()
    }
  }
  return null
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(identity)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-pool-')))
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  installWorktreePool(null)
  setAgentWorktreeLockProfile(null)
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

// Every case gets its own repository, origin and profile, so no case can lean
// on another's slots.
beforeEach(async () => {
  caseNumber += 1
  caseDir = join(scratch, `case-${caseNumber}`)
  await mkdir(caseDir, { recursive: true })
  origin = join(caseDir, 'origin.git')
  const seed = join(caseDir, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await writeFile(join(seed, '.gitignore'), 'node_modules/\n.env\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(caseDir, 'clone', '-q', '--bare', seed, origin)
  repo = join(caseDir, 'app')
  await git(caseDir, 'clone', '-q', origin, repo)
  container = join(caseDir, '.sprintengine-worktrees', 'app')
  userData = join(caseDir, 'user-data')
  setAgentWorktreeLockProfile(userData)
  installWorktreePool(null)
})

test('a first lease makes a slot on the freshly fetched default branch, whatever the checkout is on', async () => {
  // The person's checkout is on a feature branch with a commit of its own.
  await git(repo, 'switch', '-q', '-c', 'feature/local')
  await writeFile(join(repo, 'local.txt'), 'local\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'local work')
  // Origin moved since the clone; only a fetch at lease time sees it.
  const pushed = await pushToOrigin('upstream.txt', 'new\n')

  const harness = makeService()
  const leased = await lease(harness, 'fix-login')
  assert.equal(leased.created, true)
  assert.equal(leased.branch, 'agent/fix-login')
  assert.equal(leased.baseRef, 'origin/main')
  assert.equal(leased.baseSha, pushed)
  assert.match(leased.path, /\.sprintengine-worktrees[\\/]app[\\/]app-01$/)
  assert.equal(await git(leased.path, 'rev-parse', 'HEAD'), pushed)
  assert.equal(await git(leased.path, 'branch', '--show-current'), 'agent/fix-login')
  assert.equal(await exists(join(leased.path, 'local.txt')), false, 'nothing of the checkout’s branch')
  assert.match((await lockReason(leased.path)) ?? '', /^agent agent-fix-login \(SprintEngine Studio profile /)
  assert.equal((await slotAt(harness, 'app-01')).state, 'leased')
})

test('a branch named agent refuses the lease up front, saying so, and makes no slot', async () => {
  await git(repo, 'branch', 'agent')
  const harness = makeService()
  const leased = await harness.service.lease({ repoRoot: repo, name: 'fix-login', owner: 'agent-fix-login' })
  assert.equal(leased.ok, false)
  assert.equal(leased.ok ? null : leased.reason, 'branch-exists')
  assert.match(leased.ok ? '' : leased.message, /A branch named “agent” in this repository blocks/)
  assert.equal(await exists(join(container, 'app-01')), false, 'no slot was made for a lease that cannot finish')
})

test('a lease by name goes on the person’s branch prefix', async () => {
  const harness = makeService({ branchPrefix: 'jane/wip' })
  const leased = await lease(harness, 'fix-login')
  assert.equal(leased.branch, 'jane/wip/fix-login')
  assert.equal(await git(leased.path, 'branch', '--show-current'), 'jane/wip/fix-login')
})

test('a lease writes its branch down as one Studio made', async () => {
  const recorded: Array<[string, string]> = []
  const harness = makeService({ branchPrefix: 'feat', recorded })
  const leased = await lease(harness, 'fix-login')
  assert.deepEqual(recorded, [[leased.repoRoot, 'feat/fix-login']])
})

test('with no prefix, a lease by name goes on the name alone', async () => {
  const harness = makeService({ branchPrefix: '' })
  const leased = await lease(harness, 'fix-login')
  assert.equal(leased.branch, 'fix-login')
})

test('a lease that names its branch is put on that branch, whatever the prefix', async () => {
  const harness = makeService({ branchPrefix: 'feat' })
  const leased = await harness.service.lease({ repoRoot: repo, name: 'agent/fix-login', branch: 'agent/fix-login' })
  assert.ok(leased.ok, leased.ok ? '' : leased.message)
  assert.equal(leased.branch, 'agent/fix-login')
})

test('a branch named like the first part of the prefix refuses the lease up front, naming it', async () => {
  await git(repo, 'branch', 'jane')
  const harness = makeService({ branchPrefix: 'jane/wip' })
  const leased = await harness.service.lease({ repoRoot: repo, name: 'fix-login', owner: 'agent-fix-login' })
  assert.equal(leased.ok ? null : leased.reason, 'branch-exists')
  assert.match(
    leased.ok ? '' : leased.message,
    /A branch named “jane” in this repository blocks Studio’s jane\/… branches/,
  )
  assert.equal(await exists(join(container, 'app-01')), false, 'no slot was made for a lease that cannot finish')
})

test('a prefix named after the repository’s remote refuses the lease up front, and makes no slot', async () => {
  const harness = makeService({ branchPrefix: 'Origin' })
  const leased = await harness.service.lease({ repoRoot: repo, name: 'main', owner: 'agent-main' })
  assert.equal(leased.ok ? null : leased.reason, 'invalid-name')
  assert.match(leased.ok ? '' : leased.message, /would hide the branches of this repository’s remote “origin”/u)
  assert.equal(await exists(join(container, 'app-01')), false, 'no slot was made for a lease that cannot finish')
})

/** A runner whose fetch and `worktree add` each take `delayMs` longer, logging when each starts and ends. */
function slowRunner(delayMs: number, events: string[]): SlotGitRunner {
  const slow = (name: string) => (cwd: string, args: string[], options?: Parameters<SlotGitRunner>[2]) =>
    (async () => {
      events.push(`${name} start`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
      const result = await defaultSlotGitRunner(cwd, args, options)
      events.push(`${name} end`)
      return result
    })()
  return (cwd, args, options) => {
    if (args[0] === 'fetch') return slow('fetch')(cwd, args, options)
    if (args.includes('worktree') && args.includes('add')) return slow('add')(cwd, args, options)
    return defaultSlotGitRunner(cwd, args, options)
  }
}

test('a lease makes its slot while the base is fetched, not after', async () => {
  const pushed = await pushToOrigin('upstream.txt', 'new\n')
  const events: string[] = []
  const harness = makeService({ git: slowRunner(400, events) })
  const leased = await lease(harness, 'overlapped')
  // The add began before the fetch ended: the two ran side by side.
  assert.ok(events.indexOf('add start') < events.indexOf('fetch end'), events.join(', '))
  // And the fork is still the freshly fetched default branch: the slot made at
  // the stale local ref was moved on to it.
  assert.equal(leased.baseSha, pushed)
  assert.equal(await git(leased.path, 'rev-parse', 'HEAD'), pushed)
  assert.equal(await git(leased.path, 'status', '--porcelain'), '')
  if (process.env.POOL_TEST_LOG) console.log(`overlapped lease: ${leased.elapsedMs} ms (each step +400 ms)`)
})

test('a reused slot is reset while the base is fetched, then moved on when the fetch moved the ref', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  const pushed = await pushToOrigin('later.txt', 'later\n')
  const second = await lease(harness, 'second')
  assert.equal(second.created, false)
  assert.equal(second.path, first.path)
  assert.equal(second.baseSha, pushed)
  assert.equal(await git(second.path, 'rev-parse', 'HEAD'), pushed)
  assert.equal(await readFile(join(second.path, 'later.txt'), 'utf8'), 'later\n')
  assert.equal(await git(second.path, 'status', '--porcelain'), '')
})

test('a slot is made and reset with parallel checkout, at the repository’s own checkout.workers', async () => {
  await git(repo, 'config', 'checkout.workers', '3')
  const checkouts: string[][] = []
  const recording: SlotGitRunner = (cwd, args, options) => {
    if (args.includes('read-tree') || (args.includes('worktree') && args.includes('add'))) checkouts.push(args)
    return defaultSlotGitRunner(cwd, args, options)
  }
  const harness = makeService({ git: recording })
  await lease(harness, 'first')
  await returnAll(harness)
  await pushToOrigin('later.txt', 'later\n')
  await lease(harness, 'second')
  assert.deepEqual(
    checkouts.map((args) => args.slice(0, 3)),
    [
      ['-c', 'checkout.workers=3', 'worktree'],
      ['-c', 'checkout.workers=3', 'read-tree'],
    ],
  )
})

test('two leases at once get two different slots', async () => {
  const harness = makeService()
  const [a, b] = await Promise.all([lease(harness, 'one'), lease(harness, 'two')])
  assert.notEqual(a.path, b.path)
  assert.deepEqual(
    (await snapshot(harness)).slots.map((slot) => slot.state),
    ['leased', 'leased'],
  )
})

test('a clean return detaches and unlocks, keeps the branch and the ignored files, and the next lease reuses it', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  // The agent installs, commits, and the launch writes its MCP config in.
  await mkdir(join(first.path, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(first.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(first.path, 'work.txt'), 'done\n')
  await git(first.path, 'add', 'work.txt')
  await git(first.path, 'commit', '-q', '-m', 'work')
  await writeFile(join(first.path, '.mcp.json'), '{"mcpServers":{}}\n')

  const swept = await returnAll(harness)
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['returned'],
  )
  const slot = await slotAt(harness, 'app-01')
  assert.equal(slot.state, 'idle')
  assert.equal(await git(first.path, 'branch', '--show-current'), '', 'detached')
  assert.equal(await lockReason(first.path), null, 'unlocked')
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/first'), 'the agent’s branch is kept')
  assert.equal(await exists(join(first.path, '.mcp.json')), false, 'the last agent’s MCP config is gone')

  const moved = await pushToOrigin('later.txt', 'later\n')
  const second = await lease(harness, 'second')
  assert.equal(second.created, false, 'reused')
  assert.equal(second.path, first.path)
  assert.equal(await git(second.path, 'rev-parse', 'HEAD'), moved, 'reset to the new origin/main')
  assert.equal(await exists(join(second.path, 'work.txt')), false, 'the last agent’s tracked work is not here')
  assert.equal(
    await readFile(join(second.path, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
    'module.exports = 1\n',
    'installed dependencies survive',
  )
})

test('a lease nobody has been seen using is left alone for an hour; one seen in use is returned once it is not', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'chat')
  // Not recorded yet (a new chat makes its worktree before its workspace).
  let swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set() })
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['unclaimed'],
  )
  // Recorded: the chat's folder is the slot.
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [leased.path], agentIds: new Set() })
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['in-use'],
  )
  // The chat is deleted: returned at once, no hour to wait.
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set() })
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['returned'],
  )
})

test('a lease given back by the window that took it is returned at once, with no hour to wait', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'closed-chat')
  const released = await harness.service.action({ kind: 'release', leaseId: leased.leaseId })
  assert.deepEqual(released, { ok: true, message: 'Returned to the pool.' })
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')
  assert.equal(await lockReason(leased.path), null, 'unlocked')
  assert.deepEqual(await harness.service.action({ kind: 'release', leaseId: leased.leaseId }), {
    ok: false,
    message: 'No such lease.',
  })
})

test('a lease nobody has worked in catches up to origin/main as it is now', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'typing')
  const pushed = await pushToOrigin('later.txt', 'pushed while the person typed\n')
  const caught = await harness.service.action({ kind: 'catch-up', leaseId: leased.leaseId })
  assert.equal(caught.ok, true, caught.message ?? '')
  assert.equal(await git(leased.path, 'rev-parse', 'HEAD'), pushed, 'on the commit origin has now')
  assert.equal(await git(leased.path, 'branch', '--show-current'), leased.branch, 'still on its own branch')
  assert.equal(await git(leased.path, 'status', '--porcelain'), '', 'and clean')
  assert.equal((await slotAt(harness, leased.slotId)).baseSha, pushed, 'the slot records its new base')

  const again = await harness.service.action({ kind: 'catch-up', leaseId: leased.leaseId })
  assert.deepEqual(again, { ok: true, message: null }, 'already current: nothing moves')
})

test('a lease someone has worked in is never moved by a catch-up', async () => {
  const harness = makeService()
  const edited = await lease(harness, 'edited')
  const committed = await lease(harness, 'committed')
  await writeFile(join(edited.path, 'README.md'), '# edited\n')
  await writeFile(join(committed.path, 'mine.txt'), 'work\n')
  await git(committed.path, 'add', '.')
  await git(committed.path, 'commit', '-q', '-m', 'work of its own')
  const own = await git(committed.path, 'rev-parse', 'HEAD')
  await pushToOrigin('later.txt', 'pushed meanwhile\n')

  for (const leased of [edited, committed]) {
    const caught = await harness.service.action({ kind: 'catch-up', leaseId: leased.leaseId })
    assert.deepEqual(caught, { ok: true, message: 'Left as it is: it has been worked in.' })
  }
  assert.equal(await git(edited.path, 'rev-parse', 'HEAD'), edited.baseSha, 'the edited one stays at its base')
  assert.equal(await readFile(join(edited.path, 'README.md'), 'utf8'), '# edited\n', 'with its edit')
  assert.equal(await git(committed.path, 'rev-parse', 'HEAD'), own, 'the committed one keeps its commit')
  assert.deepEqual(await harness.service.action({ kind: 'catch-up', leaseId: 'no-such-lease' }), {
    ok: false,
    message: 'No such lease.',
  })
})

test('a dirty return is held and locked, untouched until a person stashes', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'dirty')
  await writeFile(join(leased.path, 'README.md'), '# edited\n')
  await writeFile(join(leased.path, 'notes.txt'), 'untracked\n')

  const swept = await returnAll(harness)
  assert.equal(swept[0]?.verdict, 'held')
  const held = await slotAt(harness, 'app-01')
  assert.equal(held.state, 'held')
  assert.equal(held.held?.reason, 'dirty')
  assert.equal(held.held?.branch, 'agent/dirty')
  assert.equal(await lockReason(leased.path), 'held: dirty')
  assert.equal(await readFile(join(leased.path, 'README.md'), 'utf8'), '# edited\n')

  // A held slot is never leased.
  const next = await lease(harness, 'next')
  assert.notEqual(next.path, leased.path)

  const stashed = await harness.service.action({ kind: 'held', repoRoot: repo, slotId: 'app-01', action: 'stash' })
  assert.equal(stashed.ok, true)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')
  assert.match(await git(repo, 'stash', 'list'), /worktree pool app-01/)
})

test('discard aborts and cleans a held slot; keep takes it out of the pool for good', async () => {
  const harness = makeService()
  const a = await lease(harness, 'a')
  const b = await lease(harness, 'b')
  await writeFile(join(a.path, 'README.md'), '# a\n')
  await writeFile(join(b.path, 'README.md'), '# b\n')
  await returnAll(harness)

  const discarded = await harness.service.action({ kind: 'held', repoRoot: repo, slotId: 'app-01', action: 'discard' })
  assert.equal(discarded.ok, true)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')
  assert.equal(await readFile(join(a.path, 'README.md'), 'utf8'), '# app\n')

  const kept = await harness.service.action({ kind: 'held', repoRoot: repo, slotId: 'app-02', action: 'keep' })
  assert.equal(kept.ok, true)
  assert.equal(
    (await snapshot(harness)).slots.some((slot) => slot.id === 'app-02'),
    false,
  )
  assert.equal(await readFile(join(b.path, 'README.md'), 'utf8'), '# b\n', 'kept as it is')
  // A new pool over the same records never adopts it back.
  await harness.service.shutdown()
  const restarted = makeService()
  const third = await lease(restarted, 'c')
  assert.notEqual(third.path, b.path)
})

test('a return waits while a terminal is inside, and a merge in progress holds the slot', async () => {
  const live: string[] = []
  const harness = makeService({ live })
  const leased = await lease(harness, 'busy')
  live.push(join(leased.path, 'src'))
  let swept = await returnAll(harness)
  assert.equal(swept[0]?.verdict, 'in-use')
  assert.equal((await slotAt(harness, 'app-01')).state, 'leased')
  // A terminal that opens in it between the sweep's look and the return itself.
  live.push(leased.path)
  assert.equal(await harness.service.release(leased.leaseId), 'postponed')
  assert.equal((await slotAt(harness, 'app-01')).state, 'leased')

  live.length = 0
  await writeFile(join(leased.path, '.git-merge-marker'), '')
  const gitDir = await git(leased.path, 'rev-parse', '--absolute-git-dir')
  await writeFile(join(gitDir, 'MERGE_HEAD'), `${await git(leased.path, 'rev-parse', 'HEAD')}\n`)
  await rm(join(leased.path, '.git-merge-marker'))
  swept = await returnAll(harness)
  assert.equal(swept[0]?.verdict, 'held')
  assert.equal((await slotAt(harness, 'app-01')).held?.reason, 'operation')
})

test('a lease passes over an idle slot a terminal sits in and makes a new one', async () => {
  const live: string[] = []
  const harness = makeService({ live })
  const first = await lease(harness, 'first')
  await returnAll(harness)
  live.push(first.path)
  const second = await lease(harness, 'second')
  assert.notEqual(second.path, first.path)
  assert.equal(second.created, true)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle', 'left as it was')
})

test('a chat or terminal reached through a symlink still keeps its idle slot from being reset', async () => {
  const live: string[] = []
  const harness = makeService({ live })
  const first = await lease(harness, 'first')
  await returnAll(harness)
  // The container opened through a link, as a chat that recorded `~/code/…` would.
  const link = join(caseDir, 'linked-worktrees')
  await symlink(container, link)
  live.push(join(link, basename(first.path), 'src'))
  const second = await lease(harness, 'second')
  assert.notEqual(second.path, first.path)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle', 'left as it was')
})

test('a detached HEAD holding commits no ref reaches gets a branch before the slot is reused', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'detach')
  await git(leased.path, 'switch', '-q', '--detach')
  await writeFile(join(leased.path, 'orphan.txt'), 'orphan\n')
  await git(leased.path, 'add', '.')
  await git(leased.path, 'commit', '-q', '-m', 'orphan')
  const orphan = await git(leased.path, 'rev-parse', 'HEAD')
  await returnAll(harness)
  const rescued = await git(repo, 'branch', '--list', 'agent/detach-rescued-*', '--format=%(objectname)')
  assert.equal(rescued, orphan)
})

test('an idle slot someone edited is held at the next lease, which gets a new slot', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  await writeFile(join(first.path, 'README.md'), '# someone was here\n')
  const second = await lease(harness, 'second')
  assert.notEqual(second.path, first.path)
  const slot = await slotAt(harness, 'app-01')
  assert.equal(slot.state, 'held')
  assert.equal(slot.held?.reason, 'dirty')
  assert.equal(await readFile(join(first.path, 'README.md'), 'utf8'), '# someone was here\n')
})

test('removing an idle slot holding commits no branch has holds it instead', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  // Someone commits on the idle slot's detached HEAD.
  await writeFile(join(first.path, 'stray.txt'), 'stray\n')
  await git(first.path, 'add', '.')
  await git(first.path, 'commit', '-q', '-m', 'stray')
  const evicted = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
  assert.equal(evicted.ok, false)
  assert.equal(await exists(first.path), true, 'the commit’s worktree is still on disk')
  assert.equal((await slotAt(harness, 'app-01')).state, 'held')
})

/**
 * Gives origin a submodule from a local `file://` remote, which git refuses to
 * clone unless allowed: allowed until the returned function puts the
 * environment back.
 */
async function addSubmoduleToOrigin(): Promise<() => void> {
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
  const before = keys.map((key) => process.env[key])
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'
  process.env.GIT_CONFIG_VALUE_0 = 'always'
  const restore = () =>
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key]
      else process.env[key] = before[index]
    })
  const libSeed = join(caseDir, 'lib-seed')
  await mkdir(libSeed, { recursive: true })
  await git(libSeed, 'init', '-q', '-b', 'main')
  await writeFile(join(libSeed, 'lib.txt'), 'lib\n')
  await git(libSeed, 'add', '.')
  await git(libSeed, 'commit', '-q', '-m', 'lib')
  const libOrigin = join(caseDir, 'lib.git')
  await git(caseDir, 'clone', '-q', '--bare', libSeed, libOrigin)
  const pusher = join(caseDir, 'pusher')
  if (!(await exists(pusher))) await git(caseDir, 'clone', '-q', origin, pusher)
  await git(pusher, 'pull', '-q', 'origin', 'main')
  await git(pusher, 'submodule', 'add', '-q', `file://${libOrigin}`, 'lib')
  await git(pusher, 'commit', '-q', '-m', 'add lib')
  await git(pusher, 'push', '-q', 'origin', 'HEAD:main')
  return restore
}

test('removing an idle slot with a checked-out submodule removes it', async () => {
  const restore = await addSubmoduleToOrigin()
  try {
    const harness = makeService()
    const first = await lease(harness, 'first')
    assert.equal(await exists(join(first.path, 'lib', 'lib.txt')), true, 'the lease checked the submodule out')
    await returnAll(harness)
    const removed = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
    assert.equal(removed.ok, true, removed.message ?? '')
    assert.equal(await exists(first.path), false)
  } finally {
    restore()
  }
})

test('removing an idle slot whose submodule holds a branch no remote has holds it instead', async () => {
  const restore = await addSubmoduleToOrigin()
  try {
    const harness = makeService()
    const first = await lease(harness, 'first')
    await returnAll(harness)
    // Someone commits on a branch in the idle slot's submodule and switches
    // back, so the slot's own status reads clean.
    const lib = join(first.path, 'lib')
    await git(lib, 'switch', '-q', '-c', 'local-only')
    await writeFile(join(lib, 'lib.txt'), 'work\n')
    await git(lib, 'commit', '-q', '-am', 'local work')
    await git(lib, 'switch', '-q', '--detach', 'origin/main')
    assert.equal(await git(first.path, 'status', '--porcelain'), '')

    const evicted = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
    assert.equal(evicted.ok, false)
    assert.match(evicted.message ?? '', /submodules hold work/)
    assert.equal(await git(lib, 'show', 'local-only:lib.txt'), 'work', 'the commit is still there')
    const slot = await slotAt(harness, 'app-01')
    assert.equal(slot.state, 'held')
    assert.equal(slot.held?.reason, 'dirty')
  } finally {
    restore()
  }
})

test('removing an idle slot with edits hidden from git status holds it instead', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  // Someone marks a tracked file skip-worktree in the idle slot and edits it.
  await git(first.path, 'update-index', '--skip-worktree', 'README.md')
  await writeFile(join(first.path, 'README.md'), 'local only\n')
  const evicted = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
  assert.equal(evicted.ok, false)
  assert.equal(await readFile(join(first.path, 'README.md'), 'utf8'), 'local only\n', 'the edit is still on disk')
  assert.equal((await slotAt(harness, 'app-01')).state, 'held')
})

test('an idle slot with ignored files that may be work is not removed until a person clears them', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await mkdir(join(first.path, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(first.path, 'node_modules', 'pkg', 'index.js'), 'x\n')
  // An `.env` the agent wrote, which no `.worktreeinclude` copy accounts for.
  await writeFile(join(first.path, '.env'), 'TOKEN=edited\n')
  await returnAll(harness)
  const kept = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
  assert.equal(kept.ok, false)
  assert.match(kept.message ?? '', /\.env/)
  assert.equal(await exists(first.path), true)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')
  // The idle limit leaves it too, and Settings says why.
  await harness.service.updateSettings({ keepIdle: 0 })
  const idle = await slotAt(harness, 'app-01')
  assert.equal(idle.state, 'idle')
  assert.match(idle.kept ?? '', /^has ignored files .*\.env/)

  await harness.service.action({ kind: 'clear-ignored', repoRoot: repo, slotId: 'app-01' })
  assert.equal((await slotAt(harness, 'app-01')).kept, null)
  const removed = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
  assert.equal(removed.ok, true)
  assert.equal(await exists(first.path), false)
})

test('an idle slot kept for its ignored files is not checked again until it is used or the chats change', async () => {
  let calls = 0
  const counting: SlotGitRunner = (cwd, args, options) => {
    calls += 1
    return defaultSlotGitRunner(cwd, args, options)
  }
  let chats = ['chat-1']
  const harness = makeService({ git: counting, knownWorkspaceIds: () => chats })
  const first = await lease(harness, 'first')
  await writeFile(join(first.path, '.env'), 'TOKEN=edited\n')
  await returnAll(harness)
  await harness.service.updateSettings({ keepIdle: 0 })
  assert.match((await slotAt(harness, 'app-01')).kept ?? '', /\.env/)

  const before = calls
  await harness.service.updateSettings({ keepIdle: 0, maxSlots: 8 })
  assert.equal(calls, before, 'the same verdict, with no git asked again')

  // A chat deleted since: checked again (and kept again, for its .env).
  chats = []
  await harness.service.updateSettings({ keepIdle: 0, maxSlots: 6 })
  assert.ok(calls > before)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')
})

test('an idle slot holding only what tools rebuild (a virtualenv, logs, caches) is removed', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await writeFile(join(repo, '.git', 'info', 'exclude'), 'venv/\n*.log\n.eslintcache\n__pycache__/\n')
  await mkdir(join(first.path, 'venv', 'bin'), { recursive: true })
  await writeFile(join(first.path, 'venv', 'bin', 'python'), 'x\n')
  await writeFile(join(first.path, 'npm-debug.log'), 'x\n')
  await writeFile(join(first.path, '.eslintcache'), '{}\n')
  await mkdir(join(first.path, '__pycache__'), { recursive: true })
  await writeFile(join(first.path, '__pycache__', 'app.cpython-312.pyc'), 'x')
  await returnAll(harness)
  const removed = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
  assert.equal(removed.ok, true, removed.message ?? '')
  assert.equal(await exists(first.path), false)
})

test('what the app and the agent CLIs wrote, and a linked node_modules, do not keep an idle slot', async () => {
  await appendFile(
    join(repo, '.git', 'info', 'exclude'),
    '.sprintengine/\n.agents/\n.claude/\n.opencode/\nnode_modules\n',
  )
  // The chat that ran here was deleted since: only `chat-now` is on record.
  const harness = makeService({ knownWorkspaceIds: () => ['chat-now'] })
  const first = await lease(harness, 'first')
  // A deleted chat's leftover transcript, the pane's captures, a skill the
  // app installed, what OpenCode installs for itself, an empty folder a CLI
  // made, and dependencies linked in.
  await mkdir(join(first.path, '.sprintengine', 'conversations', 'ws-1'), { recursive: true })
  await writeFile(join(first.path, '.sprintengine', 'conversations', 'ws-1', 'agent-1.jsonl'), '{}\n')
  await mkdir(join(first.path, '.sprintengine', 'browser'), { recursive: true })
  await writeFile(join(first.path, '.sprintengine', 'browser', 'shot.png'), 'png')
  const skill = join(first.path, '.agents', 'skills', 'design-system')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '# design system\n')
  await writeFile(join(skill, '.sprintengine-skill.json'), '{}\n')
  await mkdir(join(first.path, '.opencode', 'node_modules', 'plugin'), { recursive: true })
  await writeFile(join(first.path, '.opencode', 'package.json'), '{}\n')
  await mkdir(join(first.path, '.claude'), { recursive: true })
  const shared = join(caseDir, 'shared-node-modules')
  await mkdir(join(shared, 'left-pad'), { recursive: true })
  await symlink(shared, join(first.path, 'node_modules'))
  await returnAll(harness)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')

  await harness.service.updateSettings({ keepIdle: 0 })
  assert.equal(await exists(first.path), false)
  assert.equal(await exists(join(shared, 'left-pad')), true, 'the linked folder itself is untouched')
})

test('a slot keeps the history of a chat that is not settled, and lets it go once the chat settles', async () => {
  await appendFile(join(repo, '.git', 'info', 'exclude'), '.sprintengine/\nnode_modules/\n')
  // The chats not settled (chatIdsOnRecord): a settled chat counts as deleted.
  const onRecord = ['settled-chat', 'another-chat']
  const harness = makeService({ knownWorkspaceIds: () => onRecord })
  const first = await lease(harness, 'first')
  const history = join(first.path, '.sprintengine', 'conversations', 'settled-chat')
  await mkdir(history, { recursive: true })
  await writeFile(join(history, 'agent-1.jsonl'), '{"type":"user_message"}\n')
  await mkdir(join(first.path, 'node_modules', 'pkg'), { recursive: true })
  // Its slot went back to the pool (its agent was removed) while the chat stays open.
  await returnAll(harness)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')

  await harness.service.updateSettings({ keepIdle: 0 })
  assert.equal(await exists(join(history, 'agent-1.jsonl')), true, 'the idle limit leaves it')
  assert.match((await slotAt(harness, 'app-01')).kept ?? '', /history of a chat not settled/)
  const asked = await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })
  assert.equal(asked.ok, false)
  assert.match(asked.message ?? '', /history of a chat/)
  // Clearing the slot's ignored files frees the space and keeps the history.
  await harness.service.action({ kind: 'clear-ignored', repoRoot: repo, slotId: 'app-01' })
  assert.equal(await exists(join(first.path, 'node_modules')), false)
  assert.equal(await exists(join(history, 'agent-1.jsonl')), true)

  // Settled (or deleted), the chat's history is a leftover, and the slot goes.
  onRecord.splice(0, 1)
  assert.equal((await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })).ok, true)
  assert.equal(await exists(first.path), false)
})

test('with the chats on record unknown, a slot holding any chat’s history is kept', async () => {
  await appendFile(join(repo, '.git', 'info', 'exclude'), '.sprintengine/\n')
  const harness = makeService({ knownWorkspaceIds: () => null })
  const first = await lease(harness, 'first')
  const history = join(first.path, '.sprintengine', 'conversations', 'some-chat')
  await mkdir(history, { recursive: true })
  await writeFile(join(history, 'agent-1.jsonl'), '{}\n')
  await returnAll(harness)
  assert.equal((await harness.service.action({ kind: 'evict', repoRoot: repo, slotId: 'app-01' })).ok, false)
  assert.equal(await exists(join(history, 'agent-1.jsonl')), true)
})

test('a skill folder the app did not install keeps an idle slot', async () => {
  await appendFile(join(repo, '.git', 'info', 'exclude'), '.claude/\n')
  const harness = makeService()
  const first = await lease(harness, 'first')
  await mkdir(join(first.path, '.claude', 'skills', 'mine'), { recursive: true })
  await writeFile(join(first.path, '.claude', 'skills', 'mine', 'SKILL.md'), '# my own skill\n')
  await returnAll(harness)
  await harness.service.updateSettings({ keepIdle: 0 })
  assert.equal(await exists(first.path), true)
  assert.match((await slotAt(harness, 'app-01')).kept ?? '', /\.claude\//)
})

test('an ignored file where the new base adds a tracked one holds the slot rather than being overwritten', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  await writeFile(join(first.path, '.env'), 'SECRET=mine\n')
  // The default branch now tracks `.env` (and stops ignoring it).
  const seed = join(caseDir, 'pusher')
  await git(caseDir, 'clone', '-q', origin, seed)
  await writeFile(join(seed, '.gitignore'), 'node_modules/\n')
  await writeFile(join(seed, '.env'), 'SECRET=example\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'track .env')
  await git(seed, 'push', '-q', 'origin', 'HEAD:main')

  const second = await lease(harness, 'second')
  assert.notEqual(second.path, first.path)
  assert.equal((await slotAt(harness, 'app-01')).state, 'held')
  assert.equal(await readFile(join(first.path, '.env'), 'utf8'), 'SECRET=mine\n')
})

test('a file the new base stops ignoring holds the slot instead of being cleaned away', async () => {
  await pushToOrigin('.gitignore', 'node_modules/\n.env\npkg/.env.local\n')
  const harness = makeService()
  const first = await lease(harness, 'first')
  await mkdir(join(first.path, 'pkg'), { recursive: true })
  await writeFile(join(first.path, 'pkg', '.env.local'), 'TOKEN=mine\n')
  await returnAll(harness)
  assert.equal((await slotAt(harness, first.slotId)).state, 'idle', 'ignored, so the return was clean')
  // The default branch drops the rule: after a reset the file is untracked.
  await pushToOrigin('.gitignore', 'node_modules/\n.env\n')
  const second = await lease(harness, 'second')
  assert.notEqual(second.path, first.path)
  const held = await slotAt(harness, first.slotId)
  assert.equal(held.state, 'held')
  assert.match(held.held?.detail ?? '', /pkg\//)
  assert.equal(await readFile(join(first.path, 'pkg', '.env.local'), 'utf8'), 'TOKEN=mine\n')
})

test('returns beyond the idle limit remove the least recently used idle slot', async () => {
  const harness = makeService()
  await harness.service.updateSettings({ keepIdle: 1 })
  const a = await lease(harness, 'a')
  const b = await lease(harness, 'b')
  await returnAll(harness)
  const slots = (await snapshot(harness)).slots
  assert.equal(slots.length, 1)
  assert.equal(slots[0].state, 'idle')
  const gone = [a.path, b.path].filter((path) => path !== slots[0].path)
  assert.equal(await exists(gone[0]), false)
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/a'))
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/b'))
})

test('a branch that exists is the caller’s error; a bad name is too', async () => {
  const harness = makeService()
  await git(repo, 'branch', 'agent/taken')
  const taken = await harness.service.lease({ repoRoot: repo, name: 'taken' })
  assert.equal(taken.ok, false)
  assert.equal(taken.ok ? null : taken.reason, 'branch-exists')
  const bad = await harness.service.lease({ repoRoot: repo, name: '///' })
  assert.equal(bad.ok ? null : bad.reason, 'invalid-name')
  // Neither left a slot behind.
  assert.equal((await harness.service.snapshot(repo))?.slots.length ?? 0, 0)
})

test('a slot an agent leased for itself is kept while that agent exists, wherever it works', async () => {
  const harness = makeService()
  await lease(harness, 'mcp', { agentId: 'agent-7' })
  harness.clock.offset += 2 * HOUR
  let swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set(['agent-7']) })
  assert.equal(swept[0]?.verdict, 'in-use')
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: null })
  assert.equal(swept[0]?.verdict, 'in-use', 'agents unknown: kept')
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set() })
  assert.equal(swept[0]?.verdict, 'returned')
})

test('a slot an agent leased is kept by that agent in its own chat, not by a namesake in another', async () => {
  const harness = makeService()
  await harness.service.lease({
    repoRoot: repo,
    name: 'mcp',
    owner: 'agent-1',
    agentId: 'agent-1',
    workspaceId: 'ws-1',
  })
  harness.clock.offset += 2 * HOUR
  const ids = new Set(['agent-1'])
  let swept = await harness.service.returnUnused({
    repoRoot: repo,
    protectedPaths: [],
    agentIds: ids,
    agentKeys: new Set([agentLeaseKey('ws-1', 'agent-1')]),
  })
  assert.equal(swept[0]?.verdict, 'in-use')
  // Its chat is gone; another chat still has an `agent-1`.
  swept = await harness.service.returnUnused({
    repoRoot: repo,
    protectedPaths: [],
    agentIds: ids,
    agentKeys: new Set([agentLeaseKey('ws-2', 'agent-1')]),
  })
  assert.equal(swept[0]?.verdict, 'returned')
})

test('quitting waits for a lease in flight before giving the pool’s lock up', async () => {
  const harness = makeService()
  let leased = false
  const pending = harness.service.lease({ repoRoot: repo, name: 'late', owner: 'agent-late' }).then((result) => {
    leased = result.ok
    return result
  })
  // Once the lease holds the lock, it is past the point quitting refuses.
  while (!(await exists(join(container, '.pool.lock')))) await new Promise((resolveTick) => setTimeout(resolveTick, 5))
  await harness.service.shutdown()
  assert.equal(leased, true, 'the lease finished before the lock went')
  assert.equal(await exists(join(container, '.pool.lock')), false)
  await pending
})

test('measuring takes no pool’s lock: a pool this run has not used keeps its stored sizes', async () => {
  const first = makeService({ measure: fakeMeasure(GB) })
  await lease(first, 'first')
  await first.service.measure()
  await first.service.shutdown()
  assert.equal(await exists(join(container, '.pool.lock')), false)

  // The next start opens Settings ▸ Worktrees before any lease.
  let measured = 0
  const next = makeService({
    instanceId: 'next-start',
    measure: async (path) => {
      measured += 1
      return fakeMeasure(2 * GB)(path)
    },
  })
  await next.service.measure()
  assert.equal(measured, 0)
  assert.equal(await exists(join(container, '.pool.lock')), false, 'the container is left to whoever uses it')
  assert.equal((await slotAt(next, 'app-01')).size?.bytes, GB, 'the stored size is shown')
})

test('a measurement is not announced to the windows; a lease is', async () => {
  let changes = 0
  const service = createWorktreePoolService({
    store: createPoolStore(userData),
    log: () => {},
    timers: false,
    fetchFreshMs: 0,
    measure: fakeMeasure(GB),
    onChange: () => (changes += 1),
  })
  const leased = await service.lease({ repoRoot: repo, name: 'announced' })
  assert.equal(leased.ok, true)
  assert.ok(changes > 0)
  const before = changes
  await service.measure()
  assert.equal(changes, before, 'sizes alone fire no change')
  assert.equal((await service.snapshot(repo))?.slots[0].size?.bytes, GB)
})

test('quitting stops a disk measurement part-way, and a short wait is not stretched by a step that hangs', async () => {
  let started = 0
  let aborted = false
  const abortable: MeasureDiskUsage = (_path, signal) => {
    started += 1
    return new Promise((resolveMeasure) => {
      signal?.addEventListener('abort', () => {
        aborted = true
        resolveMeasure(null)
      })
    })
  }
  const harness = makeService({ measure: abortable })
  await lease(harness, 'first')
  const measuring = harness.service.measure(repo)
  while (started === 0) await new Promise((resolveTick) => setTimeout(resolveTick, 5))
  await harness.service.shutdown()
  assert.equal(aborted, true)
  await measuring

  // One that never ends, quitting for an update: the lock goes at the cap.
  let hanging = 0
  const stuck = makeService({
    measure: () => {
      hanging += 1
      return new Promise(() => {})
    },
  })
  await lease(stuck, 'second')
  void stuck.service.measure(repo)
  while (hanging === 0) await new Promise((resolveTick) => setTimeout(resolveTick, 5))
  const before = Date.now()
  await stuck.service.shutdown({ waitMs: 50 })
  assert.ok(Date.now() - before < 2_000, 'the short wait is kept')
  assert.equal(await exists(join(container, '.pool.lock')), false)
})

test('a Studio that lost the pool’s lock no longer returns a slot', async () => {
  const harness = makeService({ instanceId: 'this-one' })
  const leased = await lease(harness, 'mine')
  // Another Studio took the container over (it judged this one stale).
  await writeFile(
    join(container, '.pool.lock'),
    JSON.stringify({ pid: 1, host: 'build-box', instanceId: 'other', startedAt: Date.now() }),
  )
  assert.equal(await harness.service.release(leased.leaseId), 'busy')
  assert.equal(await git(leased.path, 'branch', '--show-current'), 'agent/mine', 'left as it was')
})

test('a second Studio holding the container gets no slot; a dead holder is taken over', async () => {
  await mkdir(container, { recursive: true })
  const held = await acquireInstanceLock(container, 'other-instance', { pidAlive: () => true, host: 'build-box' })
  assert.equal(held.ok, true)
  // Another machine's holder with a fresh heartbeat keeps it.
  const blocked = await makeService().service.lease({ repoRoot: repo, name: 'blocked' })
  assert.equal(blocked.ok ? null : blocked.reason, 'other-instance')

  // A holder on this machine whose process is gone is stale.
  await rm(join(container, '.pool.lock'))
  const { hostname } = await import('node:os')
  await writeFile(
    join(container, '.pool.lock'),
    JSON.stringify({ pid: 999_999_999, host: hostname(), instanceId: 'dead', startedAt: 0 }),
  )
  const taken = await makeService().service.lease({ repoRoot: repo, name: 'taken-over' })
  assert.equal(taken.ok, true)
})

test('a slot deleted from outside is forgotten and pruned, never leased', async () => {
  const harness = makeService()
  // A person's own worktree whose folder is missing (on a volume not mounted
  // now) is theirs: forgetting the slot must not prune it too.
  const own = join(caseDir, 'elsewhere', 'mine')
  await git(repo, 'worktree', 'add', '-q', '--detach', own)
  await rm(own, { recursive: true, force: true })
  const first = await lease(harness, 'first')
  await returnAll(harness)
  await rm(first.path, { recursive: true, force: true })
  const second = await lease(harness, 'second')
  assert.equal(second.created, true)
  assert.equal((await snapshot(harness)).slots.length, 1)
  const listed = await git(repo, 'worktree', 'list', '--porcelain')
  // The new slot took the old one's name; the old registration is gone.
  assert.equal(listed.split(`${basename(first.path)}\n`).length - 1, 1)
  assert.match(listed, /elsewhere\/mine\n/, 'the person’s missing worktree is still registered')
})

test('recovery removes a half-made slot, returns an interrupted lease, and resumes its own reset', async () => {
  const harness = makeService()
  const a = await lease(harness, 'a')
  const b = await lease(harness, 'b')
  const c = await lease(harness, 'c')
  await returnAll(harness, [a.path])
  // b and c are idle; a is still leased. Now forge what a crash leaves.
  const poolId = poolIdFor(join(repo, '.git'), 'local')
  const recordPath = join(userData, 'worktree-pool', `pool-${poolId}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as PoolRecord
  assert.equal(record.version, POOL_RECORD_VERSION)
  const base = await git(repo, 'rev-parse', 'origin/main')
  const moved = await pushToOrigin('moved.txt', 'moved\n')
  await git(repo, 'fetch', '-q', 'origin')
  // c: a reset cut short after `update-ref`, before the tree caught up.
  await git(c.path, 'update-ref', '--no-deref', 'HEAD', moved, base)
  for (const slot of record.slots) {
    if (slot.path === a.path) slot.op = { kind: 'lease', startedAt: 0, pid: 1 }
    if (slot.path === b.path) {
      slot.state = 'creating'
      slot.op = { kind: 'create', startedAt: 0, pid: 1 }
    }
    if (slot.path === c.path) slot.op = { kind: 'reset', startedAt: 0, pid: 1, fromSha: base, toSha: moved }
  }
  await writeFile(recordPath, JSON.stringify(record))
  await harness.service.shutdown()

  const restarted = makeService()
  restarted.clock.offset = 2 * HOUR
  // The first use recovers: b is removed, a's interrupted lease is finished as
  // a return (in the background), and c is left for the next lease to resume.
  const first = await lease(restarted, 'next')
  assert.equal(await exists(b.path), false, 'the interrupted create is removed')
  for (let tries = 0; tries < 100; tries += 1) {
    const states = (await snapshot(restarted)).slots.map((slot) => slot.state)
    if (!states.includes('returning')) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  const second = first.path === c.path ? null : await lease(restarted, 'after')
  assert.ok(first.path === c.path || second?.path === c.path, 'the half-reset slot is resumed and reused')
  assert.equal(await git(c.path, 'rev-parse', 'HEAD'), moved)
  assert.equal(await exists(join(c.path, 'moved.txt')), true)
  assert.equal(await git(c.path, 'status', '--porcelain'), '')
  assert.equal(
    (await snapshot(restarted)).slots.some((slot) => slot.path === a.path && slot.state !== 'held'),
    true,
    'the interrupted lease came back as a return, not a hold',
  )
})

test('a reset interrupted over a tree someone then edited is held, not re-run', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  const poolId = poolIdFor(join(repo, '.git'), 'local')
  const recordPath = join(userData, 'worktree-pool', `pool-${poolId}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as PoolRecord
  const base = await git(repo, 'rev-parse', 'origin/main')
  const moved = await pushToOrigin('moved.txt', 'moved\n')
  await git(repo, 'fetch', '-q', 'origin')
  await git(first.path, 'update-ref', '--no-deref', 'HEAD', moved, base)
  await writeFile(join(first.path, 'theirs.txt'), 'written while the app was down\n')
  record.slots[0].op = { kind: 'reset', startedAt: 0, pid: 1, fromSha: base, toSha: moved }
  await writeFile(recordPath, JSON.stringify(record))
  await harness.service.shutdown()

  const restarted = makeService()
  const next = await lease(restarted, 'next')
  assert.notEqual(next.path, first.path)
  assert.equal((await slotAt(restarted, 'app-01')).state, 'held')
  assert.equal(await readFile(join(first.path, 'theirs.txt'), 'utf8'), 'written while the app was down\n')
})

test('another profile’s leased slot in the shared container is never adopted, returned or unlocked', async () => {
  // Profile A leases, and quits: its pool's lock goes, its agent lock stays.
  const profileA = makeService({ instanceId: 'profile-a' })
  const theirs = await lease(profileA, 'theirs')
  await profileA.service.shutdown()
  const theirLock = await lockReason(theirs.path)
  assert.match(theirLock ?? '', /^agent /)

  // Profile B, with a record of its own that knows nothing of A's slot.
  const userDataB = join(caseDir, 'user-data-b')
  setAgentWorktreeLockProfile(userDataB)
  const profileB = makeService({ instanceId: 'profile-b', userData: userDataB })
  const ours = await lease(profileB, 'ours')
  assert.notEqual(ours.path, theirs.path)
  assert.deepEqual(
    (await snapshot(profileB)).slots.map((slot) => slot.id),
    [basename(ours.path)],
    'A’s slot is not B’s',
  )
  await returnAll(profileB)
  assert.equal(await git(theirs.path, 'branch', '--show-current'), 'agent/theirs')
  assert.equal(await lockReason(theirs.path), theirLock)
})

test('a slot this profile records but another profile has locked since is held, its lock left alone', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'contested')
  // Another profile's agent lock replaces ours.
  await git(repo, 'worktree', 'unlock', leased.path)
  setAgentWorktreeLockProfile(join(caseDir, 'user-data-other'))
  await lockAgentWorktree(repo, leased.path, 'their-agent')
  const theirLock = await lockReason(leased.path)
  setAgentWorktreeLockProfile(userData)

  await returnAll(harness)
  const slot = await slotAt(harness, leased.slotId)
  assert.equal(slot.state, 'held')
  assert.equal(await lockReason(leased.path), theirLock)
  assert.equal(await git(leased.path, 'branch', '--show-current'), 'agent/contested')
})

test('a chat reopened on a slot its record says is leased to it, but on another branch now, is refused', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const leased = await lease(harness, 'chat')
  await git(leased.path, 'switch', '-q', '-c', 'someone-else')
  const reclaimed = await harness.service.reclaim({ path: leased.path, branch: 'agent/chat', owner: 'agent-chat' })
  assert.equal(reclaimed?.ok, false)
  await git(leased.path, 'switch', '-q', 'agent/chat')
  const again = await harness.service.reclaim({ path: leased.path, branch: 'agent/chat', owner: 'agent-chat' })
  assert.equal(again?.ok, true)
})

test('a worktree merely named like a slot is never adopted', async () => {
  await mkdir(container, { recursive: true })
  await git(repo, 'worktree', 'add', '-q', '-b', 'mine', join(container, 'pool-01'))
  const harness = makeService()
  const leased = await lease(harness, 'agent')
  assert.notEqual(leased.path, join(container, 'pool-01'))
  assert.equal(
    (await snapshot(harness)).slots.some((slot) => slot.path.endsWith('pool-01')),
    false,
  )
})

test('a slot from before slots were named after their project is still adopted, and keeps its number', async () => {
  // A `pool-NN` slot made by an earlier version, whose record was lost.
  const harness = makeService()
  const first = await lease(harness, 'first')
  assert.match(first.path, /[\\/]app-01$/, 'a new slot is named after its project')
  await returnAll(harness)
  await harness.service.shutdown()
  const legacy = join(container, 'pool-01')
  await git(repo, 'worktree', 'move', first.path, legacy)
  const poolId = poolIdFor(join(repo, '.git'), 'local')
  await rm(join(userData, 'worktree-pool', `pool-${poolId}.json`))

  const restarted = makeService()
  const next = await lease(restarted, 'next')
  const slots = (await snapshot(restarted)).slots
  assert.equal(
    slots.some((slot) => slot.id === 'pool-01' && slot.path === legacy),
    true,
    'the marked pool-01 is adopted',
  )
  assert.match(next.path, /[\\/]app-02$/, 'number 1 is taken by pool-01, so the new slot is the second')
})

test('a repository on a WSL machine gets no pool', async () => {
  const harness = makeService()
  const result = await harness.service.lease({ repoRoot: repo, name: 'wsl', hostId: 'wsl:Ubuntu' })
  assert.equal(result.ok ? null : result.reason, 'unsupported')
  // Declined before any git looks the folder up: under that machine's scope
  // the lookup would be its git, and its answer remembered for this one's.
  const unlooked = await harness.service.lease({
    repoRoot: join(caseDir, 'nowhere'),
    name: 'wsl',
    hostId: 'wsl:Ubuntu',
  })
  assert.equal(unlooked.ok ? null : unlooked.reason, 'unsupported')
})

test('the agent worktree cleanup hands pool slots back instead of removing them, and deletes merged agent branches', async () => {
  const harness = makeService()
  const pooled = await lease(harness, 'pooled')
  harness.clock.offset += 2 * HOUR
  // A plain agent branch whose work was squash-merged, one merged by ancestry,
  // and one with work the default branch lacks.
  await git(repo, 'switch', '-q', '-c', 'agent/squashed', 'origin/main')
  await writeFile(join(repo, 'squashed.txt'), 'squashed\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'squashed work')
  await git(repo, 'switch', '-q', 'main')
  await git(repo, 'merge', '-q', '--squash', 'agent/squashed')
  await git(repo, 'commit', '-q', '-m', 'squash merge')
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'fetch', '-q', 'origin')
  await git(repo, 'branch', 'agent/merged', 'origin/main')
  await git(repo, 'branch', 'agent/merged-chat', 'origin/main')
  await git(repo, 'switch', '-q', '-c', 'agent/unmerged')
  await writeFile(join(repo, 'unmerged.txt'), 'unmerged\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'unmerged work')
  await git(repo, 'switch', '-q', 'main')

  const report = await cleanupAgentWorktrees(
    // A chat still records `agent/squashed-chat`: restored from it, so kept.
    { repoRoot: repo, protectedPaths: [], agentIds: [], keepBranches: ['agent/merged-chat'], ownedOnly: true },
    { pool: harness.service, now: () => Date.now() + 2 * HOUR, log: () => {} },
  )
  assert.deepEqual(
    report.entries.map((entry) => [entry.verdict, entry.branch]),
    [['returned', 'agent/pooled']],
  )
  assert.equal(await exists(pooled.path), true, 'the slot stays on disk')
  assert.deepEqual(report.deletedBranches?.sort(), ['agent/merged', 'agent/pooled', 'agent/squashed'])
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/unmerged'), 'unmerged work keeps its branch')
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/merged-chat'), 'a branch a chat records is kept')

  // A caller that names no records deletes nothing.
  await git(repo, 'branch', 'agent/unknown', 'origin/main')
  const blind = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, { log: () => {} })
  assert.deepEqual(blind.deletedBranches, [])
})

test('the cleanup never deletes a branch a worktree has checked out', async () => {
  const harness = makeService()
  await lease(harness, 'live')
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], agentIds: [], keepBranches: [] },
    { pool: harness.service, log: () => {} },
  )
  assert.deepEqual(report.deletedBranches, [])
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/live'))
})

test('createGitWorktree with fromPool leases from the installed pool, and without one forks the default branch', async () => {
  await git(repo, 'switch', '-q', '-c', 'feature/local')
  await writeFile(join(repo, 'local.txt'), 'local\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'local work')
  const originMain = await git(repo, 'rev-parse', 'origin/main')
  const input = (name: string) => ({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, name),
    branchName: `agent/${name}`,
    baseRef: 'HEAD',
    agentLockOwner: `agent/${name}`,
    fromPool: true,
  })

  // No pool in this process (the out-of-process server): fresh, at origin/main.
  const fresh = await createGitWorktree(input('fresh'))
  assert.equal(fresh.ok, true, fresh.ok ? '' : fresh.message)
  if (!fresh.ok) return
  assert.equal(fresh.data.path.endsWith('fresh'), true)
  assert.equal(fresh.data.baseRef, 'origin/main')
  assert.equal(fresh.data.leaseId, null)
  assert.equal(await git(fresh.data.path, 'rev-parse', 'HEAD'), originMain)

  const harness = makeService()
  installWorktreePool(harness.service)
  const pooled = await createGitWorktree(input('pooled'))
  assert.equal(pooled.ok, true, pooled.ok ? '' : pooled.message)
  if (!pooled.ok) return
  assert.match(pooled.data.path, /app-01$/)
  assert.equal(pooled.data.branch, 'agent/pooled')
  assert.equal(pooled.data.baseRef, 'origin/main')
  assert.ok(pooled.data.leaseId)
  // Built from the lease, with no listing read back, and as git would list it.
  const listed = await listGitWorktrees(repo)
  const asListed = listed.ok ? listed.data.worktrees.find((worktree) => worktree.path === pooled.data.path) : null
  assert.ok(asListed, 'git lists the slot at the path the lease gave')
  const { baseRef: _baseRef, leaseId: _leaseId, dependencyInstall: _install, ...entry } = pooled.data
  assert.deepEqual(entry, asListed)

  const taken = await createGitWorktree(input('pooled'))
  assert.equal(taken.ok, false, 'an existing branch is reported, not papered over with a fresh worktree')
})

test('a pool that throws on a lease is a pool declining: createGitWorktree makes a fresh worktree', async () => {
  const throwing = {
    lease: () => Promise.reject(new Error('record not writable')),
  } as unknown as Parameters<typeof installWorktreePool>[0]
  installWorktreePool(throwing)
  const created = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'fallback'),
    branchName: 'agent/fallback',
    baseRef: 'HEAD',
    fromPool: true,
  })
  assert.equal(created.ok, true, created.ok ? '' : created.message)
  if (!created.ok) return
  assert.equal(created.data.path.endsWith('fallback'), true)
  assert.equal(created.data.leaseId, null)
})

test('after a failed fetch, leases fork from the ref as it stands without trying again until the backoff ends', async () => {
  // Offline: the remote is unreachable.
  await git(repo, 'remote', 'set-url', 'origin', join(caseDir, 'gone.git'))
  const before = await git(repo, 'rev-parse', 'origin/main')
  let fetches = 0
  const counting: SlotGitRunner = (cwd, args, options) => {
    if (args[0] === 'fetch') fetches += 1
    return defaultSlotGitRunner(cwd, args, options)
  }
  const harness = makeService({ git: counting, fetchBackoffMs: HOUR })
  const first = await lease(harness, 'offline-one')
  assert.equal(fetches, 1)
  assert.equal(first.baseSha, before)
  assert.match(first.baseNote ?? '', /could not be fetched/)
  const second = await lease(harness, 'offline-two')
  assert.equal(fetches, 1, 'no second wait on a remote that just failed')
  assert.match(second.baseNote ?? '', /was not fetched/)
  // Past the backoff it is tried again, and once it works the note goes.
  await git(repo, 'remote', 'set-url', 'origin', origin)
  harness.clock.offset += 2 * HOUR
  const third = await lease(harness, 'online-again')
  assert.equal(fetches, 2)
  assert.equal(third.baseNote, null)
})

test('a lease’s submodule update and LFS pull run under a deadline, and failing is a note, not a failed lease', async () => {
  await pushToOrigin('.gitmodules', '')
  await pushToOrigin('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  const deadlines = new Map<string, number | null | undefined>()
  const recording: SlotGitRunner = (cwd, args, options) => {
    if (args[0] === 'submodule' || args[0] === 'lfs') {
      deadlines.set(args[0], options?.timeoutMs)
      // As a run past its deadline answers.
      return Promise.resolve({ ok: false, stdout: '', stderr: '', message: `${args[0]} did not finish` })
    }
    return defaultSlotGitRunner(cwd, args, options)
  }
  const harness = makeService({ git: recording })
  const leased = await lease(harness, 'with-modules')
  assert.ok((deadlines.get('submodule') ?? 0) > 0, 'submodule update has a deadline')
  assert.ok((deadlines.get('lfs') ?? 0) > 0, 'lfs pull has a deadline')
  assert.match((await slotAt(harness, leased.slotId)).error ?? '', /submodules: .*; lfs: /)
})

test('a .worktreeinclude copy that fails is logged and the lease goes ahead', async () => {
  const lines: string[] = []
  const answers: Array<() => Promise<unknown>> = [
    () => Promise.reject(new Error('disk full')),
    () => Promise.resolve({ ok: false, message: 'source unreadable' }),
  ]
  const service = createWorktreePoolService({
    store: createPoolStore(userData),
    log: (line) => lines.push(line),
    timers: false,
    fetchFreshMs: 0,
    seedIncludedFiles: () => answers.shift()!(),
  })
  for (const name of ['seed-throws', 'seed-fails']) {
    const leased = await service.lease({ repoRoot: repo, name, copyIncludedFiles: true })
    assert.equal(leased.ok, true)
  }
  assert.ok(lines.some((line) => /could not copy the \.worktreeinclude files \(disk full\)/.test(line)))
  assert.ok(lines.some((line) => /could not copy the \.worktreeinclude files \(source unreadable\)/.test(line)))
})

test('a recovery that failed is tried again at the next use, not remembered as done', async () => {
  let listings = 0
  const flaky: SlotGitRunner = (cwd, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'list') {
      listings += 1
      if (listings === 1) return Promise.resolve({ ok: false, stdout: '', stderr: '', message: 'volume busy' })
    }
    return defaultSlotGitRunner(cwd, args, options)
  }
  const harness = makeService({ git: flaky })
  await lease(harness, 'first')
  assert.equal(listings, 1)
  await lease(harness, 'second')
  assert.equal(listings, 2, 'recovery ran again')
  await lease(harness, 'third')
  assert.equal(listings, 2, 'and, once it succeeded, not again')
})

test('a fresh worktree made because the pool declined forks from the base the pool already fetched', async () => {
  // A ref only the pool names: the fresh path's own lookup would say origin/main.
  await git(repo, 'update-ref', 'refs/remotes/origin/pool-base', 'HEAD')
  const declining = {
    lease: async () => ({
      ok: false,
      reason: 'full',
      message: 'full',
      base: { ref: 'origin/pool-base', sha: await git(repo, 'rev-parse', 'HEAD'), note: null },
    }),
  } as unknown as Parameters<typeof installWorktreePool>[0]
  installWorktreePool(declining)
  const created = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'declined'),
    branchName: 'agent/declined',
    baseRef: 'HEAD',
    fromPool: true,
  })
  assert.equal(created.ok, true, created.ok ? '' : created.message)
  if (!created.ok) return
  assert.equal(created.data.baseRef, 'origin/pool-base')
})

test('a record that cannot be written fails its caller and nothing else (no unhandled rejection)', async () => {
  // A file where the store's folder should be: every write fails.
  await writeFile(join(caseDir, 'not-a-folder'), '')
  const store = createPoolStore(join(caseDir, 'not-a-folder'))
  const record = { poolId: '0123456789abcdef', slots: [] } as unknown as PoolRecord
  await assert.rejects(store.write(record))
  await assert.rejects(store.writeSettings({} as never))
  // Give a stray rejection the turn it needs to be reported.
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
})

test('a project that opted in installs in a leased slot once per lockfile, and records it in git’s admin directory', async () => {
  await pushToOrigin('package-lock.json', '{"lockfileVersion":3}\n')
  const input = (name: string) => ({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, name),
    branchName: `agent/${name}`,
    baseRef: 'HEAD',
    agentLockOwner: `agent/${name}`,
    fromPool: true,
  })
  const calls: string[] = []
  const harness = makeService()
  installWorktreePool(harness.service)
  installDependencyInstaller(
    createDependencyInstaller({
      env: async () => ({}),
      run: async ({ command, cwd }) => {
        calls.push(command)
        await mkdir(join(cwd, 'node_modules'), { recursive: true })
        return { code: 0, timedOut: false, cancelled: false }
      },
      log: () => {},
    }),
  )
  try {
    const off = await createGitWorktree(input('before-opting-in'))
    assert.equal(off.ok && off.data.dependencyInstall, null, 'off until the project opts in')
    await returnAll(harness)

    await harness.service.updateSettings({ dependencyInstall: { [repo]: { enabled: true, command: null } } })
    const first = await createGitWorktree(input('first'))
    assert.equal(first.ok, true, first.ok ? '' : first.message)
    if (!first.ok) return
    assert.match(first.data.path, /app-01$/)
    assert.equal(first.data.dependencyInstall?.state, 'succeeded')
    assert.equal(first.data.dependencyInstall?.command, 'npm ci')
    assert.ok(await exists(join(repo, '.git', 'worktrees', 'app-01', DEPENDENCY_INSTALL_RECORD)))
    assert.equal(await git(first.data.path, 'status', '--porcelain'), '', 'the worktree itself is untouched')
    await returnAll(harness)

    const second = await createGitWorktree(input('second'))
    assert.equal(second.ok && second.data.path, first.data.path, 'the same slot again')
    assert.equal(second.ok && second.data.dependencyInstall, null, 'same lockfile: no install')
    assert.deepEqual(calls, ['npm ci'])
  } finally {
    installDependencyInstaller(null)
  }
})

test('a fresh worktree made because the pool is full installs too, and a caller may only start the install', async () => {
  await pushToOrigin('package-lock.json', '{"lockfileVersion":3}\n')
  const input = (name: string, extra: Partial<Parameters<typeof createGitWorktree>[0]> = {}) => ({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, name),
    branchName: `agent/${name}`,
    baseRef: 'HEAD',
    agentLockOwner: `agent/${name}`,
    fromPool: true,
    ...extra,
  })
  const calls: string[] = []
  const harness = makeService()
  installWorktreePool(harness.service)
  installDependencyInstaller(
    createDependencyInstaller({
      env: async () => ({}),
      nodeVersion: async () => 'v22.12.0',
      run: async ({ command, cwd }) => {
        calls.push(`${command} in ${basename(cwd)}`)
        await mkdir(join(cwd, 'node_modules'), { recursive: true })
        return { code: 0, timedOut: false, cancelled: false }
      },
      log: () => {},
    }),
  )
  try {
    await harness.service.updateSettings({
      maxSlots: 2,
      dependencyInstall: { [repo]: { enabled: true, command: null } },
    })
    // Two slots held, so the third lease is declined and a plain worktree made.
    assert.equal((await createGitWorktree(input('one'))).ok, true)
    assert.equal((await createGitWorktree(input('two'))).ok, true)
    const fresh = await createGitWorktree(input('three'))
    assert.equal(fresh.ok, true, fresh.ok ? '' : fresh.message)
    if (!fresh.ok) return
    assert.equal(fresh.data.leaseId, null, 'not a pool slot')
    assert.equal(fresh.data.path, join(container, 'three'))
    assert.equal(fresh.data.dependencyInstall?.state, 'succeeded', 'the worktree with no node_modules at all installs')
    assert.equal(fresh.data.dependencyInstall?.reason, 'first')
    assert.ok(calls.includes('npm ci in three'))
  } finally {
    installDependencyInstaller(null)
  }
})

test('asked only to start it, the worktree comes back while its install runs, and how it ends is asked after', async () => {
  await pushToOrigin('package-lock.json', '{"lockfileVersion":3}\n')
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const harness = makeService()
  installWorktreePool(harness.service)
  const installer = createDependencyInstaller({
    env: async () => ({}),
    nodeVersion: async () => 'v22.12.0',
    run: async ({ cwd }) => {
      await gate
      await mkdir(join(cwd, 'node_modules'), { recursive: true })
      return { code: 0, timedOut: false, cancelled: false }
    },
    log: () => {},
  })
  installDependencyInstaller(installer)
  try {
    await harness.service.updateSettings({ dependencyInstall: { [repo]: { enabled: true, command: null } } })
    const made = await createGitWorktree({
      repoRoot: repo,
      containerPath: container,
      destinationPath: join(container, 'quick'),
      branchName: 'agent/quick',
      baseRef: 'HEAD',
      agentLockOwner: 'agent/quick',
      fromPool: true,
      dependencyInstall: 'start',
    })
    assert.equal(made.ok, true, made.ok ? '' : made.message)
    if (!made.ok) return
    const running = made.data.dependencyInstall
    assert.equal(running?.state, 'running', 'answered before the install ended')
    assert.deepEqual(
      installer.list().map((view) => view.id),
      [running!.id],
    )
    release()
    const ended = await installer.settled(running!.id)
    assert.equal(ended?.state, 'succeeded')
    assert.equal((await installer.settled(running!.id))?.state, 'succeeded', 'and still answers once it is over')
  } finally {
    installDependencyInstaller(null)
  }
})

/**
 * An agent's connection as the gateway leaves it once the agent's launch
 * token checked out: declared, and bound to its conversation.
 */
function provenAgent(workspaceId: string, agentId: string): McpConnectionContext {
  const context: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId, agentId } }
  bindGatewayConversation(context, { workspaceId, agentId })
  return context
}

test('worktree.lease serves only an agent Studio started, and only that agent can release it', async () => {
  const harness = makeService()
  const tools = createWorktreePoolTools({
    pool: harness.service,
    findWorkspace: (workspaceId) => (workspaceId === 'ws-1' ? { folderPath: repo } : null),
  })
  const [leaseTool, releaseTool] = tools
  const agent = provenAgent('ws-1', 'agent-1')

  const refused = await leaseTool.handler({ name: 'x' }, { metadata: { kind: 'external-local' } })
  assert.equal(refused.isError, true)
  // An agent declared without a launch token proves nothing: anything that
  // can reach the socket can declare one.
  const declared = await leaseTool.handler(
    { name: 'declared' },
    { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' } },
  )
  assert.equal(declared.isError, true)

  const leased = await leaseTool.handler({ name: 'by-tool' }, agent)
  assert.equal(leased.isError ?? false, false)
  const path = (leased.structuredContent as { path: string }).path
  assert.match(path, /app-01$/)

  const stranger = await releaseTool.handler({ path }, provenAgent('ws-1', 'agent-2'))
  assert.equal(stranger.isError, true)
  // Another chat's agent with the same id (ids repeat across older chats).
  const namesake = await releaseTool.handler({ path }, provenAgent('ws-2', 'agent-1'))
  assert.equal(namesake.isError, true)
  // The right ids, declared but not proven, release nothing either.
  const unproven = await releaseTool.handler(
    { path },
    { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' } },
  )
  assert.equal(unproven.isError, true)

  const released = await releaseTool.handler({ path }, agent)
  assert.equal((released.structuredContent as { released: boolean }).released, true)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')
})

test('worktree.lease runs the project’s opted-in install before answering, and says how it went', async () => {
  const harness = makeService()
  const asked: Array<{ repoRoot: string; path: string; branch: string }> = []
  const tools = createWorktreePoolTools({
    pool: harness.service,
    findWorkspace: () => ({ folderPath: repo }),
    installDependencies: async (request) => {
      asked.push(request)
      return {
        id: 'i1',
        repoRoot: request.repoRoot,
        path: request.path,
        branch: request.branch,
        command: 'npm ci',
        reason: 'first',
        state: 'succeeded',
        startedAt: 0,
        endedAt: 1,
        lastLine: null,
        output: null,
        exitCode: 0,
      }
    },
  })
  const leased = await tools[0].handler({ name: 'with-install' }, provenAgent('ws-1', 'agent-1'))
  const answer = leased.structuredContent as { path: string; branch: string; dependencies: string }
  assert.deepEqual(asked, [{ repoRoot: await realpath(repo), path: answer.path, branch: 'agent/with-install' }])
  assert.match(answer.dependencies, /npm ci` succeeded/)
  assert.doesNotMatch(tools[0].description, /never installs/)
})

test('slot status parsing reads branch, commit and every kind of change', () => {
  const oid = 'a'.repeat(40)
  const status = parseSlotStatus(
    [
      `# branch.oid ${oid}`,
      '# branch.head agent/x',
      `1 .M N... 100644 100644 100644 ${oid} ${oid} README.md`,
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new.txt`,
      'old.txt',
      '? untracked.txt',
      '',
    ].join('\0'),
  )
  assert.equal(status.oid, oid)
  assert.equal(status.branch, 'agent/x')
  assert.equal(status.changedPaths, 3)
  assert.deepEqual(status.trackedPaths, ['README.md', 'new.txt', 'old.txt'])
  assert.deepEqual(status.untrackedPaths, ['untracked.txt'])
  assert.equal(parseSlotStatus('# branch.oid (initial)\0# branch.head (detached)\0').branch, null)
})

test('leases reuse the least recently returned slot, keeping a just-settled chat’s worktree free longest', async () => {
  const harness = makeService()
  const older = await lease(harness, 'older')
  const newer = await lease(harness, 'newer')
  await returnAll(harness, [newer.path])
  await returnAll(harness)
  const next = await lease(harness, 'next')
  assert.equal(next.path, older.path)
})

test('a settled chat’s returned slot is given back to it on its branch when the chat is restored', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  await mkdir(join(chat.path, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(chat.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(chat.path, 'feature.txt'), 'feature\n')
  await git(chat.path, 'add', 'feature.txt')
  await git(chat.path, 'commit', '-q', '-m', 'feature')
  await returnAll(harness)
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')

  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, true, restored.ok ? '' : restored.message)
  assert.equal(await git(chat.path, 'branch', '--show-current'), 'agent/chat')
  assert.equal(await readFile(join(chat.path, 'feature.txt'), 'utf8'), 'feature\n')
  assert.equal(await exists(join(chat.path, 'node_modules', 'dep', 'index.js')), true)
  assert.equal((await slotAt(harness, 'app-01')).state, 'leased')
  // Asking again (a second window) is answered as done.
  const again = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(again.ok, true)
})

test('a returned slot given to another agent since is refused to its old chat, with the reason', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  await returnAll(harness)
  const other = await lease(harness, 'other')
  assert.equal(other.path, chat.path)
  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, false)
  assert.match(restored.ok ? '' : restored.message, /given to another agent/)
  assert.equal(await git(chat.path, 'branch', '--show-current'), 'agent/other', 'the other agent is untouched')

  // The branch deleted meanwhile is a refusal for good.
  await returnAll(harness)
  await git(repo, 'branch', '-D', 'agent/chat')
  const gone = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(gone.ok, false)
  assert.equal('definitive' in gone && gone.definitive, true)
})

test('a slot is not given back to its chat over commits no branch has, made on it while idle', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  await returnAll(harness)
  // Someone commits on the idle slot's detached HEAD.
  await writeFile(join(chat.path, 'stray.txt'), 'stray\n')
  await git(chat.path, 'add', '.')
  await git(chat.path, 'commit', '-q', '-m', 'stray')
  const stray = await git(chat.path, 'rev-parse', 'HEAD')
  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, false)
  assert.equal(await git(chat.path, 'rev-parse', 'HEAD'), stray, 'HEAD still reaches the commit')
  assert.equal((await slotAt(harness, 'app-01')).state, 'held')
})

test('a slot held with its chat’s uncommitted work opens for that chat, and for no other', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  await writeFile(join(chat.path, 'wip.txt'), 'unsaved\n')
  await returnAll(harness)
  assert.equal((await slotAt(harness, 'app-01')).state, 'held')

  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, true, restored.ok ? '' : restored.message)
  assert.equal(await readFile(join(chat.path, 'wip.txt'), 'utf8'), 'unsaved\n', 'the work is where it was left')
  // Leased to the chat again: the Worktree manager offers no Discard on a
  // folder the open chat works in, and nothing else can be given it.
  assert.equal((await slotAt(harness, 'app-01')).state, 'leased')
  assert.equal((await slotAt(harness, 'app-01')).lease?.branch, 'agent/chat')

  const stranger = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/stranger' })
  assert.equal(stranger.ok, false)
  assert.match(stranger.ok ? '' : stranger.message, /given to another agent/)

  // Returned again with the work still uncommitted, it is held again.
  await returnAll(harness)
  assert.equal((await slotAt(harness, 'app-01')).state, 'held')
  assert.equal(await readFile(join(chat.path, 'wip.txt'), 'utf8'), 'unsaved\n')
})

test('a slot is not given back to its chat over ignored files a later agent left where the chat’s branch tracks one', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  // The chat's branch tracks a file the default branch ignores.
  await writeFile(join(chat.path, '.env'), 'CHAT=1\n')
  await git(chat.path, 'add', '-f', '.env')
  await git(chat.path, 'commit', '-q', '-m', 'track env')
  await returnAll(harness)
  // A later agent in the same slot writes its own, ignored there.
  const other = await lease(harness, 'other')
  assert.equal(other.path, chat.path)
  await writeFile(join(other.path, '.env'), 'OTHER=1\n')
  await returnAll(harness)

  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, false)
  assert.match(restored.ok ? '' : restored.message, /ignored files its branch would overwrite \(\.env\)/)
  assert.equal(await readFile(join(chat.path, '.env'), 'utf8'), 'OTHER=1\n', 'the later agent’s file is untouched')
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle')
})

test('a pool holds no more worktrees than its limit, and lowering the limit removes idle ones', async () => {
  const harness = makeService()
  await harness.service.updateSettings({ maxSlots: 2 })
  await lease(harness, 'one')
  await lease(harness, 'two')
  const third = await harness.service.lease({ repoRoot: repo, name: 'three' })
  assert.equal(third.ok, false)
  assert.equal(third.ok ? null : third.reason, 'full', 'the caller makes a plain worktree instead')

  await harness.service.updateSettings({ maxSlots: 12 })
  await lease(harness, 'three')
  await returnAll(harness)
  assert.equal((await snapshot(harness)).slots.length, 3, 'three idle, within keepIdle')
  await harness.service.updateSettings({ maxSlots: 2 })
  assert.equal((await snapshot(harness)).slots.length, 2, 'the limit applies at once')
})

test('past the disk limit the least recently used idle slots go first; one in use never does', async () => {
  const harness = makeService({ measure: fakeMeasure(GB) })
  const a = await lease(harness, 'a')
  const b = await lease(harness, 'b')
  const c = await lease(harness, 'c')
  harness.clock.offset += 2 * HOUR
  await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [b.path, c.path], agentIds: new Set() })
  harness.clock.offset += 60_000
  await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [c.path], agentIds: new Set() })
  // a went back before b, so a is the least recently used. 3 GB measured.
  await harness.service.measure()
  assert.equal((await snapshot(harness)).slots.length, 3, 'no limit, nothing removed')

  await harness.service.updateSettings({ diskLimitGb: 2.5 })
  const slots = (await snapshot(harness)).slots
  assert.deepEqual(slots.map((slot) => slot.path).sort(), [b.path, c.path].sort())
  assert.equal(await exists(a.path), false)

  await harness.service.updateSettings({ diskLimitGb: 0.5 })
  const left = (await snapshot(harness)).slots
  assert.deepEqual(
    left.map((slot) => [slot.path, slot.state]),
    [[c.path, 'leased']],
    'over the limit still, but a slot in use is never removed',
  )
})

test('clearing an idle slot deletes its ignored files and keeps it; a slot remembers its uses and last branch', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await mkdir(join(first.path, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(first.path, 'node_modules', 'pkg', 'index.js'), 'x\n')
  await returnAll(harness)
  const idle = await slotAt(harness, 'app-01')
  assert.equal(idle.uses, 1)
  assert.equal(idle.lastBranch, 'agent/first')
  assert.equal(idle.lease, null)

  const leasedSlot = await lease(harness, 'second', { agentId: 'agent-7' })
  const leasedView = await slotAt(harness, 'app-01')
  assert.equal(leasedView.uses, 2)
  assert.equal(leasedView.lease?.agentId, 'agent-7')
  const refused = await harness.service.action({ kind: 'clear-ignored', repoRoot: repo, slotId: 'app-01' })
  assert.equal(refused.ok, false, 'never while it is leased')
  assert.equal(await exists(join(leasedSlot.path, 'node_modules', 'pkg', 'index.js')), true)

  await harness.service.release(leasedSlot.leaseId)
  const cleared = await harness.service.action({ kind: 'clear-ignored', repoRoot: repo, slotId: 'app-01' })
  assert.equal(cleared.ok, true, cleared.message ?? '')
  assert.equal(await exists(join(first.path, 'node_modules')), false)
  assert.equal(await exists(join(first.path, 'README.md')), true, 'tracked files stay')
  const after = await slotAt(harness, 'app-01')
  assert.equal(after.state, 'idle')
  assert.equal(after.size?.bytes, GB, 'measured again')
})

test('removing a worktree outside the pool from Settings is checked as an eviction is', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'pooled')
  const live: string[] = []
  const inventory = createWorktreeInventory({
    pool: harness.service,
    livePaths: () => live,
    knownWorkspaceIds: () => [],
    removeWorktree: removeGitWorktree,
  })
  const byHand = join(caseDir, 'by-hand')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature/by-hand', byHand, 'origin/main')

  const pooled = await inventory.removeOther({ repoRoot: repo, path: leased.path })
  assert.equal(pooled.ok, false, 'a pool slot is the pool’s to remove')

  live.push(join(byHand, 'src'))
  const working = await inventory.removeOther({ repoRoot: repo, path: byHand })
  assert.equal(working.ok, false)
  assert.match(working.message ?? '', /working in it/)
  live.length = 0

  // An edited `.env` is ignored, so git status never shows it.
  await writeFile(join(byHand, '.env'), 'TOKEN=mine\n')
  const kept = await inventory.removeOther({ repoRoot: repo, path: byHand })
  assert.equal(kept.ok, false)
  assert.match(kept.message ?? '', /\.env/)
  assert.equal(await exists(byHand), true)

  await rm(join(byHand, '.env'))
  const removed = await inventory.removeOther({ repoRoot: repo, path: byHand })
  assert.equal(removed.ok, true, removed.message ?? '')
  assert.equal(await exists(byHand), false)
  assert.equal(await git(repo, 'branch', '--list', 'feature/by-hand'), 'feature/by-hand', 'the branch is kept')
})

test('the inventory lists every worktree but the checkout, with pool slots, merge state, changes and sizes', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'pooled')
  // A worktree made by hand whose branch is merged (it adds nothing), and one
  // with a commit of its own and an uncommitted file.
  const merged = join(caseDir, 'by-hand-merged')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature/merged', merged, 'origin/main')
  const unmerged = join(caseDir, 'by-hand-unmerged')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature/unmerged', unmerged, 'origin/main')
  await writeFile(join(unmerged, 'new.txt'), 'new\n')
  await git(unmerged, 'add', 'new.txt')
  await git(unmerged, 'commit', '-q', '-m', 'new')
  await writeFile(join(unmerged, 'draft.txt'), 'draft\n')

  const sizes = new Map([[merged, 2 * GB]])
  const inventory = createWorktreeInventory({ pool: harness.service, measure: fakeMeasure(GB, sizes) })
  const before = await inventory.read({ repoRoots: [join(leased.path)] })
  assert.equal(before.measuredAt, null, 'nothing measured until asked')

  const read = await inventory.read({ repoRoots: [repo], measure: true })
  assert.equal(read.projects.length, 1, 'the slot and the checkout are one project')
  const project = read.projects[0]
  assert.equal(project.defaultRef, 'origin/main')
  assert.equal(project.pool?.slots.length, 1)
  const byPath = new Map(project.worktrees.map((entry) => [entry.path, entry]))
  assert.equal(byPath.has(repo), false, 'the main checkout is not listed')

  const slot = byPath.get(leased.path)
  assert.equal(slot?.slotId, 'app-01')
  assert.equal(slot?.size?.bytes, GB, 'the pool measured its slot')

  const mergedEntry = byPath.get(merged)
  assert.equal(mergedEntry?.slotId, null)
  assert.equal(mergedEntry?.merged, true)
  assert.equal(mergedEntry?.changedPaths, 0)
  assert.equal(mergedEntry?.size?.bytes, 2 * GB)

  const unmergedEntry = byPath.get(unmerged)
  assert.equal(unmergedEntry?.merged, false)
  assert.equal(unmergedEntry?.uniqueCommits, 1)
  assert.equal(unmergedEntry?.changedPaths, 1)
  assert.deepEqual(unmergedEntry?.changes, [{ code: '??', path: 'draft.txt' }])
  assert.ok(read.measuredAt !== null)

  // Sizes stay known after, without measuring again.
  const again = await inventory.read({ repoRoots: [repo] })
  assert.equal(again.projects[0].worktrees.find((entry) => entry.path === merged)?.size?.bytes, 2 * GB)
})

test('a ready slot unused for a day goes, kept number or not; one in use never does', async () => {
  const harness = makeService()
  const idle = await lease(harness, 'idle')
  const busy = await lease(harness, 'busy')
  harness.clock.offset += 2 * HOUR
  await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [busy.path], agentIds: new Set() })
  assert.equal((await slotAt(harness, 'app-01')).state, 'idle', 'within keepIdle, it stays for now')

  harness.clock.offset += 23 * HOUR
  await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [busy.path], agentIds: new Set() })
  assert.equal((await snapshot(harness)).slots.length, 2, 'not a day yet')

  harness.clock.offset += 2 * HOUR
  await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [busy.path], agentIds: new Set() })
  const slots = (await snapshot(harness)).slots
  assert.deepEqual(
    slots.map((slot) => slot.path),
    [busy.path],
    'the sweep removes the one a day unused; the leased one stays',
  )
  assert.equal(await exists(idle.path), false)
})

// ── Giving back slots whose chat still exists ──────────────────────────────

/** A worktree chat whose folder is `leased`'s slot, on its branch: idle and off screen unless told otherwise. */
function chatOn(
  leased: { path: string; branch: string },
  workspaceId: string,
  patch: Partial<PoolChat> = {},
): PoolChat {
  return {
    workspaceId,
    folderPath: leased.path,
    branch: leased.branch,
    otherPaths: [],
    open: false,
    lastActiveAt: null,
    ...patch,
  }
}

/** The cleanup's sweep with `paths` still on record, the clock first moved on by `hours`. */
async function sweep(
  harness: Harness,
  paths: string[],
  hours = 0,
  agents: { agentIds?: ReadonlySet<string>; agentKeys?: ReadonlySet<string> } = {},
) {
  harness.clock.offset += hours * HOUR
  return harness.service.returnUnused({ repoRoot: repo, protectedPaths: paths, agentIds: new Set(), ...agents })
}

test('a full pool gives back a clean, idle chat’s slot to lease, keeping the chat’s branch and its path', async () => {
  const harness = makeService({ chats: [] })
  await harness.service.updateSettings({ maxSlots: 2 })
  const first = await lease(harness, 'first')
  const second = await lease(harness, 'second')
  harness.chats!.push(chatOn(first, 'ws-1'), chatOn(second, 'ws-2'))
  harness.clock.offset += 2 * HOUR

  const third = await lease(harness, 'third')
  assert.equal(third.created, true)
  assert.notEqual(third.path, first.path, 'the path stays its chat’s, not the next lease’s')
  assert.equal(await exists(first.path), false, 'the least recently used one was removed to make room')
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/first'), 'its branch is kept')
  assert.deepEqual(harness.givenBack, [first.path], 'its chat is told, so opening it brings the worktree back')
  assert.equal(await git(second.path, 'branch', '--show-current'), 'agent/second', 'the other chat is untouched')
  assert.equal((await snapshot(harness)).slots.length, 2, 'the pool is still within its limit')
})

test('a full pool refuses only when no slot can be given back, naming each slot and what holds it', async () => {
  const harness = makeService({ chats: [] })
  await harness.service.updateSettings({ maxSlots: 5 })
  const dirty = await lease(harness, 'dirty')
  const unpushed = await lease(harness, 'unpushed')
  const working = await lease(harness, 'working')
  const terminal = await lease(harness, 'terminal')
  const onScreen = await lease(harness, 'on-screen')
  harness.chats!.push(
    chatOn(dirty, 'ws-1'),
    chatOn(unpushed, 'ws-2'),
    chatOn(working, 'ws-3'),
    chatOn(terminal, 'ws-4'),
    chatOn(onScreen, 'ws-5', { open: true }),
  )
  await writeFile(join(dirty.path, 'notes.txt'), 'wip\n')
  await writeFile(join(unpushed.path, 'feature.txt'), 'feature\n')
  await git(unpushed.path, 'add', 'feature.txt')
  await git(unpushed.path, 'commit', '-q', '-m', 'feature')
  harness.sessions.push(working.path)
  harness.live.push(terminal.path)
  harness.clock.offset += 2 * HOUR

  const refused = await harness.service.lease({ repoRoot: repo, name: 'sixth' })
  assert.equal(refused.ok ? null : refused.reason, 'full')
  const message = refused.ok ? '' : refused.message
  assert.match(message, /The pool already has 5 worktrees, and none can be given back now/)
  assert.match(message, /app-01 \(agent\/dirty\): 1 uncommitted change;/)
  assert.match(message, /app-02 \(agent\/unpushed\): it has commits not pushed/)
  assert.match(message, /app-03 \(agent\/working\): a turn or a background agent is running in it/)
  assert.match(message, /app-04 \(agent\/terminal\): a terminal is open in it/)
  assert.match(message, /app-05 \(agent\/on-screen\): its chat is open on screen/)
  for (const leased of [dirty, unpushed, working, terminal, onScreen]) {
    assert.equal(await git(leased.path, 'branch', '--show-current'), leased.branch, `${leased.branch} is untouched`)
  }
  assert.equal(await readFile(join(dirty.path, 'notes.txt'), 'utf8'), 'wip\n')
  assert.deepEqual(harness.givenBack, [])
})

test('the sweep gives back a clean, pushed slot whose chat still exists once it has sat unused for the idle period, not before', async () => {
  const harness = makeService({ chats: [] })
  const chat = await lease(harness, 'chat')
  harness.chats!.push(chatOn(chat, 'ws-1'))
  await mkdir(join(chat.path, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(chat.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(chat.path, 'feature.txt'), 'feature\n')
  await git(chat.path, 'add', 'feature.txt')
  await git(chat.path, 'commit', '-q', '-m', 'feature')
  await git(chat.path, 'push', '-q', 'origin', 'agent/chat')

  let swept = await sweep(harness, [chat.path], 1)
  assert.equal(swept[0]?.verdict, 'in-use')
  assert.match(swept[0]?.detail ?? '', /^used 60 minutes ago$/)
  await harness.service.updateSettings({ idleReturnMinutes: 240 })
  swept = await sweep(harness, [chat.path], 2)
  assert.equal(swept[0]?.verdict, 'in-use', 'three hours is within a four-hour period')

  await harness.service.updateSettings({ idleReturnMinutes: 120 })
  swept = await sweep(harness, [chat.path])
  assert.equal(swept[0]?.verdict, 'returned')
  const slot = await slotAt(harness, 'app-01')
  assert.equal(slot.state, 'idle')
  assert.equal(slot.parked?.branch, 'agent/chat', 'kept for its chat')
  assert.equal(await git(chat.path, 'branch', '--show-current'), '', 'detached')
  assert.equal(await lockReason(chat.path), null, 'unlocked')
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/chat'), 'the branch is kept')
  assert.equal(await exists(join(chat.path, 'node_modules', 'dep', 'index.js')), true, 'nothing in it is removed')
  assert.deepEqual(harness.givenBack, [chat.path])
})

test('the sweep keeps a slot whose chat still exists while it is dirty, unpushed, running, on screen or recently used', async () => {
  const harness = makeService({ chats: [] })
  const dirty = await lease(harness, 'dirty')
  const hidden = await lease(harness, 'hidden')
  const unpushed = await lease(harness, 'unpushed')
  const working = await lease(harness, 'working')
  const terminal = await lease(harness, 'terminal')
  const onScreen = await lease(harness, 'on-screen')
  const recent = await lease(harness, 'recent')
  const all = [dirty, hidden, unpushed, working, terminal, onScreen, recent]
  harness.chats!.push(...all.map((leased, index) => chatOn(leased, `ws-${index}`, { open: leased === onScreen })))
  await writeFile(join(dirty.path, 'README.md'), '# changed\n')
  await git(hidden.path, 'update-index', '--assume-unchanged', 'README.md')
  await writeFile(join(hidden.path, 'README.md'), '# hidden edit\n')
  await writeFile(join(unpushed.path, 'feature.txt'), 'feature\n')
  await git(unpushed.path, 'add', 'feature.txt')
  await git(unpushed.path, 'commit', '-q', '-m', 'feature')
  harness.sessions.push(working.path)
  harness.live.push(terminal.path)
  harness.clock.offset += 3 * HOUR
  // Its chat said something half an hour ago.
  harness.chats!.find((chat) => chat.folderPath === recent.path)!.lastActiveAt =
    Date.now() + harness.clock.offset - HOUR / 2

  const swept = await sweep(
    harness,
    all.map((leased) => leased.path),
  )
  const why = (leased: { path: string }) => swept.find((entry) => entry.path === leased.path)
  for (const leased of all) assert.equal(why(leased)?.verdict, 'in-use', leased.path)
  assert.equal(why(dirty)?.detail, '1 uncommitted change')
  assert.match(why(hidden)?.detail ?? '', /^edits hidden from git status: README\.md$/)
  assert.equal(why(unpushed)?.detail, 'it has commits not pushed')
  assert.equal(why(working)?.detail, 'a turn or a background agent is running in it')
  assert.equal(why(terminal)?.detail, 'a terminal is open in it')
  assert.equal(why(onScreen)?.detail, 'its chat is open on screen')
  assert.equal(why(recent)?.detail, 'used 30 minutes ago')
  for (const leased of all) {
    assert.equal(await git(leased.path, 'branch', '--show-current'), leased.branch, `${leased.branch} is still leased`)
  }
  assert.deepEqual(harness.givenBack, [])
})

test('a squash-merged branch whose remote branch is gone holds nothing only it has, and its slot is given back', async () => {
  const harness = makeService({ chats: [] })
  const chat = await lease(harness, 'merged')
  harness.chats!.push(chatOn(chat, 'ws-1'))
  await writeFile(join(chat.path, 'feature.txt'), 'feature\n')
  await git(chat.path, 'add', 'feature.txt')
  await git(chat.path, 'commit', '-q', '-m', 'feature')
  // The pull request landed as one new commit on main; no remote branch has the chat's own commit.
  await pushToOrigin('feature.txt', 'feature\n')
  await git(repo, 'fetch', '-q', 'origin')
  const swept = await sweep(harness, [chat.path], 3)
  assert.equal(swept[0]?.verdict, 'returned', swept[0]?.detail ?? '')
})

test('a chat whose idle slot was given back gets it again on its branch, at the same path, when it comes back', async () => {
  const harness = makeService({ chats: [] })
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  harness.chats!.push(chatOn(chat, 'ws-1'))
  await mkdir(join(chat.path, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(chat.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  assert.equal((await sweep(harness, [chat.path], 3))[0]?.verdict, 'returned')
  assert.equal(harness.service.awaitsChat(chat.path, 'agent/chat'), true, 'a turn in it would bring it back first')

  // Kept for the chat: another lease makes a slot of its own rather than take it.
  const other = await lease(harness, 'other')
  assert.notEqual(other.path, chat.path)

  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, true, restored.ok ? '' : restored.message)
  assert.equal(await git(chat.path, 'branch', '--show-current'), 'agent/chat')
  assert.equal(await exists(join(chat.path, 'node_modules', 'dep', 'index.js')), true, 'as warm as it was left')
  const slot = await slotAt(harness, 'app-01')
  assert.equal(slot.state, 'leased')
  assert.equal(slot.lease?.branch, 'agent/chat')
  assert.equal(slot.parked, null)
  assert.equal(harness.service.awaitsChat(chat.path, 'agent/chat'), false)
})

test('a chat whose given-back slot was removed for room comes back to the same path: in the pool, or outside it when off', async () => {
  const harness = makeService({ chats: [] })
  installWorktreePool(harness.service)
  await harness.service.updateSettings({ maxSlots: 2 })
  const first = await lease(harness, 'first')
  const second = await lease(harness, 'second')
  harness.chats!.push(chatOn(first, 'ws-1'), chatOn(second, 'ws-2', { open: true }))
  harness.clock.offset += 2 * HOUR
  await lease(harness, 'third')
  assert.equal(await exists(first.path), false, 'removed to make room')
  assert.equal(harness.service.reservesPath(first.path), true)

  // A new lease never takes the path kept for the chat.
  await harness.service.updateSettings({ maxSlots: 4 })
  const fourth = await lease(harness, 'fourth')
  assert.notEqual(fourth.path, first.path)

  const restored = await restoreGitWorktree({ repoRoot: repo, path: first.path, branchName: 'agent/first' })
  assert.equal(restored.ok, true, restored.ok ? '' : restored.message)
  assert.equal(await git(first.path, 'branch', '--show-current'), 'agent/first')
  assert.equal((await slotAt(harness, 'app-01')).state, 'leased', 'a pool slot again, at its old path')
  assert.notEqual(await lockReason(first.path), null, 'locked as in use')
  assert.equal(harness.service.reservesPath(first.path), false)

  // Given back and removed again, with the pool turned off meanwhile: a plain
  // worktree at the same path.
  const again = await sweep(harness, [first.path, second.path], 3)
  assert.equal(again.find((entry) => entry.path === first.path)?.verdict, 'returned')
  await harness.service.updateSettings({ enabled: false })
  assert.equal(await exists(first.path), false, 'turning the pool off removed it')
  const plain = await restoreGitWorktree({ repoRoot: repo, path: first.path, branchName: 'agent/first' })
  assert.equal(plain.ok, true, plain.ok ? '' : plain.message)
  assert.equal(await git(first.path, 'branch', '--show-current'), 'agent/first')
  assert.equal(harness.service.ownsPath(first.path), false, 'outside the pool')
})

test('a slot kept for a chat becomes anyone’s once the chat is gone', async () => {
  const harness = makeService({ chats: [] })
  const chat = await lease(harness, 'chat')
  harness.chats!.push(chatOn(chat, 'ws-1'))
  assert.equal((await sweep(harness, [chat.path], 3))[0]?.verdict, 'returned')
  assert.equal((await slotAt(harness, 'app-01')).parked?.branch, 'agent/chat')
  // The chat settled: nothing on record names the path now.
  harness.chats!.splice(0)
  await sweep(harness, [])
  assert.equal((await slotAt(harness, 'app-01')).parked, null)
  const next = await lease(harness, 'next')
  assert.equal(next.path, chat.path, 'reused')
})

test('a slot an agent leased for itself is taken back while its chat is idle, never while that chat runs a turn', async () => {
  const harness = makeService({ chats: [] })
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'mcp',
    owner: 'agent-1',
    agentId: 'agent-1',
    workspaceId: 'ws-1',
  })
  assert.ok(leased.ok)
  // The agent's chat works in the project's own checkout.
  harness.chats!.push({
    workspaceId: 'ws-1',
    folderPath: repo,
    branch: null,
    otherPaths: [],
    open: false,
    lastActiveAt: null,
  })
  harness.sessions.push(repo)
  const agents = { agentIds: new Set(['agent-1']), agentKeys: new Set([agentLeaseKey('ws-1', 'agent-1')]) }
  let swept = await sweep(harness, [repo], 3, agents)
  assert.equal(swept[0]?.verdict, 'in-use')
  assert.equal(swept[0]?.detail, 'its agent’s chat has a turn running')

  harness.sessions.splice(0)
  swept = await sweep(harness, [repo], 0, agents)
  assert.equal(swept[0]?.verdict, 'returned')
  assert.equal(await exists(leased.path), false, 'removed, so the agent finds it gone rather than detached')
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/mcp'), 'its branch is kept')
  const next = await lease(harness, 'next')
  assert.notEqual(next.path, leased.path, 'its path is not handed to another agent while it exists')
})

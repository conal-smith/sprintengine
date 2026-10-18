import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { parseArtifactsRepositoryUrl, type ArtifactsRepository } from '../../shared/artifacts'
import type { GitCommandResult } from '../git'
import { createGitStore, createLocalStore, describeGitFailure, gitStoreDir } from './artifacts-store'
import { bareRemote, cleanup, git, hermeticGit, remoteFile, remoteFiles, testGit } from '../../../tests/artifacts-repo'

const temporary: string[] = []
let root = ''
let remote = { path: '', url: '' }
let repository: ArtifactsRepository

beforeEach(async () => {
  temporary.push(await hermeticGit())
  root = await mkdtemp(join(tmpdir(), 'artifacts-store-'))
  temporary.push(root)
  remote = await bareRemote(root)
  const parsed = parseArtifactsRepositoryUrl(remote.url)
  assert.ok(parsed.ok)
  repository = parsed.repository
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanup(temporary)
})

function store(name: string, retryDelayMs = () => 5) {
  return createGitStore({
    repository,
    checkoutRoot: join(root, name),
    deps: { git: testGit, resolveHostToken: async () => '', retryDelayMs },
  })
}

test('the first change to an empty repository makes its main', async () => {
  const changed = await store('a').change(async (dir) => {
    await writeFile(join(dir, 'README.md'), 'hello\n')
    return { message: 'Set up', value: 1 }
  })
  assert.ok(changed.ok, changed.ok ? '' : changed.message)
  assert.match(changed.commit ?? '', /^[0-9a-f]{40}$/)
  assert.deepEqual(remoteFiles(remote.path), ['README.md'])
  assert.equal(git(remote.path, ['log', '-1', '--format=%s', 'main']).trim(), 'Set up')
})

test('a change that finds nothing to do commits nothing', async () => {
  const one = store('a')
  await one.change(async (dir) => {
    await writeFile(join(dir, 'a.txt'), 'a')
    return { message: 'One', value: 1 }
  })
  const again = await one.change(async (dir) => {
    await writeFile(join(dir, 'a.txt'), 'a')
    return { message: 'Same', value: 2 }
  })
  assert.ok(again.ok)
  assert.equal(git(remote.path, ['rev-list', '--count', 'main']).trim(), '1')
})

test('a change that fails part-way leaves nothing behind for the next', async () => {
  const one = store('a')
  await one.change(async (dir) => {
    await writeFile(join(dir, 'artifacts.json'), '{"artifacts":[]}\n')
    return { message: 'Set up', value: 1 }
  })
  const failed = await one.change(async (dir) => {
    await writeFile(join(dir, 'artifacts.json'), '{"artifacts":[{"slug":"half')
    await writeFile(join(dir, 'stray.txt'), 'stray')
    throw new Error('the picture could not be taken')
  })
  assert.equal(failed.ok, false)
  const next = await one.change(async (dir) => {
    assert.equal(existsSync(join(dir, 'stray.txt')), false, 'the stray file is gone')
    assert.equal(
      await readFile(join(dir, 'artifacts.json'), 'utf8'),
      '{"artifacts":[]}\n',
      'the half-written manifest is gone',
    )
    await writeFile(join(dir, 'b.txt'), 'b')
    return { message: 'Two', value: 2 }
  })
  assert.ok(next.ok)
  assert.deepEqual(remoteFiles(remote.path), ['artifacts.json', 'b.txt'])
})

test('a push another machine beat is made again on the new tip, so neither change is lost', async () => {
  const first = store('first')
  const second = store('second')
  await first.change(async (dir) => {
    await writeFile(join(dir, 'list.txt'), '')
    return { message: 'Set up', value: 0 }
  })
  // Each change appends its line to the same file, as two publishes both
  // rewrite the manifest: a rebase would conflict; making it again cannot.
  const append = (line: string) => async (dir: string) => {
    const current = await readFile(join(dir, 'list.txt'), 'utf8')
    await writeFile(join(dir, 'list.txt'), `${current}${line}\n`)
    return { message: `Add ${line}`, value: line }
  }
  const results = await Promise.all([
    first.change(append('a1')),
    second.change(append('b1')),
    first.change(append('a2')),
    second.change(append('b2')),
  ])
  for (const result of results) assert.ok(result.ok, result.ok ? '' : result.message)
  const lines = remoteFile(remote.path, 'list.txt').trim().split('\n').sort()
  assert.deepEqual(lines, ['a1', 'a2', 'b1', 'b2'])
  assert.equal(git(remote.path, ['rev-list', '--count', 'main']).trim(), '5')
})

test('a store gives up on a remote that keeps moving, and says so', async () => {
  const one = store('one')
  await one.change(async (dir) => {
    await writeFile(join(dir, 'a.txt'), '0')
    return { message: 'Set up', value: 0 }
  })
  const rival = store('rival')
  let turn = 0
  const result = await one.change(async (dir) => {
    turn += 1
    // Before each push, another machine pushes first.
    await rival.change(async (other) => {
      await writeFile(join(other, `rival-${turn}.txt`), String(turn))
      return { message: `Rival ${turn}`, value: turn }
    })
    await writeFile(join(dir, 'mine.txt'), String(turn))
    return { message: 'Mine', value: turn }
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /kept moving/)
  assert.equal(turn, 5)
})

test('the check reads the remote and rehearses a push without making anything', async () => {
  const empty = await store('a').test()
  assert.deepEqual(
    empty.map((check) => check.status),
    ['pass', 'pass'],
  )
  assert.match(empty[0].detail, /empty/)
  assert.equal(git(remote.path, ['for-each-ref']).trim(), '', 'no branch was made by the check')

  const missing = createGitStore({
    repository: { ...repository, remoteUrl: `${remote.url}-gone` },
    checkoutRoot: join(root, 'b'),
    deps: { git: testGit, resolveHostToken: async () => '' },
  })
  const failed = await missing.test()
  assert.equal(failed[0].status, 'fail')
})

test('an https remote is signed in with the host’s token through the environment, never the arguments or the address', async () => {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
  const recorder = async (_cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitCommandResult> => {
    calls.push({ args, env })
    return { ok: false, stdout: '', stderr: 'fatal: Authentication failed', message: null }
  }
  const parsed = parseArtifactsRepositoryUrl('https://git.acme.example/design/artifacts')
  assert.ok(parsed.ok)
  const hosts: string[] = []
  const https = createGitStore({
    repository: parsed.repository,
    checkoutRoot: join(root, 'https'),
    deps: {
      git: recorder,
      resolveHostToken: async (host) => {
        hosts.push(host)
        return 'secret-token-123'
      },
    },
  })
  const checks = await https.test()
  assert.deepEqual(hosts, ['git.acme.example'])
  assert.ok(calls.length > 0)
  for (const call of calls) assert.ok(!call.args.join(' ').includes('secret-token-123'), 'not in argv')
  assert.ok(
    calls.some((call) => Object.values(call.env ?? {}).includes('secret-token-123')),
    'in the environment',
  )
  assert.ok(!JSON.stringify(checks).includes('secret-token-123'), 'not in what the check says')
  assert.match(checks[0].detail, /gh auth login/)
})

test('two remotes never share a clone folder, whatever their names', () => {
  const a = parseArtifactsRepositoryUrl('https://github.com/acme/artifacts')
  const b = parseArtifactsRepositoryUrl('https://git.acme.example/acme/artifacts')
  assert.ok(a.ok && b.ok)
  assert.notEqual(gitStoreDir('/Users/dev/data', a.repository), gitStoreDir('/Users/dev/data', b.repository))
  assert.match(gitStoreDir('/Users/dev/data', a.repository), /^\/Users\/dev\/data\/acme--artifacts--[0-9a-f]{10}$/)
})

test('a git failure is said in words, with what to do', () => {
  const failure = (stderr: string) =>
    describeGitFailure('acme/artifacts', 'take the push', { ok: false, stdout: '', stderr, message: null })
  assert.match(failure('Author identity unknown\n*** Please tell me who you are.'), /git config --global user\.name/)
  assert.match(failure('git@github.com: Permission denied (publickey).'), /ssh-add/)
  assert.match(
    failure('remote: Permission to acme/artifacts.git denied to dev.\nfatal: unable to access'),
    /gh auth login/,
  )
  assert.match(failure('fatal: unable to access: Could not resolve host: github.com'), /Could not reach/)
})

test('a local store undoes a change that failed, and keeps one that worked', async () => {
  const local = createLocalStore({ dir: join(root, 'local', 'site') })
  await local.change(async (dir) => {
    await writeFile(join(dir, 'artifacts.json'), 'good')
    return { message: 'One', value: 1 }
  })
  const failed = await local.change(async (dir) => {
    await writeFile(join(dir, 'artifacts.json'), 'half')
    throw new Error('disk full')
  })
  assert.equal(failed.ok, false)
  assert.equal(await readFile(join(root, 'local', 'site', 'artifacts.json'), 'utf8'), 'good')
  const refused = await local.change(async (dir) => {
    await writeFile(join(dir, 'artifacts.json'), 'half')
    return { failure: 'no such artifact' }
  })
  assert.equal(refused.ok, false)
  assert.equal(await readFile(join(root, 'local', 'site', 'artifacts.json'), 'utf8'), 'good')
})

test('two stores on one clone take turns, so a check never resets a publish’s tree under it', async () => {
  const live = store('shared')
  const checking = store('shared')
  await live.change(async (dir) => {
    await writeFile(join(dir, 'a.txt'), 'a')
    return { message: 'Set up', value: 0 }
  })
  let inside = false
  const order: string[] = []
  const publishing = live.change(async (dir) => {
    inside = true
    await writeFile(join(dir, 'b.txt'), 'b')
    await new Promise((resolve) => setTimeout(resolve, 50))
    order.push('publish')
    inside = false
    return { message: 'Publish', value: 1 }
  })
  const reading = checking.read(async () => {
    order.push(inside ? 'read-during' : 'read-after')
    return true
  })
  const [published] = await Promise.all([publishing, reading])
  assert.ok(published.ok)
  assert.deepEqual(order, ['publish', 'read-after'])
  assert.deepEqual(remoteFiles(remote.path), ['a.txt', 'b.txt'])
})

test('a local store that died mid-change puts the last good site back before the next', async () => {
  const dir = join(root, 'crashed', 'site')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'artifacts.json'), 'half-written')
  await mkdir(`${dir}.before-change`, { recursive: true })
  await writeFile(join(`${dir}.before-change`, 'artifacts.json'), 'good')
  const local = createLocalStore({ dir })
  const read = await local.read(async (site) => readFile(join(site, 'artifacts.json'), 'utf8'))
  assert.ok(read.ok && read.value === 'good')
  assert.equal(existsSync(`${dir}.before-change`), false)
})

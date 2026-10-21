import assert from 'node:assert/strict'

import { test } from 'vitest'

import { gitPushTarget, type GitOutput } from './git-push-target'

/** A git that answers `config --get` from `config` and knows the remotes in `remotes`. */
function gitWith(config: Record<string, string>, remotes: string[] = ['origin']): GitOutput & { asked: string[][] } {
  const asked: string[][] = []
  const out = async (_cwd: string, args: string[]) => {
    asked.push(args)
    if (args[0] === 'config' && args[1] === '--get') return config[args[2]!] ?? null
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const name = args.at(-1)!
      return remotes.includes(name) ? `/srv/git/${name}.git` : null
    }
    return null
  }
  return Object.assign(out, { asked })
}

test('a configured push remote that starts with a dash is refused, never handed to git as an option', async () => {
  for (const key of ['branch.feature/marks.pushRemote', 'remote.pushDefault']) {
    const out = gitWith({ [key]: '--receive-pack=x:y' })
    const target = await gitPushTarget(out, '/Users/dev/acme', 'feature/marks', 'main')
    assert.equal(target.ok, false, key)
    assert.match(target.ok ? '' : target.message, /“--receive-pack=x:y”/u)
    assert.ok(
      out.asked.every((args) => !args.includes('--receive-pack=x:y')),
      'the value is not passed to git at all',
    )
  }
})

test('a configured push remote that names a remote or a URL is still used', async () => {
  const named = await gitPushTarget(
    gitWith({ 'branch.feature/marks.pushRemote': 'mine' }, ['origin', 'mine']),
    '/Users/dev/acme',
    'feature/marks',
    'main',
  )
  assert.deepEqual(named, { ok: true, remote: 'mine', setUpstream: false })
  const url = await gitPushTarget(
    gitWith({ 'remote.pushDefault': 'git@github.com:acme/app.git' }),
    '/Users/dev/acme',
    'feature/marks',
    'main',
  )
  assert.deepEqual(url, { ok: true, remote: 'git@github.com:acme/app.git', setUpstream: false })
})

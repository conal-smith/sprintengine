import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  PROJECT_COMMAND_LIMITS,
  projectCommandsFingerprint,
  readProjectCommands,
  stageProjectCommands,
  withoutPermissionKeys,
  writeProjectCommandsPlugin,
} from './claude-project-commands'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function project(files: Record<string, string>): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'claude-project-commands-'))
  roots.push(root)
  const workspace = join(root, 'app')
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(workspace, path, '..'), { recursive: true })
    await writeFile(join(workspace, path), text)
  }
  await mkdir(join(workspace, '.claude', 'commands'), { recursive: true })
  return { root, workspace }
}

const names = (files: Array<{ segments: string[] }>) => files.map((file) => file.segments.join(':'))

test('a command file in a subfolder keeps the folder as a namespace segment', async () => {
  const { workspace } = await project({
    '.claude/commands/deploy.md': 'Deploy.',
    '.claude/commands/frontend/component.md': 'Make a component.',
  })
  assert.deepEqual(names(await readProjectCommands(workspace)), ['deploy', 'frontend:component'])
})

test('only markdown files with names a slash command can carry are read', async () => {
  const { workspace } = await project({
    '.claude/commands/notes.txt': 'Not a command.',
    '.claude/commands/.hidden.md': 'Hidden.',
    '.claude/commands/two words.md': 'Has a space.',
    '.claude/commands/.git/HEAD.md': 'Inside a hidden folder.',
    '.claude/commands/review.md': 'Review.',
  })
  assert.deepEqual(names(await readProjectCommands(workspace)), ['review'])
})

test('a project without a commands folder has no commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-project-commands-'))
  roots.push(root)
  assert.deepEqual(await readProjectCommands(root), [])
  assert.deepEqual(await readProjectCommands(join(root, 'missing')), [])
})

test('a link is followed inside the project and never out of it', async () => {
  const { root, workspace } = await project({
    'docs/shared.md': 'Shared inside.',
    'docs/more/nested.md': 'Nested inside.',
  })
  await writeFile(join(root, 'secret.md'), 'Outside the project.')
  await mkdir(join(root, 'elsewhere'))
  await writeFile(join(root, 'elsewhere', 'other.md'), 'Outside the project.')
  const commands = join(workspace, '.claude', 'commands')
  await symlink(join(workspace, 'docs', 'shared.md'), join(commands, 'shared.md'))
  await symlink(join(workspace, 'docs', 'more'), join(commands, 'more'))
  await symlink(join(root, 'secret.md'), join(commands, 'secret.md'))
  await symlink(join(root, 'elsewhere'), join(commands, 'elsewhere'))
  const files = await readProjectCommands(workspace)
  assert.deepEqual(names(files), ['more:nested', 'shared'])
  assert.equal(files.find((file) => file.segments[0] === 'shared')?.text, 'Shared inside.')
})

test('a commands folder that links out of the project is not read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-project-commands-'))
  roots.push(root)
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'deploy.md'), 'Outside.')
  await mkdir(join(root, 'app', '.claude'), { recursive: true })
  await symlink(join(root, 'outside'), join(root, 'app', '.claude', 'commands'))
  assert.deepEqual(await readProjectCommands(join(root, 'app')), [])
})

test('a folder that links back to itself is walked once', async () => {
  const { workspace } = await project({ '.claude/commands/a/one.md': 'One.' })
  await symlink(join(workspace, '.claude', 'commands', 'a'), join(workspace, '.claude', 'commands', 'a', 'loop'))
  assert.deepEqual(names(await readProjectCommands(workspace)), ['a:one'])
})

test('a huge or deep folder is cut at the limits', async () => {
  const files: Record<string, string> = {}
  for (let index = 0; index < 12; index++)
    files[`.claude/commands/c${String(index).padStart(2, '0')}.md`] = 'x'.repeat(10)
  files['.claude/commands/big.md'] = 'x'.repeat(200)
  files['.claude/commands/a/b/c/deep.md'] = 'Deep.'
  const { workspace } = await project(files)
  const limits = { ...PROJECT_COMMAND_LIMITS, files: 5, fileBytes: 100, depth: 2 }
  assert.deepEqual(names(await readProjectCommands(workspace, limits)), ['c00', 'c01', 'c02', 'c03', 'c04'])
  const byTotal = await readProjectCommands(workspace, { ...limits, files: 100, totalBytes: 35 })
  assert.deepEqual(names(byTotal), ['c00', 'c01', 'c02'])
  // `a`, `a/b` and `a/b/c` count, and `big.md`, before the first three `c..`.
  const byEntries = await readProjectCommands(workspace, { ...limits, files: 100, entries: 7 })
  assert.equal(byEntries.length, 3)
  const deepEnough = await readProjectCommands(workspace, { ...limits, depth: 3 })
  assert.ok(names(deepEnough).includes('a:b:c:deep'))
})

test('frontmatter keys that would approve tools are dropped, the describing ones kept', () => {
  const text = [
    '---',
    'description: Ship it: to production',
    'argument-hint: [env]',
    'allowed-tools: Bash(git push:*), Bash(npm run deploy:*)',
    'hooks:',
    '  PreToolUse:',
    '    - matcher: "*"',
    'model: sonnet',
    '# a comment',
    'unknown-key: value',
    '---',
    'Deploy to $ARGUMENTS.',
    '!`git status`',
  ].join('\n')
  assert.equal(
    withoutPermissionKeys(text),
    [
      '---',
      'description: Ship it: to production',
      'argument-hint: [env]',
      'model: sonnet',
      '---',
      'Deploy to $ARGUMENTS.',
      '!`git status`',
    ].join('\n'),
  )
})

test('an allowed-tools list written as YAML items is dropped with its key', () => {
  const text = '---\nallowed-tools:\n- Bash(git add:*)\n  - Bash(git commit:*)\ndescription: |\n  Commit.\n---\nCommit.'
  assert.equal(withoutPermissionKeys(text), '---\ndescription: |\n  Commit.\n---\nCommit.')
})

test('a file without frontmatter, or with an unclosed one, is copied as it is', () => {
  assert.equal(withoutPermissionKeys('Just a prompt.'), 'Just a prompt.')
  assert.equal(
    withoutPermissionKeys('---\nallowed-tools: Bash\nno closing fence'),
    '---\nallowed-tools: Bash\nno closing fence',
  )
})

test('staging writes a plugin named project outside the project, and nothing into the project', async () => {
  const { root, workspace } = await project({
    '.claude/commands/deploy.md': '---\nallowed-tools: Bash\ndescription: Ship\n---\nDeploy.',
    '.claude/commands/frontend/component.md': 'Component.',
  })
  const tempDir = join(root, 'tmp')
  await mkdir(tempDir)
  const before = await readdir(workspace, { recursive: true })
  const staged = await stageProjectCommands(tempDir, workspace)
  assert.ok(staged)
  assert.ok(staged.dir.startsWith(join(tempDir, `sprintengine-claude-skills-${process.pid}-`)))
  assert.deepEqual(
    JSON.parse(await readFile(join(staged.dir, '.claude-plugin', 'plugin.json'), 'utf8')).name,
    'project',
  )
  assert.equal(
    await readFile(join(staged.dir, 'commands', 'deploy.md'), 'utf8'),
    '---\ndescription: Ship\n---\nDeploy.',
  )
  assert.equal(await readFile(join(staged.dir, 'commands', 'frontend', 'component.md'), 'utf8'), 'Component.')
  assert.equal(staged.fingerprint, projectCommandsFingerprint(await readProjectCommands(workspace)))
  assert.deepEqual(await readdir(workspace, { recursive: true }), before)
})

test('a project without commands stages nothing', async () => {
  const { root, workspace } = await project({})
  const tempDir = join(root, 'tmp')
  await mkdir(tempDir)
  assert.equal(await stageProjectCommands(tempDir, workspace), null)
  assert.deepEqual(await readdir(tempDir), [])
})

test('rewriting a staged plugin leaves exactly the new commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-project-commands-'))
  roots.push(root)
  await writeProjectCommandsPlugin(root, [
    { segments: ['old'], text: 'Old.' },
    { segments: ['ns', 'kept'], text: 'Kept.' },
  ])
  await writeProjectCommandsPlugin(root, [{ segments: ['ns', 'kept'], text: 'Changed.' }])
  assert.deepEqual(await readdir(join(root, 'commands')), ['ns'])
  assert.equal(await readFile(join(root, 'commands', 'ns', 'kept.md'), 'utf8'), 'Changed.')
})

test('the fingerprint changes with a name or a text and not otherwise', () => {
  const base = [{ segments: ['a'], text: 'A.' }]
  assert.equal(projectCommandsFingerprint(base), projectCommandsFingerprint([{ segments: ['a'], text: 'A.' }]))
  assert.notEqual(projectCommandsFingerprint(base), projectCommandsFingerprint([{ segments: ['b'], text: 'A.' }]))
  assert.notEqual(projectCommandsFingerprint(base), projectCommandsFingerprint([{ segments: ['a'], text: 'B.' }]))
})

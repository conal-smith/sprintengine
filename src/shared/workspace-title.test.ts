import assert from 'node:assert/strict'
import {
  MAX_WORKSPACE_TITLE_LENGTH,
  deriveWorkspaceTitle,
  isDefaultWorkspaceName,
  stripInjectedFragments,
} from './workspace-title'
import { test } from 'vitest'

test('workspace-title', async () => {
  const tests: Array<{ name: string; body: () => void }> = []

  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  run('recognises the names the app mints for a new chat', () => {
    // The New chat button: "Chat", then a per-folder ordinal.
    assert.equal(isDefaultWorkspaceName('Chat'), true)
    assert.equal(isDefaultWorkspaceName('Chat 63'), true)
    assert.equal(isDefaultWorkspaceName('  chat 7 '), true, 'case and whitespace are not signal')
    assert.equal(isDefaultWorkspaceName('New chat 3'), true)
    // A headless create numbers off its layout template.
    assert.equal(isDefaultWorkspaceName('Solo 12', 'Solo'), true)
    assert.equal(isDefaultWorkspaceName('Solo 12'), false, 'a template stem counts only when named')
  })

  run('never mistakes a chosen name for a minted one', () => {
    assert.equal(isDefaultWorkspaceName('Release prep'), false)
    assert.equal(isDefaultWorkspaceName('Chat about auth'), false, 'a stem with words after it is a topic')
    assert.equal(isDefaultWorkspaceName('Chat63'), false)
    assert.equal(isDefaultWorkspaceName('Chat 6 3'), false)
    assert.equal(isDefaultWorkspaceName(''), false)
    assert.equal(isDefaultWorkspaceName('Payments Rewrite', 'Solo'), false)
  })

  run('derives a title from an ordinary typed request', () => {
    assert.equal(
      deriveWorkspaceTitle('fix the git stash panel dropping the hash when you pop from a worktree'),
      'Fix the git stash panel dropping',
    )
  })

  run('strips stacked dictation filler before the topic', () => {
    assert.equal(
      deriveWorkspaceTitle('so right now basically I want you to rewrite the onboarding flow'),
      'Rewrite the onboarding flow',
    )
    assert.equal(deriveWorkspaceTitle('hey can you please add a dark mode toggle'), 'Add a dark mode toggle')
    assert.equal(deriveWorkspaceTitle('OK so we need to migrate the store'), 'Migrate the store')
  })

  run('keeps only the first sentence', () => {
    assert.equal(
      deriveWorkspaceTitle('Add retry to the uploader. It keeps failing on large files and I am tired of it.'),
      'Add retry to the uploader',
    )
  })

  run('preserves identifier casing and lifts only the first character', () => {
    assert.equal(deriveWorkspaceTitle('useEffect fires twice on mount'), 'UseEffect fires twice on mount')
    assert.equal(deriveWorkspaceTitle('debug the OAuth redirect loop'), 'Debug the OAuth redirect loop')
  })

  run('caps at the word and character limits on a word boundary', () => {
    const title = deriveWorkspaceTitle('refactor the authentication middleware configuration loader immediately')
    assert.ok(title)
    assert.ok(title.length <= MAX_WORKSPACE_TITLE_LENGTH, `too long: ${title}`)
    assert.ok(!title.endsWith(' '), 'trailing space survived')
    // Word boundary, not a mid-word cut.
    assert.equal(title, 'Refactor the authentication middleware')
  })

  run('rejects a prompt that is nothing but an app-injected skill drop', () => {
    assert.equal(deriveWorkspaceTitle('/backlog'), null)
    assert.equal(deriveWorkspaceTitle('/backlog backlog/2026-07-29-thing.md'), null)
  })

  run('rejects a prompt that is nothing but dropped paths or a commit hash', () => {
    assert.equal(deriveWorkspaceTitle('src/main/terminal-runtime.ts'), null)
    assert.equal(deriveWorkspaceTitle('/Users/me/workspace/sprintengine/src/main/git.ts'), null)
    assert.equal(deriveWorkspaceTitle('4617df92a1bd3c9f8e2a7b6c5d4e3f2a1b0c9d8e'), null)
    assert.equal(deriveWorkspaceTitle('@src/renderer/src/App.tsx'), null)
  })

  run('titles from the human words typed alongside an injected fragment', () => {
    assert.equal(
      deriveWorkspaceTitle('/backlog work MC-1899 and tighten the link chooser'),
      'Work MC-1899 and tighten the link',
    )
    assert.equal(
      deriveWorkspaceTitle('src/main/git-stash.ts the stash pop loses its hash'),
      'The stash pop loses its hash',
    )
  })

  run('titles from the request when a host-context block follows it', () => {
    // Prompt-fallback CLIs wrap host context AFTER the user's words so the
    // UserPromptSubmit hook does not name the workspace after the host preamble.
    const prompt = [
      'Build the settings page.',
      '',
      '<host-context>',
      'The following was supplied by SprintEngine Studio, the application hosting this session. It is context about the machine and the project, not part of the user’s request.',
      '</host-context>',
    ].join('\n')
    assert.equal(deriveWorkspaceTitle(prompt), 'Build the settings page')
  })

  run('ignores fenced code and inline code spans', () => {
    assert.equal(
      deriveWorkspaceTitle('make the parser handle this\n```ts\nconst x = 1\n```'),
      'Make the parser handle this',
    )
    assert.equal(deriveWorkspaceTitle('rename `foo` to something clearer'), 'Rename to something clearer')
  })

  run('rejects empty, whitespace, filler-only and letterless prompts', () => {
    assert.equal(deriveWorkspaceTitle(''), null)
    assert.equal(deriveWorkspaceTitle('   \n  '), null)
    assert.equal(deriveWorkspaceTitle('ok'), null)
    assert.equal(deriveWorkspaceTitle('please'), null)
    assert.equal(deriveWorkspaceTitle('123 456'), null)
    assert.equal(deriveWorkspaceTitle('!!!'), null)
  })

  run('rejects non-string input rather than throwing', () => {
    assert.equal(deriveWorkspaceTitle(undefined as unknown as string), null)
    assert.equal(deriveWorkspaceTitle(null as unknown as string), null)
    assert.equal(deriveWorkspaceTitle(42 as unknown as string), null)
  })

  run('stripInjectedFragments leaves ordinary prose untouched', () => {
    assert.equal(stripInjectedFragments('fix the retry loop in the uploader'), 'fix the retry loop in the uploader')
  })

  run('stripInjectedFragments collapses whitespace left by removals', () => {
    assert.equal(stripInjectedFragments('check   @a/b.ts   now'), 'check now')
  })

  run('stripInjectedFragments removes urls', () => {
    assert.equal(
      stripInjectedFragments('port the fix from https://github.com/o/r/pull/12 into main'),
      'port the fix from into main',
    )
  })

  function main(): void {
    for (const test of tests) {
      try {
        test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        console.error(`not ok - ${test.name}`)
        throw error
      }
    }
    console.log('workspace-title.test.ts: ok')
  }

  main()
})

test('a pasted image placeholder is never the title', () => {
  assert.equal(deriveWorkspaceTitle('[Image #1]'), null, 'a prompt that is only a picture names nothing')
  assert.equal(deriveWorkspaceTitle('[Image #1] [Image #2]'), null)
  assert.equal(deriveWorkspaceTitle('[Image: source: /Users/dev/Desktop/shot.png]'), null)
  assert.equal(deriveWorkspaceTitle('[Image #1] fix the header spacing'), 'Fix the header spacing')
})

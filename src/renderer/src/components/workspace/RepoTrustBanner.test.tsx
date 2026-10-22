import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { GitRepoTrustDecision, GitRepoTrustView } from '../../../../shared/ipc/git-repo-trust'
import { RepoTrustBanner, repoTrustMessage } from './RepoTrustBanner'

// The banner on a project whose repository's own config names programs: shown
// until the person answers, and gone for good once they do. Main is an
// in-memory stand-in that records answers the way the trust store does.

let root: Root
let container: HTMLElement
let answers: Array<{ folderPath: string; hash: string; decision: GitRepoTrustDecision }>

function installMain(view: GitRepoTrustView | null) {
  answers = []
  let current = view
  ;(window as unknown as { api: unknown }).api = {
    getGitRepoTrust: async () => current,
    answerGitRepoTrust: async (input: { folderPath: string; hash: string; decision: GitRepoTrustDecision }) => {
      answers.push(input)
      current = current ? { ...current, decision: input.decision } : null
      return current
    },
    onGitRepoTrustChanged: () => () => undefined,
  }
}

async function mount(folderPath: string | null) {
  await act(async () => {
    root.render(<RepoTrustBanner folderPath={folderPath} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === label)

const naming: GitRepoTrustView = {
  repoPath: '/Users/dev/app',
  settings: ['core.hookspath', 'filter.lfs.smudge'],
  hash: 'abc',
  decision: null,
}

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.navigator = dom.window.navigator
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.Node = dom.window.Node
  g.MouseEvent = dom.window.MouseEvent
  g.getComputedStyle = dom.window.getComputedStyle
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

test('a project whose repository names programs is asked once, and Trust this repository records the answer', async () => {
  installMain(naming)
  await mount('/Users/dev/app/src')
  assert.match(container.textContent ?? '', /core\.hookspath, filter\.lfs\.smudge/)
  await act(async () => {
    button('Trust this repository')?.click()
  })
  assert.deepEqual(answers, [{ folderPath: '/Users/dev/app/src', hash: 'abc', decision: 'trusted' }])
  assert.equal(button('Trust this repository'), undefined, 'answered: the banner is gone')
})

test('Not now puts the banner away too', async () => {
  installMain(naming)
  await mount('/Users/dev/app')
  await act(async () => {
    button('Not now')?.click()
  })
  assert.equal(answers[0]?.decision, 'dismissed')
  assert.equal(container.textContent, '')
})

test('nothing shows for a repository that names no program, one already answered, or no folder', async () => {
  installMain({ ...naming, settings: [] })
  await mount('/Users/dev/app')
  assert.equal(container.textContent, '')
  installMain({ ...naming, decision: 'trusted' })
  await mount('/Users/dev/other')
  assert.equal(container.textContent, '')
  await mount(null)
  assert.equal(container.textContent, '')
})

test('a long list is named in part and counted', () => {
  assert.match(repoTrustMessage(['a.b', 'c.d', 'e.f', 'g.h', 'i.j']), /\(a\.b, c\.d, e\.f and 2 more\)/)
})

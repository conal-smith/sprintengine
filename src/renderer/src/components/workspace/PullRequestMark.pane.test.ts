// @vitest-environment jsdom
// A row's pull request mark opens the pull request in the chat's browser pane;
// Cmd/Ctrl-click, or a pane that cannot take it, opens the system browser.
import { afterEach, expect, test } from 'vitest'

import { openPullRequestFromMark } from './PullRequestMark'

const URL = 'https://github.com/acme/app/pull/418'
const external: string[] = []
;(window as unknown as { api: unknown }).api = {
  openExternal: async (url: string) => void external.push(url),
}
afterEach(() => {
  external.length = 0
})

function pane(takes = true) {
  const opened: Array<[string, string]> = []
  return {
    opened,
    open: (workspaceId: string, url: string) => {
      opened.push([workspaceId, url])
      return takes
    },
  }
}

const plain = { metaKey: false, ctrlKey: false }

test('a plain click opens the pull request in the chat’s browser pane', () => {
  const p = pane()
  expect(openPullRequestFromMark(URL, 'ws-1', plain, p.open)).toBe(true)
  expect(p.opened).toEqual([['ws-1', URL]])
  expect(external).toEqual([])
})

test('Cmd or Ctrl held opens the system browser instead', () => {
  for (const modifiers of [
    { metaKey: true, ctrlKey: false },
    { metaKey: false, ctrlKey: true },
  ]) {
    const p = pane()
    expect(openPullRequestFromMark(URL, 'ws-1', modifiers, p.open)).toBe(false)
    expect(p.opened).toEqual([])
  }
  expect(external).toEqual([URL, URL])
})

test('a row with no pane here, or a pane that cannot take it, opens the system browser', () => {
  const p = pane()
  expect(openPullRequestFromMark(URL, undefined, plain, p.open)).toBe(false)
  expect(p.opened).toEqual([])
  const full = pane(false)
  expect(openPullRequestFromMark(URL, 'ws-1', plain, full.open)).toBe(false)
  expect(external).toEqual([URL, URL])
})

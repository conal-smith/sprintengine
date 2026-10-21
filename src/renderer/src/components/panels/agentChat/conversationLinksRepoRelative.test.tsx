// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { withoutRepeatedWorkspacePrefix } from '../../../utils/terminalFileLinks'
import { ConversationLinkProvider, ConversationMarkdown } from './conversationLinks'
import {
  ConversationTransportProvider,
  useConversationTransport,
  type ConversationTransport,
} from './conversationTransport'

// Each test names its own file: a path's answer is remembered for the window.
//
// A workspace opened at a subfolder of its repository hears paths from the
// repository's root, as `git diff --stat` prints them. The literal path joins
// onto the workspace as `apps/web/apps/web/…`, which is not there; the same
// path without the folders it repeats is.

const WORKSPACE = '/Users/dev/mono/apps/web'
let files: Set<string>
let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
  files = new Set()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function DiskFiles({ children }: { children: React.ReactNode }) {
  const local = useConversationTransport()
  const transport: ConversationTransport = {
    ...local,
    capabilities: { ...local.capabilities, localFiles: true },
    services: {
      ...local.services,
      files: {
        ...local.services.files,
        canStat: true,
        stat: async (path: string) => ({ isFile: files.has(path), isDirectory: false }) as never,
      },
    },
  }
  return <ConversationTransportProvider value={transport}>{children}</ConversationTransportProvider>
}

async function render(text: string): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <DiskFiles>
        <ConversationLinkProvider workspaceId="workspace" workspaceRoot={WORKSPACE} cwd={WORKSPACE}>
          <ConversationMarkdown text={text} />
        </ConversationLinkProvider>
      </DiskFiles>,
    )
  })
  // Each stat answers on a later turn; the fallback is asked only after the literal path's answer.
  for (let pass = 0; pass < 5; pass += 1) await act(async () => await Promise.resolve())
  return host
}

test('the folders a repository-root path repeats are dropped from its front, only those', () => {
  expect(withoutRepeatedWorkspacePrefix('apps/web/src/App.tsx', WORKSPACE)).toBe('src/App.tsx')
  expect(withoutRepeatedWorkspacePrefix('web/src/App.tsx', WORKSPACE)).toBe('src/App.tsx')
  expect(withoutRepeatedWorkspacePrefix('src/App.tsx', WORKSPACE)).toBeNull()
  expect(withoutRepeatedWorkspacePrefix('apps/api/src/main.ts', WORKSPACE)).toBeNull()
  expect(withoutRepeatedWorkspacePrefix('/Users/dev/mono/apps/web/src/App.tsx', WORKSPACE)).toBeNull()
  expect(withoutRepeatedWorkspacePrefix('web', WORKSPACE), 'never the whole path').toBeNull()
  expect(withoutRepeatedWorkspacePrefix('Apps\\Web\\src\\App.tsx', 'C:\\Users\\dev\\mono\\apps\\web')).toBe(
    'src/App.tsx',
  )
  expect(withoutRepeatedWorkspacePrefix('Apps/Web/src/App.tsx', WORKSPACE), 'case counts off Windows').toBeNull()
})

test('a repository-root path in a subfolder workspace links to the file it names', async () => {
  files.add(`${WORKSPACE}/src/App.tsx`)
  const body = await render('Changed `apps/web/src/App.tsx` to fix the header.')
  const link = body.querySelector('[aria-label="Open apps/web/src/App.tsx"]')
  expect(link).not.toBeNull()
  expect(link?.getAttribute('title')).toBe(`${WORKSPACE}/src/App.tsx`)
})

test('the literal path wins when it is a file', async () => {
  files.add(`${WORKSPACE}/apps/web/src/Header.tsx`)
  files.add(`${WORKSPACE}/src/Header.tsx`)
  const body = await render('Changed `apps/web/src/Header.tsx`.')
  expect(body.querySelector('[aria-label="Open apps/web/src/Header.tsx"]')?.getAttribute('title')).toBe(
    `${WORKSPACE}/apps/web/src/Header.tsx`,
  )
})

test('a path that is a file under neither reading stays text', async () => {
  const body = await render('Changed `apps/web/src/Missing.tsx`.')
  expect(body.querySelector('[aria-label="Open apps/web/src/Missing.tsx"]')).toBeNull()
  expect(body.textContent).toContain('apps/web/src/Missing.tsx')
})

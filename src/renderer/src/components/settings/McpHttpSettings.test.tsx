// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { McpHttpStatus } from '../../../../shared/mcp-http'
import { ConfirmDialogProvider } from '../ui'

const { McpHttpSettings } = await import('./McpHttpSettings')

const off: McpHttpStatus = { running: false, url: null, clients: [], lastError: null }
const on: McpHttpStatus = {
  running: true,
  url: 'http://127.0.0.1:41234/mcp',
  clients: [{ id: 'c1', name: 'editor', createdAt: 1, lastUsedAt: null }],
  lastError: null,
}

let root: Root
let host: HTMLDivElement
let status: McpHttpStatus
const clipboard = vi.fn(async (_text: string) => undefined)
const revoke = vi.fn(async (_id: string) => off)

beforeEach(() => {
  status = off
  clipboard.mockClear()
  revoke.mockClear()
  Object.assign(window, {
    api: {
      mcpHttpStatus: vi.fn(async () => status),
      mcpHttpCreate: vi.fn(async (name: string) => ({
        ok: true,
        status: on,
        client: { id: 'c1', name, createdAt: 1, lastUsedAt: null },
        token: 'semcp_secret',
        url: on.url,
      })),
      mcpHttpRevoke: revoke,
      clipboardWriteText: clipboard,
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <McpHttpSettings />
      </ConfirmDialogProvider>,
    ),
  )
}
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  )
  if (!found) throw new Error(`No button "${name}"`)
  return found
}

test('Copy MCP URL names the client, then copies the URL with its token as a client configuration', async () => {
  await render()
  expect(host.textContent).toContain('Off')
  await act(async () => button('Copy MCP URL').click())
  const input = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'editor')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Copy MCP URL').click())
  expect(window.api.mcpHttpCreate).toHaveBeenCalledWith('editor')
  const copied = JSON.parse(clipboard.mock.calls[0]![0])
  expect(copied).toEqual({
    mcpServers: {
      'sprintengine-studio': {
        type: 'http',
        url: 'http://127.0.0.1:41234/mcp',
        headers: { Authorization: 'Bearer semcp_secret' },
      },
    },
  })
  expect(host.textContent).toContain('Copied the URL and a token for editor')
  expect(host.textContent).toContain('http://127.0.0.1:41234/mcp')
  expect(host.textContent).not.toContain('semcp_secret')
})

test('a client is revoked after asking', async () => {
  status = on
  await render()
  await act(async () => button('Revoke').click())
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (candidate) => candidate.textContent?.trim() === 'Revoke',
  )!
  await act(async () => confirm.click())
  expect(revoke).toHaveBeenCalledWith('c1')
  expect(host.textContent).not.toContain('editor')
})

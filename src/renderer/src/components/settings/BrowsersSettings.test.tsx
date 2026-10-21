// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { WebDevicesStatus } from '../../../../shared/web-client'
import { ConfirmDialogProvider } from '../ui/ConfirmDialog'
import { BrowsersSettings } from './BrowsersSettings'

let root: Root | null = null
let host: HTMLElement | null = null

const status: WebDevicesStatus = {
  devices: [
    {
      id: 'b1',
      name: 'Chrome on macOS',
      route: 'loopback',
      createdAt: '2026-10-01T00:00:00Z',
      expiresAt: '2026-10-31T00:00:00Z',
      lastSeenAt: '2026-10-03T00:00:00Z',
      current: true,
    },
  ],
  requests: [
    {
      requestId: 'r1',
      name: 'Phone',
      route: 'tailnet',
      createdAt: '2026-10-03T00:00:00Z',
      expiresAt: '2026-10-03T00:05:00Z',
    },
  ],
  origins: ['http://127.0.0.1:4791'],
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

async function mount(api: Record<string, unknown>) {
  ;(window as unknown as { api: unknown }).api = { onWebDevicesChanged: () => () => undefined, ...api }
  await act(async () =>
    root?.render(
      <ConfirmDialogProvider>
        <BrowsersSettings />
      </ConfirmDialogProvider>,
    ),
  )
}

test('a desktop window, whose server answers nothing here, draws nothing', async () => {
  await mount({ webDevicesStatus: () => Promise.reject(new Error('No handler registered')) })
  expect(host?.textContent).toBe('')
})

test('paired browsers are listed, and a request is let in by the digits it shows', async () => {
  const approve = vi.fn(async () => ({ ok: true as const }))
  await mount({ webDevicesStatus: async () => status, webDevicesApprove: approve })
  expect(host?.textContent).toContain('Chrome on macOS (this browser)')
  expect(host?.textContent).toContain('Phone asks to pair')
  const field = host?.querySelector<HTMLInputElement>('input[aria-label="The code Phone shows"]')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, '12 34 56')
    field?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const letIn = [...(host?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Let in')
  await act(async () => letIn?.click())
  expect(approve).toHaveBeenCalledWith('r1', '123456')
})

test("a paired browser's last-seen time moves on while the panel stays open", async () => {
  // Only the interval is faked: the window's shared clock keeps the Date it
  // first saw, so the time is moved on that Date rather than a fake one.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let now = Date.parse('2026-10-03T00:00:30Z')
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    await mount({ webDevicesStatus: async () => status })
    expect(host?.textContent).toContain('last seen 30 seconds ago')
    now += 90_000
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(host?.textContent).toContain('last seen 2 minutes ago')
  } finally {
    clock.mockRestore()
    vi.useRealTimers()
  }
})

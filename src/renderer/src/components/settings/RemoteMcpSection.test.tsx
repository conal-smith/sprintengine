import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { test } from 'vitest'

import type { TailnetDevice, TailnetPairRequest, TailnetRemoteStatus, TailnetScope } from '../../../../shared/tailnet'
import { PairRequestCard } from '../remote/PairRequestCard'
import { RemoteMcpSection } from './RemoteMcpSection'
import { mcpHttpsHelp, mcpUrlHelp, signInEnds } from './tailnetPanelModel'

// Settings → Remote's MCP section and the sign-in card, mounted: the URL a
// person gives an outside client, the HTTPS switch, the clients let in, and
// the card that answers a client signing in.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

const approvals: Array<{ id: string; scopes: TailnetScope[]; code: string }> = []
;(dom.window as unknown as { api: unknown }).api = {
  clipboardWriteText: () => Promise.resolve(),
  tailnetApprovePairRequest: (id: string, scopes: TailnetScope[], code: string) => {
    approvals.push({ id, scopes, code })
    return Promise.resolve({ ok: true, device: CLIENT, status: STATUS })
  },
  tailnetDenyPairRequest: () => Promise.resolve(STATUS),
}

const NOW = Date.parse('2026-11-03T12:00:00.000Z')

const CLIENT: TailnetDevice = {
  id: 'tnd_oauth',
  name: 'Claude Code (studio)',
  scopes: ['workspace:read', 'backlog:read', 'conversation:read'],
  createdAt: '2026-11-01T12:00:00.000Z',
  lastSeenAt: '2026-11-03T11:58:00.000Z',
  lastPeerNode: 'dev-macbook-air.example.ts.net',
  origin: { kind: 'oauth', by: 'Claude Code (studio)' },
  signInEndsAt: '2026-12-01T12:00:00.000Z',
}

const PHONE: TailnetDevice = {
  id: 'tnd_phone',
  name: 'android-phone',
  scopes: ['conversation:read'],
  createdAt: '2026-10-01T12:00:00.000Z',
  lastSeenAt: null,
  lastPeerNode: null,
  origin: { kind: 'code', by: null },
}

const STATUS: TailnetRemoteStatus = {
  enabled: true,
  running: true,
  endpoint: '100.64.0.66:8471',
  port: 8471,
  tailnetAddress: '100.64.0.66',
  lastError: null,
  notifications: true,
  devices: [CLIENT, PHONE],
  pairing: null,
  pairRequests: [],
  mcp: {
    url: 'https://mac-mini.example.ts.net/tailnet/v1/mcp',
    httpUrl: 'http://mac-mini.example.ts.net:8471/tailnet/v1/mcp',
    https: { enabled: true, state: 'on', origin: 'https://mac-mini.example.ts.net', message: null },
  },
}

async function mount(element: React.ReactElement): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.append(host)
  let root: Root | null = null
  await act(async () => {
    root = createRoot(host)
    root.render(element)
  })
  return {
    host,
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

function buttonNamed(host: HTMLElement, name: RegExp): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll('button')].find((button) =>
      name.test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()),
    ) ?? null
  )
}

test('the section shows the URL to give a client and lists the clients let in, and only those', async () => {
  const calls = { https: [] as boolean[], revoked: [] as string[], scopes: [] as Array<[string, TailnetScope[]]> }
  const { host, unmount } = await mount(
    <RemoteMcpSection
      status={STATUS}
      now={NOW}
      busy={false}
      onSetHttps={(next) => calls.https.push(next)}
      onRevoke={(device) => calls.revoked.push(device.id)}
      onUpdateScopes={(device, scopes) => calls.scopes.push([device.id, scopes])}
    />,
  )
  try {
    assert.match(host.textContent ?? '', /https:\/\/mac-mini\.example\.ts\.net\/tailnet\/v1\/mcp/u)
    assert.ok(buttonNamed(host, /Copy the MCP URL/u), 'the URL has a copy button')
    const rows = [...host.querySelectorAll('[data-mcp-client]')]
    assert.deepEqual(
      rows.map((row) => row.getAttribute('data-mcp-client')),
      ['tnd_oauth'],
      'a paired phone is a machine, not an MCP client',
    )
    assert.match(rows[0]!.textContent ?? '', /On dev-macbook-air\.example\.ts\.net/u)
    assert.match(rows[0]!.textContent ?? '', /3 scopes/u)
    assert.match(rows[0]!.textContent ?? '', /Ends in 28 days/u)
    await act(async () => buttonNamed(rows[0] as HTMLElement, /^Revoke$/u)!.click())
    assert.deepEqual(calls.revoked, ['tnd_oauth'])
    const httpsSwitch = host.querySelector('[role="switch"]') as HTMLButtonElement
    assert.equal(httpsSwitch.getAttribute('aria-checked'), 'true')
    await act(async () => httpsSwitch.click())
    assert.deepEqual(calls.https, [false])
  } finally {
    unmount()
  }
})

test('the help lines say what each state means', () => {
  assert.match(mcpUrlHelp(STATUS.mcp!), /You approve each one here/u)
  assert.match(
    mcpUrlHelp({ ...STATUS.mcp!, https: { enabled: false, state: 'off', origin: null, message: null } }),
    /only over HTTPS/u,
  )
  assert.match(mcpUrlHelp(null), /Turn on remote control/u)
  assert.match(mcpHttpsHelp({ enabled: true, state: 'error', origin: null, message: 'Port 443 is taken.' }), /443/u)
  assert.match(mcpHttpsHelp({ enabled: false, state: 'off', origin: null, message: null }), /Tailscale Serve/u)
  assert.equal(signInEnds(null, NOW), null)
  assert.equal(signInEnds('2026-11-04T11:00:00.000Z', NOW), 'Ends tomorrow')
  assert.equal(signInEnds('2026-11-01T00:00:00.000Z', NOW), 'Sign-in ended')
})

test('a sign-in card names the client and where its access goes, and opens on read only', async () => {
  const request: TailnetPairRequest = {
    id: 'tpr_signin',
    deviceName: 'Codex',
    peerNode: 'dev-macbook-air.example.ts.net',
    peerAddress: '100.64.0.70',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    requestedScopes: [
      'workspace:read',
      'workspace:operate',
      'backlog:read',
      'backlog:operate',
      'conversation:read',
      'conversation:operate',
    ],
    oauth: { clientName: 'Codex', redirectHost: '127.0.0.1', redirectKind: 'loopback' },
  }
  const { host, unmount } = await mount(<PairRequestCard request={request} now={Date.now()} />)
  try {
    const text = host.textContent ?? ''
    assert.match(text, /Codex wants access to this Studio/u)
    assert.match(text, /Access goes to/u)
    assert.match(text, /An MCP client on dev-macbook-air\.example\.ts\.net \(127\.0\.0\.1\)/u)
    assert.match(text, /Only allow a sign-in you just started/u)
    assert.match(text, /Enter the code shown on the sign-in page/u)
    const ticked = [...host.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => (input as HTMLInputElement).checked)
      .map((input) => (input as HTMLInputElement).id)
    assert.equal(ticked.length, 3, `read only is ticked: ${ticked.join(', ')}`)
    assert.ok(
      ticked.every((id) => /read/u.test(id)),
      ticked.join(', '),
    )
  } finally {
    unmount()
  }
})

test('a sign-in to a web service says whoever runs it gets the access', async () => {
  const request: TailnetPairRequest = {
    id: 'tpr_web',
    deviceName: 'Hosted agent',
    peerNode: null,
    peerAddress: '100.64.0.71',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    requestedScopes: ['workspace:read'],
    oauth: { clientName: 'Hosted agent', redirectHost: 'agent.example.com', redirectKind: 'https' },
  }
  const { host, unmount } = await mount(<PairRequestCard request={request} now={Date.now()} />)
  try {
    const text = host.textContent ?? ''
    assert.match(text, /agent\.example\.com — whoever runs it gets the access/u)
    assert.match(text, /100\.64\.0\.71 \(unverified\)/u)
  } finally {
    unmount()
  }
})

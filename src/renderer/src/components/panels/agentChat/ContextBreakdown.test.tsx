// @vitest-environment jsdom
//
// The composer strip's context ring as a button, and what it opens: the
// window's breakdown as the agent read it — a bar of every row, the rows in
// words, the heaviest thing loaded, and the MCP servers, skills and memory
// files heaviest first — read when it opens and again as a turn ends; and
// for an agent that gives no breakdown, the total alone, said as such.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type {
  ConversationContextBreakdown,
  ConversationContextBreakdownResult,
} from '../../../../../shared/conversation-runtime'
import { ContextBreakdownPanel, resetContextBreakdownCache, type ContextBreakdownSource } from './ContextBreakdown'
import { ConversationComposerStrip } from './conversationStrip'

const MEASURED = new Date(2026, 9, 21, 15, 12).getTime()

function breakdown(overrides: Partial<ConversationContextBreakdown> = {}): ConversationContextBreakdown {
  return {
    model: 'claude-sonnet-4-5',
    usedTokens: 60_000,
    windowTokens: 200_000,
    categories: [
      { name: 'System prompt', tokens: 4_000, kind: 'used' },
      { name: 'System tools', tokens: 12_000, kind: 'used' },
      { name: 'MCP tools', tokens: 14_000, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
      { name: 'Messages', tokens: 30_000, kind: 'used' },
      { name: 'Free space', tokens: 107_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    ],
    mcpServers: [
      {
        name: 'sprintengine-studio',
        tokens: 12_000,
        tools: [
          { name: 'tour_create', tokens: 9_000, loaded: false },
          { name: 'browser_open', tokens: 7_000, loaded: true },
          { name: 'canvas_edit', tokens: 5_000, loaded: true },
        ],
      },
      { name: 'linear', tokens: 2_000, tools: [{ name: 'create_issue', tokens: 2_000, loaded: true }] },
    ],
    skills: [
      { name: 'deploy', tokens: 1_200, detail: 'plugin' },
      { name: 'review', tokens: 300, detail: 'projectSettings' },
    ],
    memoryFiles: [{ name: '/Users/dev/acme/CLAUDE.md', tokens: 1_900, detail: 'Project' }],
    agents: [],
    autoCompactAt: 167_000,
    estimated: true,
    measuredAt: MEASURED,
    ...overrides,
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {}
  resetContextBreakdownCache()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ''
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

async function rerender(node: React.ReactNode): Promise<void> {
  await act(async () => root!.render(node))
}

function source(
  load: ContextBreakdownSource['load'],
  overrides: Partial<ContextBreakdownSource> = {},
): ContextBreakdownSource {
  return { load, agentName: 'Claude Code', cacheKey: 'session-1', refreshKey: 1, ...overrides }
}

const CONTEXT = { used: 61_000, total: 200_000 }

async function openRing(strip: HTMLElement): Promise<HTMLElement> {
  const trigger = strip.querySelector<HTMLButtonElement>('[data-strip-context-button]')!
  await act(async () => trigger.click())
  return document.querySelector<HTMLElement>('[data-context-breakdown]')!
}

test('the ring is a button named by its share and counts, which opens a dialog', async () => {
  const strip = await render(
    <ConversationComposerStrip machine={null} branch={null} changes={null} context={CONTEXT} />,
  )
  const trigger = strip.querySelector<HTMLButtonElement>('[data-strip-context] [data-strip-context-button]')!
  expect(trigger.tagName).toBe('BUTTON')
  expect(trigger.getAttribute('aria-label')).toBe('Context 31% used, 61,000 / 200,000 tokens — show what fills it')
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  // The ring inside is the button's picture; the button carries the name.
  expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
})

test('an agent with no breakdown opens on the total alone, said as such', async () => {
  const strip = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={CONTEXT}
      contextBreakdown={source(null, { agentName: 'Codex' })}
    />,
  )
  const panel = await openRing(strip)
  expect(panel.textContent).toContain('31% · 61k of 200k')
  expect(panel.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('31')
  expect(panel.querySelector('[data-context-breakdown-note]')?.textContent).toBe(
    'Codex reports how full the window is, not what fills it.',
  )
})

test('opening reads the breakdown and draws the bar, its rows and the heaviest item', async () => {
  const load = vi.fn(async (): Promise<ConversationContextBreakdownResult> => ({ ok: true, breakdown: breakdown() }))
  const strip = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={CONTEXT}
      contextBreakdown={source(load)}
    />,
  )
  expect(load).not.toHaveBeenCalled()
  const panel = await openRing(strip)
  expect(load).toHaveBeenCalledTimes(1)
  // The header is the reading's own total, so it and the bar agree.
  expect(panel.textContent).toContain('30% · 60k of 200k')
  const segments = [...panel.querySelectorAll('[data-context-segment]')]
  expect(segments.map((segment) => segment.getAttribute('data-context-segment'))).toEqual([
    'used',
    'used',
    'used',
    'used',
    'free',
    'buffer',
  ])
  const rows = [...panel.querySelectorAll('[data-context-category]')].map((row) => row.textContent)
  expect(rows).toContain('Messages30k · 15%')
  expect(rows).toContain('MCP tools (deferred)9k · not in the window')
  expect(panel.querySelector('[data-context-heaviest="mcp"]')?.textContent).toBe(
    'Heaviest you loaded: the sprintengine-studio MCP server, 12k tokens (6% of the window)',
  )
  expect(panel.querySelector('[data-context-reading-note]')?.textContent).toMatch(/^Claude Code’s estimate · /)
})

test('the groups open from the keyboard’s button, heaviest first, and a server opens to its tools', async () => {
  const panel = await render(
    <ContextBreakdownPanel
      context={CONTEXT}
      source={source(async () => ({ ok: true, breakdown: breakdown() }))}
      reading={{ result: { ok: true, breakdown: breakdown() }, loading: false }}
      onRefresh={() => undefined}
    />,
  )
  const mcp = panel.querySelector('[data-context-group="mcp"]')!
  const toggle = mcp.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(toggle.textContent).toContain('MCP servers')
  expect(toggle.textContent).toContain('14k · 7%')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const servers = [...mcp.querySelectorAll('[data-context-mcp-server]')]
  expect(servers.map((server) => server.getAttribute('data-context-mcp-server'))).toEqual([
    'sprintengine-studio',
    'linear',
  ])
  expect(servers[0]!.textContent).toContain('2 of 3 loaded')
  await act(async () => servers[0]!.querySelector<HTMLButtonElement>('button')!.click())
  const tools = [...servers[0]!.querySelectorAll('li')].map((row) => row.textContent)
  expect(tools[0]).toBe('tour_create9k · not loaded')
  expect(tools[1]).toBe('browser_open7k · 4%')

  const skills = panel.querySelector('[data-context-group="skills"]')!
  await act(async () => skills.querySelector<HTMLButtonElement>('button')!.click())
  expect([...skills.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
    'deployplugin1.2k · <1%',
    'reviewprojectSettings300 · <1%',
  ])
  const memory = panel.querySelector('[data-context-group="memory"]')!
  await act(async () => memory.querySelector<HTMLButtonElement>('button')!.click())
  expect(memory.querySelector('li')?.textContent).toBe('…/acme/CLAUDE.mdProject1.9k · <1%')
  expect(panel.querySelector('[data-context-group="agents"]')).toBe(null)
})

test('an open panel reads again as a turn ends, and a failed read keeps the last one, marked old', async () => {
  let answer: ConversationContextBreakdownResult = { ok: true, breakdown: breakdown() }
  const load = vi.fn(async () => answer)
  const strip = (refreshKey: number) => (
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={CONTEXT}
      contextBreakdown={source(load, { refreshKey })}
    />
  )
  const host = await render(strip(1))
  await openRing(host)
  expect(load).toHaveBeenCalledTimes(1)
  answer = { ok: false, reason: 'not-running', message: 'Claude Code is not running for this chat now.' }
  await rerender(strip(2))
  expect(load).toHaveBeenCalledTimes(2)
  const panel = document.querySelector<HTMLElement>('[data-context-breakdown]')!
  expect(panel.querySelector('[data-context-segment]')).not.toBe(null)
  expect(panel.querySelector('[data-context-reading-note]')?.textContent).toMatch(/· last read at /)
})

test('an agent that is not running and was never read says so', async () => {
  const strip = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={CONTEXT}
      contextBreakdown={source(async () => ({
        ok: false,
        reason: 'not-running',
        message: 'Claude Code is not running for this chat now.',
      }))}
    />,
  )
  const panel = await openRing(strip)
  expect(panel.querySelector('[data-context-breakdown-note]')?.textContent).toBe(
    'Claude Code is not running for this chat now.',
  )
  expect(panel.querySelector('[role="meter"]')).not.toBe(null)
})

test('from the keyboard the dialog takes focus as it opens, and Escape gives it back to the ring', async () => {
  const strip = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={CONTEXT}
      contextBreakdown={source(async () => ({ ok: true, breakdown: breakdown() }))}
    />,
  )
  const trigger = strip.querySelector<HTMLButtonElement>('[data-strip-context-button]')!
  trigger.focus()
  await act(async () => trigger.click())
  await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('Context window')
  expect(dialog.contains(document.activeElement)).toBe(true)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.querySelector('[data-context-breakdown]')).toBe(null)
  expect(document.activeElement).toBe(trigger)
})

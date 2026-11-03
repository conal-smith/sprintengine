// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { InstalledPluginRecord } from '../../../../../../shared/ipc/skills'
import {
  emptyPluginComponents,
  type AgentMcpServer,
  type ScannedMcpServer,
  type ScannedPlugin,
  type ScannedSkill,
  type SkillSource,
} from '../../../../../../shared/skills'
import { ConversationLinkProvider } from '../conversationLinks'
import type { TranscriptToolEntry } from '../conversationProjection'
import { PluginOfferCard, PluginOfferChatProvider, type PluginOfferChat } from './PluginOfferCard'
import { PRESELECT_SKILLS_UP_TO } from './pluginOfferModel'

// The card an agent's `plugin.offer` draws: one button that installs through
// the dialog, signs this chat in once a server it added asks for that, and
// otherwise opens the plugin to manage it.

const SOURCE: SkillSource = {
  id: 'official',
  kind: 'github',
  name: 'Claude plugins',
  repo: 'acme/plugins',
  monogram: 'AC',
  blurb: '',
  commitSha: '',
  scannedAt: '',
}

function skill(id: string): ScannedSkill {
  return {
    id,
    name: `Skill ${id}`,
    description: `Does ${id}`,
    group: '',
    files: [],
    allowedTools: [],
    hasExecutables: false,
  }
}

const SERVER: ScannedMcpServer = {
  id: 'sentry',
  name: 'Sentry',
  description: '',
  transport: 'http',
  command: '',
  args: [],
  url: 'https://mcp.example.com/sentry',
  env: {},
  envVarNames: [],
  headers: {},
  declaredIn: '.mcp.json',
  declaredBy: 'sentry',
}

function plugin(skills: ScannedSkill[]): ScannedPlugin {
  return {
    id: 'sentry',
    name: 'Sentry',
    description: 'Let the agent read your Sentry issues',
    version: '',
    category: '',
    author: '',
    homepage: '',
    origin: { kind: 'in-tree', path: 'plugins/sentry' },
    strict: true,
    tags: [],
    keywords: [],
    componentsKnown: true,
    components: { ...emptyPluginComponents(), skills, mcpServers: [SERVER] },
  }
}

const RECORD: InstalledPluginRecord = {
  workspaceRoot: '/Users/dev/app',
  sourceId: 'official',
  pluginId: 'sentry',
  pluginName: 'Sentry',
  marketplaceName: 'plugins',
  claudePluginKey: '',
  skillDirNames: [],
  mcpServerIds: ['sentry'],
  commitSha: '',
  installedAt: '',
}

const TOOL: TranscriptToolEntry = {
  kind: 'tool',
  id: 'offer-1',
  turnId: 'turn',
  name: 'mcp__sprintengine-studio__plugin_offer',
  status: 'done',
  input: { sourceId: 'official', pluginId: 'sentry' },
}

let root: Root
let host: HTMLDivElement
let installs: unknown[]
let opened: string[]
let installed: InstalledPluginRecord[]
let servers: AgentMcpServer[]
let skills: ScannedSkill[]

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  installs = []
  opened = []
  installed = []
  servers = []
  skills = [skill('triage'), skill('summarise')]
  ;(window as unknown as { api: unknown }).api = {
    skillsGetScan: async () => ({ ok: true, source: SOURCE, scan: { plugins: [plugin(skills)] } }),
    skillsListInstalledPlugins: async () => ({ ok: true, plugins: installed }),
    agentCapabilities: async () => ({ ok: true, servers }),
    skillsInstallPlugin: async (input: unknown) => {
      installs.push(input)
      installed = [RECORD]
      return { ok: true, mcpServers: [], harnesses: [], warnings: [] }
    },
    openExternal: async (url: string) => {
      opened.push(url)
      return { ok: true }
    },
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function render(chat: PluginOfferChat = { cli: 'claude', signIn: null }): Promise<void> {
  await act(async () =>
    root.render(
      <ConversationLinkProvider workspaceId="ws" cwd="/Users/dev/app" workspaceRoot="/Users/dev/app">
        <PluginOfferChatProvider value={chat}>
          <PluginOfferCard tool={TOOL} fallback={<div>tool row</div>} />
        </PluginOfferChatProvider>
      </ConversationLinkProvider>,
    ),
  )
}

const button = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === text)

test('an offered plugin shows its name and description, and Install opens the dialog that installs what is ticked', async () => {
  await render()
  expect(host.textContent).toContain('Sentry')
  expect(host.textContent).toContain('Let the agent read your Sentry issues')
  // No source, counts or scope on the card: those are the dialog's.
  expect(host.textContent).not.toContain('Claude plugins')

  await act(async () => button('Install')!.click())
  expect(document.body.textContent).toContain('Install Sentry?')
  expect(document.body.textContent).toContain('From Claude plugins')
  expect(document.body.textContent).toContain('https://mcp.example.com/sentry')

  await act(async () => button('Trust & install')!.click())
  expect(installs).toEqual([
    {
      sourceId: 'official',
      pluginId: 'sentry',
      workspaceRoot: '/Users/dev/app',
      skillIds: ['triage', 'summarise'],
      mcpServerIds: ['sentry'],
    },
  ])
  // Installed: the dialog is gone and the card manages it from here.
  expect(document.body.textContent).not.toContain('Install Sentry?')
  expect(host.textContent).toContain('Installed')
  expect(button('Manage')).toBeDefined()
})

test('a plugin with many skills starts with none of them ticked', async () => {
  skills = Array.from({ length: PRESELECT_SKILLS_UP_TO + 1 }, (_, index) => skill(`s${index}`))
  await render()
  await act(async () => button('Install')!.click())
  expect(document.body.textContent).toContain(`0 of ${skills.length}`)
  expect(button(`Show all ${skills.length}`)).toBeDefined()
  await act(async () => button('Trust & install')!.click())
  expect((installs[0] as { skillIds: string[] }).skillIds).toEqual([])
})

test('once a server it added needs signing in, the button signs this chat in and opens the browser', async () => {
  installed = [RECORD]
  servers = [{ id: 'sentry', transport: 'http', scope: 'workspace', status: 'needs-auth' }]
  const asked: string[] = []
  await render({
    cli: 'claude',
    signIn: async (serverId) => {
      asked.push(serverId)
      return { ok: true, authUrl: 'https://auth.example.com/login' }
    },
  })
  expect(host.textContent).toContain('Installed · Sign in to connect')
  await act(async () => button('Sign in')!.click())
  expect(asked).toEqual(['sentry'])
  expect(opened).toEqual(['https://auth.example.com/login'])

  // Signed in: the chat reports it connected, and the card says so.
  servers = [{ id: 'sentry', transport: 'http', scope: 'workspace', status: 'connected' }]
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(host.textContent).toContain('Connected')
  expect(button('Manage')).toBeDefined()
})

test('a chat that cannot sign in manages the plugin instead', async () => {
  installed = [RECORD]
  servers = [{ id: 'sentry', transport: 'http', scope: 'workspace', status: 'needs-auth' }]
  await render({ cli: 'claude', signIn: null })
  expect(button('Sign in')).toBeUndefined()
  expect(button('Manage')).toBeDefined()
})

test('a plugin its source no longer lists stays the plain tool row', async () => {
  ;(window as unknown as { api: Record<string, unknown> }).api.skillsGetScan = async () => ({
    ok: true,
    source: SOURCE,
    scan: { plugins: [] },
  })
  await render()
  expect(host.textContent).toBe('tool row')
})

test('every skill is listed when they start ticked, so none installs unseen', async () => {
  skills = Array.from({ length: PRESELECT_SKILLS_UP_TO }, (_, index) => skill(`s${index}`))
  await render()
  await act(async () => button('Install')!.click())
  expect(document.querySelectorAll('[role="dialog"] input[type="checkbox"]').length).toBe(skills.length + 1)
  expect(button(`Show all ${skills.length}`)).toBeUndefined()
})

test('a server the plugin names with capitals or dots is matched as the CLI names it', async () => {
  installed = [{ ...RECORD, mcpServerIds: ['Sentry.io'] }]
  servers = [{ id: 'sentry-io', transport: 'http', scope: 'workspace', status: 'needs-auth' }]
  const asked: string[] = []
  await render({
    cli: 'claude',
    signIn: async (serverId) => {
      asked.push(serverId)
      return { ok: true }
    },
  })
  await act(async () => button('Sign in')!.click())
  expect(asked).toEqual(['sentry-io'])
})

import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// The title bar's branch chip, its Git panel door, steps aside while the agent
// followed is a conversation: its composer strip says the branch and the
// changes and opens the panels from there (owner ruling 2026-10-04). A terminal
// has no strip, so with one followed the bar keeps its branch chip. The project
// is named by neither (owner ruling 2026-10-16): the sidebar and the composer's
// context strip already say it.

async function mountIdentity(
  runtime: 'conversation' | 'terminal',
  extraProps: Record<string, unknown> = {},
  workspaceFields: Record<string, unknown> = {},
) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: {
      platform: 'darwin',
      getGitRepoRoot: async (path: string) => path,
      getGitBranches: async () => ({ current: 'fix/cli-update-output', branches: [] }),
      watchGitCheckout: () => () => undefined,
      getWorkspaceChangeSummary: async () => ({
        additions: 3,
        deletions: 0,
        changedFiles: 3,
        scope: 'folder',
        files: { added: 0, updated: 3, removed: 0 },
      }),
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { WorkspaceIdentity } = await import('./WorkspaceIdentity')
  const agent =
    runtime === 'conversation'
      ? { id: 'agent', name: 'Chat', runtimeKind: 'conversation', conversation: { providerId: 'mock', modelId: 'm' } }
      : { id: 'agent', name: 'Shell agent', runtimeKind: 'terminal', cli: 'claude-code' }
  const workspace = {
    id: 'workspace',
    name: 'Project',
    folderPath: '/Users/dev/project',
    agents: { agent },
    ...workspaceFields,
  }
  useWorkspaceStore.setState({
    workspaces: [workspace] as never,
    focusedAgentByWorkspaceId: { workspace: 'agent' } as never,
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(WorkspaceIdentity, {
        activeWorkspace: workspace as never,
        activeWorkspaceId: 'workspace',
        ...extraProps,
      }),
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const labels = () => Array.from(host.querySelectorAll('button')).map((item) => item.getAttribute('aria-label') ?? '')
  return {
    host,
    labels,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('with a conversation followed, the title bar carries no project, branch, counts or panel doors', async () => {
  const bar = await mountIdentity('conversation')
  try {
    expect(bar.host.querySelector('[aria-label^="Toggle file explorer"]')).toBeNull()
    expect(bar.host.textContent).not.toContain('fix/cli-update-output')
    expect(bar.host.textContent).not.toContain('+3')
    expect(bar.labels().some((label) => label.startsWith('Toggle Git panel'))).toBe(false)
    expect(bar.labels().some((label) => label.startsWith('Toggle file explorer'))).toBe(false)
  } finally {
    await bar.unmount()
  }
})

test('with a terminal agent followed, the title bar keeps its branch chip and counts, and names no project', async () => {
  const bar = await mountIdentity('terminal')
  try {
    expect(bar.host.textContent).toContain('fix/cli-update-output')
    expect(bar.host.textContent).toContain('+3')
    expect(bar.labels().some((label) => label.startsWith('Toggle Git panel, branch fix/cli-update-output'))).toBe(true)
    expect(bar.labels().some((label) => label.startsWith('Toggle file explorer'))).toBe(false)
  } finally {
    await bar.unmount()
  }
})

// Label-in-name: the button shows the chat's name, so its accessible name must
// contain it — a voice user says what they see — and still say what it does.
test('the name that toggles the sidebar keeps the visible name in its accessible name', async () => {
  for (const sidebarCollapsed of [false, true]) {
    const bar = await mountIdentity('conversation', { onToggleSidebar: () => undefined, sidebarCollapsed })
    try {
      const action = sidebarCollapsed ? 'open sidebar' : 'close sidebar'
      expect(bar.labels()).toContain(`Project, ${action}`)
    } finally {
      await bar.unmount()
    }
  }
})

// A chat that runs on a paired machine (owner, 2026-10-08): the strip names
// the chat once and its project over there, in the folder chip's shape, with
// the machine's mark after it. Never the machine's tailnet address, and never
// the remote workspace's name, which for a chat is its own title again.
test('a chat on a paired machine names its project there, not the machine’s address or the chat a second time', async () => {
  const bar = await mountIdentity(
    'conversation',
    {},
    {
      name: 'How is this project?',
      folderPath: null,
      remoteOrigin: {
        connectionId: 'c1',
        machineName: 'mac-mini.tail1234.ts.net',
        workspaceId: 'rw1',
        workspaceName: 'How is this project?',
        workspaceRoot: '/Users/dev/home-lab',
      },
    },
  )
  try {
    const text = bar.host.textContent ?? ''
    expect(text).toContain('home-lab')
    expect(text).not.toContain('tail1234')
    expect(text).not.toContain('mac-mini')
    expect(text.split('How is this project?').length - 1, 'the chat is named once').toBe(1)
    expect(bar.host.querySelector('[data-remote-machine]')).not.toBeNull()
  } finally {
    await bar.unmount()
  }
})

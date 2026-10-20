// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { WorktreeInventory, WorktreeInventoryInput } from '../../../../shared/ipc/worktree-pool'

const GB = 1024 ** 3
const now = Date.now()
const REPO = '/code/app'
const POOL = '/code/.sprintengine-worktrees/app'

const fixtures = vi.hoisted(() => ({
  state: {
    workspaces: [] as unknown[],
    appSettings: { worktreeBranchPrefix: 'agent' },
    setWorktreeBranchPrefix: (prefix: string) => {
      fixtures.prefixes.push(prefix)
    },
  },
  prefixes: [] as string[],
}))
vi.mock('../../store/workspaceStore', () => {
  const useWorkspaceStore = (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state)
  useWorkspaceStore.getState = () => fixtures.state
  return { useWorkspaceStore }
})

const { WorktreesSettingsTab, forgetWorktreeInventoryForTests } = await import('./WorktreesSettingsTab')
const { ConfirmDialogProvider } = await import('../ui')

const size = (bytes: number) => ({ bytes, measuredAt: now, parts: [{ name: 'node_modules', bytes }] })
const baseSlot = {
  baseRef: 'origin/main',
  baseSha: 'a41c9e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  error: null,
  lease: null,
  held: null,
  uses: 2,
  lastBranch: null,
  kept: null,
  parked: null,
}
const inventory: WorktreeInventory = {
  measuredAt: now,
  projects: [
    {
      repoRoot: REPO,
      defaultRef: 'origin/main',
      error: null,
      pool: {
        poolId: 'p1',
        repoRoot: REPO,
        containerPath: POOL,
        heldByOtherInstance: false,
        defaultRef: 'origin/main',
        lastFetchAt: now,
        slots: [
          {
            ...baseSlot,
            id: 'pool-01',
            path: `${POOL}/pool-01`,
            state: 'leased',
            lease: {
              leaseId: 'l1',
              branch: 'agent/fix-login',
              owner: 'a',
              agentId: null,
              workspaceId: null,
              leasedAt: now,
            },
            lastUsedAt: now,
            size: size(2 * GB),
          },
          {
            ...baseSlot,
            id: 'pool-02',
            path: `${POOL}/pool-02`,
            state: 'held',
            held: { reason: 'dirty', detail: null, changedPaths: 1, branch: 'agent/copy', since: now },
            lastUsedAt: now,
            size: size(GB),
          },
          {
            ...baseSlot,
            id: 'pool-03',
            path: `${POOL}/pool-03`,
            state: 'idle',
            lastUsedAt: now - 1000,
            size: size(GB),
          },
          {
            ...baseSlot,
            id: 'pool-04',
            path: `${POOL}/pool-04`,
            state: 'idle',
            lastUsedAt: now - 9000,
            size: size(GB),
          },
        ],
      },
      worktrees: [
        {
          path: '/code/by-hand',
          branch: 'feat/merged',
          head: 'f00',
          slotId: null,
          lockedByOther: false,
          missing: false,
          uniqueCommits: 0,
          behindCommits: 0,
          merged: true,
          changedPaths: 0,
          changes: [],
          lastUsedAt: null,
          size: size(3 * GB),
        },
      ],
    },
  ],
}

let root: Root
let host: HTMLDivElement
const calls: { inventory: WorktreeInventoryInput[]; actions: unknown[]; removed: unknown[] } = {
  inventory: [],
  actions: [],
  removed: [],
}
const opened: string[] = []

let measuredOnce = false

beforeEach(() => {
  forgetWorktreeInventoryForTests()
  measuredOnce = false
  calls.inventory.length = 0
  calls.actions.length = 0
  calls.removed.length = 0
  opened.length = 0
  fixtures.prefixes.length = 0
  fixtures.state.appSettings.worktreeBranchPrefix = 'agent'
  fixtures.state.workspaces = [
    { id: 'w1', name: 'Fix the login redirect loop', folderPath: `${POOL}/pool-01`, agents: {} },
  ]
  Object.assign(window, {
    api: {
      getWorktreeInventory: async (input: WorktreeInventoryInput) => {
        calls.inventory.push(input)
        // Main has measured nothing until it is first asked to.
        if (input.measure) measuredOnce = true
        return measuredOnce ? inventory : { ...inventory, measuredAt: null }
      },
      getWorktreePoolSettings: async () => ({ enabled: true, keepIdle: 3, maxSlots: 12, diskLimitGb: 30 }),
      setWorktreePoolSettings: async (patch: object) => ({
        enabled: true,
        keepIdle: 3,
        maxSlots: 12,
        diskLimitGb: 30,
        ...patch,
      }),
      onWorktreePoolChanged: () => () => {},
      worktreePoolAction: async (input: unknown) => {
        calls.actions.push(input)
        return { ok: true, message: null }
      },
      removeOtherWorktree: async (input: unknown) => {
        calls.removed.push(input)
        return { ok: true, message: null }
      },
      pruneGitWorktrees: async () => ({ ok: true, data: {}, message: null }),
      showItemInFolder: async () => {},
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <WorktreesSettingsTab onOpenChat={(id) => opened.push(id)} />
      </ConfirmDialogProvider>,
    ),
  )
  // The first read, then the measured one.
  await act(async () => {
    await Promise.resolve()
  })
}

const rowNamed = (name: string) =>
  [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')].find((tr) => tr.textContent?.startsWith(name)) ?? null

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no button ${label}`)
  return found
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
}

test('reads what is known, then measures, and shows every worktree with who has it', async () => {
  await render()
  expect(calls.inventory.map((input) => input.measure)).toEqual([false, true])
  expect(calls.inventory[0].repoRoots).toEqual([REPO])
  expect(host.textContent).toContain('Worktrees')
  expect(host.textContent).toContain('8.0 GB')
  expect(rowNamed('pool-01')?.textContent).toContain('Fix the login redirect loop')
  expect(rowNamed('pool-02')?.textContent).toContain('Holding work')
  expect(rowNamed('by-hand')?.textContent).toContain('Merged')

  await click(button(rowNamed('pool-01')!, 'Open chat'))
  expect(opened).toEqual(['w1'])
})

test('Remove on a ready slot asks, then removes it through the pool', async () => {
  await render()
  await click(button(rowNamed('pool-03')!, 'Remove'))
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog?.textContent).toContain('Remove pool-03?')
  const confirm = button(dialog!, 'Remove')
  await click(confirm)
  expect(calls.actions).toEqual([{ kind: 'evict', repoRoot: REPO, slotId: 'pool-03' }])
})

test('Free up space removes the extra ready slot and the merged worktree, keeping the newest ready one', async () => {
  await render()
  await click(button(host, 'Free up space…'))
  const free = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.startsWith('Free 4.0 GB'),
  )
  expect(free).toBeTruthy()
  await click(free!)
  expect(calls.actions).toEqual([{ kind: 'evict', repoRoot: REPO, slotId: 'pool-04' }])
  expect(calls.removed).toEqual([{ repoRoot: REPO, path: '/code/by-hand' }])
})

test('Free up space keeps what the person unticked when the page reads the worktrees again', async () => {
  let poolChanged: (() => void) | null = null
  Object.assign((window as unknown as { api: object }).api, {
    onWorktreePoolChanged: (cb: () => void) => {
      poolChanged = cb
      return () => {}
    },
  })
  await render()
  await click(button(host, 'Free up space…'))
  const mergedRow = [...document.body.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find((label) =>
    label.textContent?.includes('whose branch is merged'),
  )
  await click(mergedRow!.querySelector('input')!)
  // A slot moves somewhere: the page reads again, a moment later.
  await act(async () => {
    poolChanged?.()
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
  const free = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.startsWith('Free 1.0 GB'),
  )
  expect(free).toBeTruthy()
  await click(free!)
  expect(calls.actions).toEqual([{ kind: 'evict', repoRoot: REPO, slotId: 'pool-04' }])
  expect(calls.removed).toEqual([])
})

test('Prune says what git did: a missing worktree locked by hand is kept, and the page says so', async () => {
  const gone = {
    ...inventory.projects[0].worktrees[0],
    path: '/code/gone-by-hand',
    branch: 'feat/gone',
    missing: true,
    size: null,
  }
  Object.assign((window as unknown as { api: object }).api, {
    getWorktreeInventory: async () => ({
      ...inventory,
      projects: [{ ...inventory.projects[0], worktrees: [...inventory.projects[0].worktrees, gone] }],
    }),
    listGitWorktrees: async () => ({
      ok: true,
      data: {
        repoRoot: REPO,
        updatedAt: now,
        worktrees: [{ path: '/code/gone-by-hand', locked: true, lockedReason: 'on a USB drive' }],
      },
      message: null,
    }),
  })
  await render()
  await click(button(rowNamed('gone-by-hand')!, 'Prune'))
  expect(host.textContent).toContain('Git kept gone-by-hand: it is locked (on a USB drive)')
  expect(host.textContent).not.toContain('Git forgot')
})

test('Prune counts only the other missing worktrees git actually forgot', async () => {
  const missing = (name: string) => ({
    ...inventory.projects[0].worktrees[0],
    path: `/code/${name}`,
    branch: `feat/${name}`,
    missing: true,
    size: null,
  })
  Object.assign((window as unknown as { api: object }).api, {
    getWorktreeInventory: async () => ({
      ...inventory,
      projects: [
        {
          ...inventory.projects[0],
          worktrees: [...inventory.projects[0].worktrees, missing('gone'), missing('kept-on-usb')],
        },
      ],
    }),
    // The other missing one is locked, so git keeps it.
    listGitWorktrees: async () => ({
      ok: true,
      data: { repoRoot: REPO, updatedAt: now, worktrees: [{ path: '/code/kept-on-usb', locked: true }] },
      message: null,
    }),
  })
  await render()
  await click(button(rowNamed('gone')!, 'Prune'))
  expect(host.textContent).toContain('Git forgot gone.')
  expect(host.textContent).not.toContain('other missing worktree')
})

function switchLabelled(label: string): HTMLElement {
  const labelEl = [...host.querySelectorAll<HTMLElement>('[id]')].find((el) => el.textContent?.trim() === label)
  const found = labelEl ? host.querySelector<HTMLElement>(`[role="switch"][aria-labelledby="${labelEl.id}"]`) : null
  if (!found) throw new Error(`no switch ${label}`)
  return found
}

test('installing dependencies is off for a project until turned on, and is saved for that project with its command', async () => {
  const patches: unknown[] = []
  let saved: object = { enabled: true, keepIdle: 3, maxSlots: 12, diskLimitGb: 30, dependencyInstall: {} }
  Object.assign((window as unknown as { api: object }).api, {
    getWorktreePoolSettings: async () => saved,
    setWorktreePoolSettings: async (patch: object) => {
      patches.push(patch)
      saved = { ...saved, ...patch }
      return saved
    },
  })
  await render()
  const toggle = switchLabelled('Install dependencies when the lockfile changes')
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(host.querySelector('[aria-label="Install command for app"]')).toBeNull()

  await click(toggle)
  expect(patches).toEqual([{ dependencyInstall: { [REPO]: { enabled: true, command: null } } }])

  const input = host.querySelector<HTMLInputElement>('[aria-label="Install command for app"]')
  expect(input).toBeTruthy()
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, 'pnpm install --frozen-lockfile && pnpm build')
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  expect(patches[1]).toEqual({
    dependencyInstall: { [REPO]: { enabled: true, command: 'pnpm install --frozen-lockfile && pnpm build' } },
  })
})

test('a running dependency install shows on its worktree’s row, and Cancel stops it', async () => {
  const cancelled: string[] = []
  let changed: ((view: unknown) => void) | null = null
  const running = {
    id: 'install-1',
    repoRoot: REPO,
    path: `${POOL}/pool-01`,
    branch: 'agent/fix-login',
    command: 'npm ci',
    reason: 'changed',
    state: 'running',
    startedAt: now,
    endedAt: null,
    lastLine: 'added 12 packages',
    output: null,
    exitCode: null,
  }
  Object.assign((window as unknown as { api: object }).api, {
    listWorktreeInstalls: async () => [running],
    onWorktreeInstallChanged: (cb: (view: unknown) => void) => {
      changed = cb
      return () => {}
    },
    cancelWorktreeInstall: async (id: string) => {
      cancelled.push(id)
      return true
    },
  })
  await render()
  expect(rowNamed('pool-01')?.textContent).toContain('installing dependencies · added 12 packages')
  await click(button(rowNamed('pool-01')!, 'Cancel install'))
  expect(cancelled).toEqual(['install-1'])

  await act(async () => changed?.({ ...running, state: 'cancelled', endedAt: now + 1000 }))
  expect(rowNamed('pool-01')?.textContent).not.toContain('installing dependencies')
  expect(rowNamed('pool-01')?.textContent).toContain('Open chat')
})

test('while a measurement runs, pool changes start no reads; one answered late does not undo a later one', async () => {
  let poolChanged: (() => void) | null = null
  let finishMeasure: ((value: WorktreeInventory) => void) | null = null
  const asked: boolean[] = []
  const renamed = (name: string): WorktreeInventory => ({
    ...inventory,
    projects: inventory.projects.map((project) => ({
      ...project,
      worktrees: project.worktrees.map((entry) => ({ ...entry, branch: name })),
    })),
  })
  Object.assign((window as unknown as { api: object }).api, {
    onWorktreePoolChanged: (cb: () => void) => {
      poolChanged = cb
      return () => {}
    },
    getWorktreeInventory: (input: WorktreeInventoryInput) => {
      asked.push(input.measure === true)
      if (input.measure) return new Promise<WorktreeInventory>((resolve) => (finishMeasure = resolve))
      return Promise.resolve({ ...renamed(`feat/read-${asked.length}`), measuredAt: null })
    },
  })
  await render()
  expect(asked).toEqual([false, true])
  // The measurement is still running: a change announced now is its to answer.
  await act(async () => {
    poolChanged?.()
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
  expect(asked).toEqual([false, true])
  // A removal reads again, quickly, and its answer lands first…
  await click(button(rowNamed('pool-03')!, 'Remove'))
  await click(button(document.body.querySelector<HTMLElement>('[role="dialog"]')!, 'Remove'))
  expect(asked).toEqual([false, true, false])
  expect(host.textContent).toContain('feat/read-3')
  // …so the measurement's older picture is not applied; one more read brings its sizes in.
  await act(async () => finishMeasure?.(renamed('feat/stale')))
  expect(host.textContent).not.toContain('feat/stale')
  expect(asked).toEqual([false, true, false, false])
})

test('turning reuse off says the ready worktrees go, and nothing changes unless confirmed', async () => {
  const saved: unknown[] = []
  Object.assign((window as unknown as { api: object }).api, {
    setWorktreePoolSettings: async (patch: object) => {
      saved.push(patch)
      return { enabled: true, keepIdle: 3, maxSlots: 12, diskLimitGb: 30, ...patch }
    },
  })
  await render()
  const toggle = host.querySelector<HTMLElement>('[role="switch"]')!
  await click(toggle)
  let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog?.textContent).toContain('Stop reusing worktrees?')
  expect(dialog?.textContent).toContain('The 2 ready worktrees are removed now')
  await click(button(dialog!, 'Cancel'))
  expect(saved).toEqual([])
  await click(toggle)
  dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
  await click(button(dialog!, 'Turn off and remove'))
  expect(saved).toEqual([{ enabled: false }])
})

test('settings that cannot be read are said so, not shown as saved defaults', async () => {
  Object.assign((window as unknown as { api: object }).api, {
    getWorktreePoolSettings: () => Promise.reject(new Error('settings file unreadable')),
  })
  await render()
  expect(host.textContent).toContain("Could not read the pool's settings: settings file unreadable")
})

test('an empty category reads 0 KB in the legend and the bar’s label, not 1 KB', async () => {
  const onlyInUse: WorktreeInventory = {
    ...inventory,
    projects: inventory.projects.map((project) => ({
      ...project,
      pool: project.pool ? { ...project.pool, slots: project.pool.slots.slice(0, 1) } : null,
      worktrees: [],
    })),
  }
  Object.assign(window.api, { getWorktreeInventory: async () => onlyInUse })
  await render()
  expect(host.textContent).toContain('Holding work 0 KB')
  expect(host.textContent).not.toContain('1 KB')
  expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Ready to reuse 0 KB')
})

test('the overview reflows with the page’s width, each label on one line beside its swatch', async () => {
  await render()
  const overview = host.querySelector<HTMLElement>('[aria-label="Overview"]')!
  expect(overview.parentElement?.className).toContain('@container')
  expect(overview.className).toContain('grid-cols-2')
  for (const label of ['Ready to reuse', 'Holding work']) {
    const span = [...overview.querySelectorAll('span')].find((candidate) => candidate.textContent === label)
    expect(span?.className).toContain('truncate')
  }
})

test('opened again, the page shows what it last read at once and measures only stale sizes', async () => {
  await render()
  expect(calls.inventory.map((input) => input.measure)).toEqual([false, true])
  await act(async () => root.unmount())
  root = createRoot(host)
  calls.inventory.length = 0
  let answer: ((value: WorktreeInventory) => void) | null = null
  Object.assign((window as unknown as { api: object }).api, {
    getWorktreeInventory: (input: WorktreeInventoryInput) => {
      calls.inventory.push(input)
      return new Promise<WorktreeInventory>((resolve) => (answer = resolve))
    },
  })
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <WorktreesSettingsTab onOpenChat={() => {}} />
      </ConfirmDialogProvider>,
    ),
  )
  // Drawn from what was read before, while the new read is still out.
  expect(rowNamed('pool-01')?.textContent).toContain('Fix the login redirect loop')
  await act(async () => {
    answer!(inventory)
    await Promise.resolve()
  })
  expect(calls.inventory.map((input) => input.measure)).toEqual([false])
})

test('the branch prefix names the branch it makes as it is typed, and is saved sanitized when left', async () => {
  await render()
  const input = host.querySelector<HTMLInputElement>('input[placeholder="No prefix"]')!
  const example = document.getElementById(input.getAttribute('aria-describedby')!)!
  expect(input.value).toBe('agent')
  expect(example.textContent).toBe('New worktrees are named agent/fix-login')

  const type = async (value: string) =>
    act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  await type('my team//')
  expect(example.textContent).toBe('New worktrees are named my-team/fix-login')
  // Nothing is saved while typing.
  expect(fixtures.prefixes).toEqual([])
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  expect(fixtures.prefixes).toEqual(['my-team'])
  expect(input.value).toBe('my-team')

  await type('')
  expect(example.textContent).toBe('New worktrees are named fix-login, with no prefix')
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(fixtures.prefixes).toEqual(['my-team', ''])
})

test('the branch prefix warns, as it is typed, about a remote’s name or one git keeps for itself', async () => {
  await render()
  const input = host.querySelector<HTMLInputElement>('input[placeholder="No prefix"]')!
  const type = async (value: string) =>
    act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const warning = () => host.querySelector('[role="status"]')?.textContent ?? null
  expect(warning()).toBeNull()
  await type('origin')
  expect(warning()).toContain('would hide the branches of a remote named origin')
  expect(input.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2)
  await type('refs/feat')
  expect(warning()).toContain('“refs” is a name git keeps for itself')
  expect(host.textContent).toContain('New worktrees are named feat/fix-login')
  await type('feat')
  expect(warning()).toBeNull()
})

import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { ConversationCommand } from '../../../../../shared/conversation/commands'
import {
  commandInsertText,
  commandSourceLabel,
  commandWorksMidMessage,
  rankConversationCommands,
} from './slashCommandMenu'

const command = (
  name: string,
  source: ConversationCommand['source'] = 'cli',
  extra: Partial<ConversationCommand> = {},
): ConversationCommand => ({ name, source, ...extra })
const names = (rows: ConversationCommand[]) => rows.map((row) => row.name)

test('an exact name ranks first, then a prefix, then a match inside the name, then the description', () => {
  const commands = [
    command('code-review', 'cli', { description: 'Review the diff' }),
    command('pr-comments', 'cli', { description: 'Fetch review comments' }),
    command('reviewer', 'custom'),
    command('review', 'cli'),
    command('preview', 'cli'),
    command('refresh-view', 'skill'),
  ]
  expect(names(rankConversationCommands(commands, 'review'))).toEqual([
    'review',
    'reviewer',
    'code-review',
    'preview',
    'refresh-view',
    'pr-comments',
  ])
})

test("a project's namespaced command is found by its own name and inserted with its namespace", () => {
  const commands = [
    command('release', 'custom', { description: 'Deploy notes for the release' }),
    command('project:frontend:deploy-preview', 'custom'),
    command('project:deploy', 'custom', { description: '(project) Ship it' }),
  ]
  const rows = rankConversationCommands(commands, '/deploy')
  expect(names(rows)).toEqual(['project:deploy', 'project:frontend:deploy-preview', 'release'])
  expect(commandInsertText(rows[0]!)).toBe('/project:deploy ')
})

test('the query ignores case, surrounding space and a leading slash', () => {
  const commands = [command('compact'), command('context')]
  expect(names(rankConversationCommands(commands, '  /COMP '))).toEqual(['compact'])
})

test('an alias finds its command at the rank its own name would have', () => {
  const commands = [command('usage', 'cli', { aliases: ['cost', 'stats'] }), command('costly-thing', 'custom')]
  expect(names(rankConversationCommands(commands, 'cost'))).toEqual(['usage', 'costly-thing'])
  expect(names(rankConversationCommands(commands, 'stat'))).toEqual(['usage'])
})

test('equal matches go Studio, then CLI, then custom, then skills, then by name', () => {
  const commands = [
    command('deploy', 'skill'),
    command('docs', 'custom'),
    command('diff', 'cli'),
    command('doctor', 'cli'),
    command('dash', 'app'),
  ]
  expect(names(rankConversationCommands(commands, ''))).toEqual(['dash', 'diff', 'doctor', 'docs', 'deploy'])
  expect(names(rankConversationCommands(commands, 'd'))).toEqual(['dash', 'diff', 'doctor', 'docs', 'deploy'])
})

test('a query nothing matches leaves no rows', () => {
  expect(rankConversationCommands([command('compact', 'cli', { description: 'Summarize' })], 'zzz')).toEqual([])
})

test('a pick inserts the command with a trailing space, or the text the command asks for', () => {
  expect(commandInsertText(command('review'))).toBe('/review ')
  expect(commandInsertText(command('backlog', 'skill', { insertText: '$backlog ' }))).toBe('$backlog ')
})

test('later in the message a skill goes in as a phrase, and a row with its own text keeps it', () => {
  expect(commandInsertText(command('design-review', 'skill'), false)).toBe('the design-review skill ')
  expect(commandInsertText(command('design-review', 'skill'), true)).toBe('/design-review ')
  expect(commandInsertText(command('backlog', 'skill', { insertText: '$backlog ' }), false)).toBe('$backlog ')
})

test('later in the message only the rows that do something there are offered', () => {
  expect(commandWorksMidMessage(command('model', 'app'))).toBe(true)
  expect(commandWorksMidMessage(command('deploy', 'skill'))).toBe(true)
  expect(commandWorksMidMessage(command('backlog', 'skill', { insertText: '$backlog ' }))).toBe(true)
  expect(commandWorksMidMessage(command('compact', 'cli'))).toBe(false)
  expect(commandWorksMidMessage(command('release-notes', 'custom'))).toBe(false)
})

test('each source has its own quiet label, and the CLI is named', () => {
  expect(
    (['app', 'cli', 'custom', 'skill'] as const).map((source) => commandSourceLabel(source, 'Claude Code')),
  ).toEqual(['Studio', 'Claude Code', 'Custom', 'Skill'])
})

async function renderMenu(
  props: Partial<Parameters<typeof import('./slashCommandMenu').SlashCommandMenu>[0]> & {
    rows: ConversationCommand[]
  },
) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { SlashCommandMenu } = await import('./slashCommandMenu')
  const onPick = vi.fn()
  const root = createRoot(dom.window.document.createElement('div'))
  await act(async () =>
    root.render(
      createElement(SlashCommandMenu, {
        listId: 'commands',
        optionId: (index: number) => `commands-${index}`,
        activeIndex: 0,
        query: '',
        status: { cliLabel: 'Claude Code', loading: false, answered: true, reportedCount: props.rows.length },
        skillsHint: false,
        onActiveIndexChange: () => undefined,
        onPick,
        onDismiss: () => undefined,
        ...props,
      }),
    ),
  )
  const body = dom.window.document.body
  return {
    body,
    act,
    onPick,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const name of Object.keys(globals)) {
        if (previous[name]) Object.defineProperty(globalThis, name, previous[name])
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

test('a row shows the name, its argument hint, its description and where it comes from', async () => {
  const menu = await renderMenu({
    rows: [
      command('review', 'custom', { argumentHint: '[pr-number]', description: 'Review a pull request' }),
      command('compact', 'cli'),
    ],
  })
  try {
    const rows = Array.from(menu.body.querySelectorAll('[role="option"]'))
    expect(rows.map((row) => row.id)).toEqual(['commands-0', 'commands-1'])
    expect(rows[0].textContent).toBe('/review[pr-number]Review a pull requestCustom')
    expect(rows[1].textContent).toBe('/compactClaude Code')
    expect(rows[0].getAttribute('aria-selected')).toBe('true')
    expect(menu.body.querySelector('[role="listbox"]')?.id).toBe('commands')
    await menu.act(async () => (rows[1] as HTMLElement).click())
    expect(menu.onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'compact' }))
  } finally {
    await menu.unmount()
  }
})

test('while the CLI is asked, the menu says it is loading beside what it already has', async () => {
  const menu = await renderMenu({
    rows: [command('model', 'app')],
    status: { cliLabel: 'Claude Code', loading: true, answered: false, reportedCount: 0 },
  })
  try {
    expect(menu.body.querySelector('[role="status"]')?.textContent).toBe('Loading commands…')
    expect(menu.body.querySelectorAll('[role="option"]')).toHaveLength(1)
  } finally {
    await menu.unmount()
  }
})

test('a CLI that answered with nothing says so, naming the CLI', async () => {
  const menu = await renderMenu({
    rows: [command('model', 'app')],
    status: { cliLabel: 'Codex', loading: false, answered: true, reportedCount: 0 },
  })
  try {
    expect(menu.body.querySelector('[role="status"]')?.textContent).toBe('Codex reported no commands')
  } finally {
    await menu.unmount()
  }
})

test('a failed listing shows the error', async () => {
  const menu = await renderMenu({
    rows: [command('compact')],
    status: { cliLabel: 'Cursor', loading: false, answered: true, reportedCount: 1, error: 'cursor-agent exited' },
  })
  try {
    expect(menu.body.querySelector('[role="status"]')?.textContent).toBe(
      'Couldn’t list Cursor commands: cursor-agent exited',
    )
  } finally {
    await menu.unmount()
  }
})

test('the footer points at $ for Studio skills where the chat takes them', async () => {
  const withSkills = await renderMenu({ rows: [command('compact')], skillsHint: true })
  try {
    expect(withSkills.body.textContent).toContain('$ for Studio skills')
  } finally {
    await withSkills.unmount()
  }
  const without = await renderMenu({ rows: [command('compact')] })
  try {
    expect(without.body.textContent).not.toContain('$ for Studio skills')
  } finally {
    await without.unmount()
  }
})

test('the listbox holds the rows alone; the status line and key hints sit outside it', async () => {
  const menu = await renderMenu({
    rows: [command('model', 'app')],
    status: { cliLabel: 'Claude Code', loading: true, answered: false, reportedCount: 0 },
    skillsHint: true,
  })
  try {
    const listbox = menu.body.querySelector('[role="listbox"]')!
    expect(listbox.id).toBe('commands')
    expect(Array.from(listbox.children).every((child) => child.getAttribute('role') === 'option')).toBe(true)
    expect(listbox.querySelector('[role="status"]')).toBeNull()
    expect(listbox.textContent).not.toContain('esc dismiss')
  } finally {
    await menu.unmount()
  }
})

test('a row shows what choosing it inserts: a Codex skill as its $ mention', async () => {
  const menu = await renderMenu({
    rows: [command('release-notes', 'skill', { insertText: '$release-notes ' }), command('compact', 'cli')],
  })
  try {
    const rows = Array.from(menu.body.querySelectorAll('[role="option"]'))
    expect(rows[0].textContent).toMatch(/^\$release-notes/)
    expect(rows[1].textContent).toMatch(/^\/compact/)
  } finally {
    await menu.unmount()
  }
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  applyClaudeTaskTool,
  claudeTaskTodos,
  isClaudeTaskTool,
  readStoredClaudeTasks,
  type ClaudeTaskList,
} from './claude-task-list'

const twoTasks: ClaudeTaskList = new Map([
  ['1', { subject: 'Read the brief', status: 'completed' as const }],
  ['2', { subject: 'Draft the answer', status: 'pending' as const, activeForm: 'Drafting the answer' }],
])

test('the task tools are the four that keep the list, not TaskStop or the agent tool', () => {
  expect(['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'].every(isClaudeTaskTool)).toBe(true)
  expect(isClaudeTaskTool('TaskStop')).toBe(false)
  expect(isClaudeTaskTool('Task')).toBe(false)
  expect(isClaudeTaskTool('TodoWrite')).toBe(false)
})

test('a create adds a pending task under the id its result names', () => {
  const next = applyClaudeTaskTool(
    twoTasks,
    'TaskCreate',
    { subject: 'Check the answer', description: 'Read it again', activeForm: 'Checking the answer' },
    { task: { id: '3', subject: 'Check the answer' } },
  )
  expect(claudeTaskTodos(next).at(-1)).toEqual({
    content: 'Check the answer',
    status: 'pending',
    activeForm: 'Checking the answer',
  })
  expect(next.size).toBe(3)
})

test('a create whose result names no id changes nothing', () => {
  expect(applyClaudeTaskTool(twoTasks, 'TaskCreate', { subject: 'Check the answer' }, undefined)).toBe(twoTasks)
})

test('an update changes the status and subject of the task it names, keeping its place', () => {
  const next = applyClaudeTaskTool(
    twoTasks,
    'TaskUpdate',
    { taskId: '2', status: 'in_progress', subject: 'Draft the reply' },
    { success: true, taskId: '2', updatedFields: ['status', 'subject'] },
  )
  expect(claudeTaskTodos(next)).toEqual([
    { content: 'Read the brief', status: 'completed' },
    { content: 'Draft the reply', status: 'in_progress', activeForm: 'Drafting the answer' },
  ])
})

test('an update to deleted takes the task off the list', () => {
  const next = applyClaudeTaskTool(twoTasks, 'TaskUpdate', { taskId: '1', status: 'deleted' }, { success: true })
  expect(claudeTaskTodos(next).map((todo) => todo.content)).toEqual(['Draft the answer'])
})

test('an update the CLI refused, or one naming a task not on the list, changes nothing', () => {
  expect(
    applyClaudeTaskTool(twoTasks, 'TaskUpdate', { taskId: '2', status: 'completed' }, { success: false, taskId: '2' }),
  ).toBe(twoTasks)
  expect(applyClaudeTaskTool(twoTasks, 'TaskUpdate', { taskId: '9', status: 'completed' }, { success: true })).toBe(
    twoTasks,
  )
})

test('an update that leaves the task as it was returns the same list', () => {
  expect(applyClaudeTaskTool(twoTasks, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true })).toBe(
    twoTasks,
  )
})

test('a listing replaces the list, keeping the wording a task was made with', () => {
  const next = applyClaudeTaskTool(
    twoTasks,
    'TaskList',
    {},
    {
      tasks: [
        { id: '2', subject: 'Draft the answer', status: 'in_progress', blockedBy: [] },
        { id: '4', subject: 'Ship it', status: 'pending', blockedBy: [] },
      ],
    },
  )
  expect(claudeTaskTodos(next)).toEqual([
    { content: 'Draft the answer', status: 'in_progress', activeForm: 'Drafting the answer' },
    { content: 'Ship it', status: 'pending' },
  ])
})

test('a listing that says what the list already holds returns the same list', () => {
  const listed = {
    tasks: [
      { id: '1', subject: 'Read the brief', status: 'completed', blockedBy: [] },
      { id: '2', subject: 'Draft the answer', status: 'pending', blockedBy: [] },
    ],
  }
  expect(applyClaudeTaskTool(twoTasks, 'TaskList', {}, listed)).toBe(twoTasks)
  expect(applyClaudeTaskTool(twoTasks, 'TaskList', {}, 'no tasks')).toBe(twoTasks)
})

test('a get records the one task it read as it stands', () => {
  const next = applyClaudeTaskTool(
    new Map(),
    'TaskGet',
    { taskId: '7' },
    {
      task: { id: '7', subject: 'Run the suite', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    },
  )
  expect(claudeTaskTodos(next)).toEqual([{ content: 'Run the suite', status: 'in_progress' }])
  expect(applyClaudeTaskTool(twoTasks, 'TaskGet', { taskId: '7' }, { task: null })).toBe(twoTasks)
})

// A task as Claude Code writes it to `<config dir>/tasks/<list id>/<id>.json`.
const storedTask = (id: string, subject: string, status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, subject, description: '', status, blocks: [], blockedBy: [], ...extra })

async function storedList(files: Record<string, string>, listId = 'sess_1'): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'claude-stored-tasks-'))
  await mkdir(join(configDir, 'tasks', listId), { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(configDir, 'tasks', listId, name), text)
  return configDir
}

test('the list Claude Code left on disk is read in id order, with the wording each task was made with', async () => {
  const configDir = await storedList({
    '10.json': storedTask('10', 'Ship it', 'pending'),
    '2.json': storedTask('2', 'Draft the answer', 'in_progress', { activeForm: 'Drafting the answer' }),
    '1.json': storedTask('1', 'Read the brief', 'completed'),
    '.lock': '',
  })
  try {
    expect(Array.from((await readStoredClaudeTasks(configDir, 'sess_1')) ?? [])).toEqual([
      ['1', { subject: 'Read the brief', status: 'completed' }],
      ['2', { subject: 'Draft the answer', status: 'in_progress', activeForm: 'Drafting the answer' }],
      ['10', { subject: 'Ship it', status: 'pending' }],
    ])
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a stored file that is not a task, or one Claude Code keeps for itself, is left out', async () => {
  const configDir = await storedList({
    '1.json': storedTask('1', 'Read the brief', 'pending'),
    '2.json': '{ not json',
    '3.json': storedTask('4', 'Named for another task', 'pending'),
    '5.json': storedTask('5', 'Kept by the CLI', 'pending', { metadata: { _internal: true } }),
    '6.json': storedTask('6', 'An unknown status', 'blocked'),
    'notes.json': storedTask('notes', 'Not a task id', 'pending'),
  })
  try {
    expect(Array.from((await readStoredClaudeTasks(configDir, 'sess_1'))?.keys() ?? [])).toEqual(['1'])
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a list id is made safe for its folder name as Claude Code makes it', async () => {
  const configDir = await storedList({ '1.json': storedTask('1', 'Read the brief', 'pending') }, 'team-acme-app')
  try {
    expect((await readStoredClaudeTasks(configDir, 'team/acme.app'))?.size).toBe(1)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a list with no folder on disk reads as none', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'claude-stored-tasks-'))
  try {
    expect(await readStoredClaudeTasks(configDir, 'sess_1')).toBeNull()
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

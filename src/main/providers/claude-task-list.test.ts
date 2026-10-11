import { expect, test } from 'vitest'

import { applyClaudeTaskTool, claudeTaskTodos, isClaudeTaskTool, type ClaudeTaskList } from './claude-task-list'

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

import { expect, test } from 'vitest'
import { deriveTodoProgress, readTodoSteps } from '../src/todoProgress.js'
import type { TranscriptEntry } from '../src/conversationProjection.js'

type Assistant = Extract<TranscriptEntry, { kind: 'assistant' }>

const user = (id: string): TranscriptEntry => ({ kind: 'user', id, text: 'go' })
const assistant = (turnId: string, status: Assistant['status'] = 'streaming'): TranscriptEntry => ({
  kind: 'assistant',
  turnId,
  text: '',
  reasoning: '',
  status,
})
const todoWrite = (id: string, turnId: string, todos: { content: string; status: string; activeForm?: string }[]) =>
  ({
    kind: 'tool',
    id,
    turnId,
    name: 'TodoWrite',
    toolKind: 'todo',
    status: 'done',
    input: { todos },
  }) satisfies TranscriptEntry
const read = (id: string, turnId: string): Extract<TranscriptEntry, { kind: 'tool' }> => ({
  kind: 'tool',
  id,
  turnId,
  name: 'Read',
  toolKind: 'file_read',
  status: 'done',
})

test('the latest todo write of the running turn is the list, worded as the agent works', () => {
  const entries: TranscriptEntry[] = [
    user('u1'),
    assistant('t1'),
    todoWrite('a', 't1', [
      { content: 'Read the config', status: 'in_progress' },
      { content: 'Write the test', status: 'pending' },
    ]),
    read('r', 't1'),
    todoWrite('b', 't1', [
      { content: 'Read the config', status: 'completed' },
      { content: 'Write the test', status: 'in_progress', activeForm: 'Writing the test' },
      { content: 'Run the suite', status: 'pending' },
    ]),
  ]
  expect(deriveTodoProgress(entries, true)).toEqual({
    steps: [
      { label: 'Read the config', status: 'completed' },
      { label: 'Write the test', status: 'in_progress' },
      { label: 'Run the suite', status: 'pending' },
    ],
    completed: 1,
    total: 3,
    current: 'Writing the test',
    live: true,
  })
})

test('with nothing in progress the next step due is current', () => {
  const entries: TranscriptEntry[] = [
    user('u1'),
    assistant('t1'),
    todoWrite('a', 't1', [
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'pending' },
    ]),
  ]
  expect(deriveTodoProgress(entries, true)?.current).toBe('Two')
})

test('a finished list hides once its turn ends; an unfinished one stays', () => {
  const done = [
    user('u1'),
    assistant('t1', 'complete'),
    todoWrite('a', 't1', [
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'completed' },
    ]),
  ]
  expect(deriveTodoProgress(done, false)).toBeNull()
  // Still running, the last tick is shown rather than the strip vanishing mid-turn.
  expect(deriveTodoProgress([...done.slice(0, 1), assistant('t1'), done[2]], true)?.completed).toBe(2)
  const stalled = [
    user('u1'),
    assistant('t1', 'interrupted'),
    todoWrite('a', 't1', [
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'in_progress' },
    ]),
  ]
  expect(deriveTodoProgress(stalled, false)).toMatchObject({ completed: 1, total: 2, live: false })
})

test('a list belongs to the turn that wrote it', () => {
  const earlier = [
    user('u1'),
    assistant('t1', 'interrupted'),
    todoWrite('a', 't1', [{ content: 'One', status: 'pending' }]),
  ]
  // A new message starts a turn that has not written a list yet.
  expect(deriveTodoProgress([...earlier, user('u2')], true)).toBeNull()
  expect(deriveTodoProgress([...earlier, user('u2'), assistant('t2'), read('r', 't2')], true)).toBeNull()
  expect(deriveTodoProgress([user('u1'), assistant('t1'), read('r', 't1')], true)).toBeNull()
})

test('a plan reported as free text, or items without words, has no steps to count', () => {
  expect(readTodoSteps({ plan: '1. Read\n2. Write' })).toEqual([])
  expect(readTodoSteps({ todos: [{ status: 'pending' }, 'loose', null] })).toEqual([])
  expect(readTodoSteps({ todos: [{ description: 'Ship it', status: 'In Progress' }] })).toEqual([
    { label: 'Ship it', status: 'in_progress' },
  ])
  expect(
    deriveTodoProgress(
      [user('u1'), assistant('t1'), { ...read('p', 't1'), toolKind: 'todo', input: { plan: 'x' } }],
      true,
    ),
  ).toBeNull()
})

test("OpenCode's todowrite list, priorities and all, is read like any other, and a plan written after it replaces it", () => {
  const todos = [
    { content: 'Read the config', status: 'completed', priority: 'high' },
    { content: 'Write the test', status: 'in_progress', priority: 'high' },
    { content: 'Run the suite', status: 'pending', priority: 'medium' },
  ]
  // The call keeps the name the agent last gave it, which for a finished
  // todowrite is a count; its kind is what marks it a list.
  const opencode: TranscriptEntry = { ...todoWrite('c', 't1', todos), name: '2 todos' }
  expect(deriveTodoProgress([user('u1'), assistant('t1'), opencode], true)).toMatchObject({
    completed: 1,
    total: 3,
    current: 'Write the test',
  })
  const plan: TranscriptEntry = {
    ...todoWrite('plan_t1', 't1', [
      { content: 'Read the config', status: 'completed' },
      { content: 'Write the test', status: 'completed' },
      { content: 'Run the suite', status: 'pending' },
    ]),
    name: 'Plan',
  }
  expect(deriveTodoProgress([user('u1'), assistant('t1'), opencode, plan], true)).toMatchObject({
    completed: 2,
    total: 3,
  })
})

test('a cancelled step is not work left to do, so a list whose other steps are done finishes', () => {
  const todos = [
    { content: 'Write the fix', status: 'completed' },
    { content: 'Try another approach', status: 'cancelled' },
    { content: 'Add a test', status: 'completed' },
  ]
  expect(readTodoSteps({ todos })).toEqual([
    { label: 'Write the fix', status: 'completed' },
    { label: 'Add a test', status: 'completed' },
  ])
  expect(deriveTodoProgress([user('u1'), assistant('t1', 'complete'), todoWrite('a', 't1', todos)], false)).toBeNull()
  expect(deriveTodoProgress([user('u1'), assistant('t1'), todoWrite('a', 't1', todos)], true)).toMatchObject({
    completed: 2,
    total: 2,
    current: 'Add a test',
  })
  // Either spelling, and a list the agent cancelled outright has nothing to show.
  const dropped = [
    { content: 'One', status: 'Canceled' },
    { content: 'Two', status: 'cancelled' },
  ]
  expect(readTodoSteps({ todos: dropped })).toEqual([])
  expect(deriveTodoProgress([user('u1'), assistant('t1', 'complete'), todoWrite('a', 't1', dropped)], false)).toBeNull()
})

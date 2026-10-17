import { expect, test } from 'vitest'
import { codexCompactRequest, codexConversationCommands, codexGoalRequest } from './codex'

const cwd = '/Users/dev/app'
const listed = (skills: unknown[]) => ({ data: [{ cwd, skills, errors: [] }] })

test('Codex offers /compact and /goal, then each enabled skill as a $name mention', () => {
  expect(
    codexConversationCommands(
      listed([
        {
          name: 'release-notes',
          description: 'Write release notes from the merged changes, in the long form written for the model.',
          interface: { shortDescription: 'Write release notes' },
          scope: 'system',
          enabled: true,
        },
        { name: 'acme:changelog', description: 'Draft a changelog entry', scope: 'user', enabled: true },
        { name: 'retired', description: 'Switched off', scope: 'user', enabled: false },
      ]),
      cwd,
    ),
  ).toEqual([
    { name: 'compact', description: 'Summarise the conversation to free context', source: 'cli' },
    {
      name: 'goal',
      description: 'Set a goal Codex keeps working toward',
      argumentHint: '[objective | pause | resume | clear]',
      source: 'cli',
    },
    { name: 'release-notes', description: 'Write release notes', insertText: '$release-notes ', source: 'skill' },
    { name: 'acme:changelog', description: 'Draft a changelog entry', insertText: '$acme:changelog ', source: 'skill' },
  ])
})

test('Codex reads the skills listed for the folder it asked about', () => {
  const response = {
    data: [
      { cwd: '/Users/dev/other', skills: [{ name: 'elsewhere', description: '', enabled: true }] },
      { cwd, skills: [{ name: 'here', description: 'This folder', enabled: true }] },
    ],
  }
  expect(codexConversationCommands(response, cwd).map((command) => command.name)).toEqual(['compact', 'goal', 'here'])
  expect(codexConversationCommands({ error: 'no data' }, cwd).map((command) => command.name)).toEqual([
    'compact',
    'goal',
  ])
})

test('/compact on its own runs; with anything riding along it is refused; anything else is not /compact', () => {
  expect(codexCompactRequest('/compact')).toBe('run')
  expect(codexCompactRequest('/compact \n')).toBe('run')
  expect(codexCompactRequest('/compact keep the API notes')).toBe('refuse')
  // Instructions on a later line, or a mentioned file's context, would be dropped too.
  expect(codexCompactRequest('/compact\nfocus on the parser')).toBe('refuse')
  expect(codexCompactRequest('/compact\n\nMentioned file: src/app.ts')).toBe('refuse')
  expect(codexCompactRequest('/compact', 1)).toBe('refuse')
  expect(codexCompactRequest('/compaction plan')).toBeNull()
  expect(codexCompactRequest('please /compact')).toBeNull()
})

test('/goal on its own asks for the goal', () => {
  expect(codexGoalRequest('/goal')).toEqual({ action: 'show' })
  expect(codexGoalRequest('/goal  \n')).toEqual({ action: 'show' })
})

test('/goal pause, resume and clear are those, in any case', () => {
  expect(codexGoalRequest('/goal pause')).toEqual({ action: 'pause' })
  expect(codexGoalRequest('/goal Resume')).toEqual({ action: 'resume' })
  expect(codexGoalRequest('/goal clear ')).toEqual({ action: 'clear' })
})

test('anything else after /goal is the objective, every line of it', () => {
  expect(codexGoalRequest('/goal make the parser tests pass')).toEqual({
    action: 'set',
    objective: 'make the parser tests pass',
  })
  expect(codexGoalRequest('/goal clear the lint warnings\nin src/')).toEqual({
    action: 'set',
    objective: 'clear the lint warnings\nin src/',
  })
})

test('/goal with images is refused, and a message that is not /goal is not one', () => {
  expect(codexGoalRequest('/goal ship it', 1)).toMatchObject({ action: 'refuse' })
  expect(codexGoalRequest('/goals')).toBeNull()
  expect(codexGoalRequest('set a /goal')).toBeNull()
})

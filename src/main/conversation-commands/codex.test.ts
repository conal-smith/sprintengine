import { expect, test } from 'vitest'
import { codexCompactRequest, codexConversationCommands, codexListedSkills, codexSkillInputs } from './codex'

const cwd = '/Users/dev/app'
const listed = (skills: unknown[]) => ({ data: [{ cwd, skills, errors: [] }] })

test('Codex offers /compact, then each enabled skill as a $name mention', () => {
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
  expect(codexConversationCommands(response, cwd).map((command) => command.name)).toEqual(['compact', 'here'])
  expect(codexConversationCommands({ error: 'no data' }, cwd).map((command) => command.name)).toEqual(['compact'])
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

const SKILLS = codexListedSkills(
  listed([
    { name: 'deploy', description: 'Ship it', path: '/Users/dev/app/.codex/skills/deploy/SKILL.md', enabled: true },
    { name: 'deploy.prod', description: 'Ship to prod', path: '/Users/dev/.codex/skills/prod/SKILL.md', enabled: true },
    { name: 'acme:review', description: 'Review', path: '/Users/dev/.codex/skills/review/SKILL.md', enabled: true },
    { name: 'off', description: 'Switched off', path: '/Users/dev/.codex/skills/off/SKILL.md', enabled: false },
    { name: 'pathless', description: 'An older Codex that names no path' },
  ]),
  cwd,
)

test('a listed skill keeps the SKILL.md path Codex named it by', () => {
  expect(SKILLS).toEqual([
    { name: 'deploy', description: 'Ship it', path: '/Users/dev/app/.codex/skills/deploy/SKILL.md' },
    { name: 'deploy.prod', description: 'Ship to prod', path: '/Users/dev/.codex/skills/prod/SKILL.md' },
    { name: 'acme:review', description: 'Review', path: '/Users/dev/.codex/skills/review/SKILL.md' },
    { name: 'pathless', description: 'An older Codex that names no path', path: null },
  ])
})

test('a whole $name token in a message is the listed skill, by its path', () => {
  expect(codexSkillInputs('Use $deploy, then ($acme:review).', SKILLS)).toEqual([
    { type: 'skill', name: 'deploy', path: '/Users/dev/app/.codex/skills/deploy/SKILL.md' },
    { type: 'skill', name: 'acme:review', path: '/Users/dev/.codex/skills/review/SKILL.md' },
  ])
})

test('where two listed names fit, the longer one is the mention', () => {
  expect(codexSkillInputs('$deploy.prod now', SKILLS).map((input) => input.name)).toEqual(['deploy.prod'])
})

test('a skill mentioned twice goes once', () => {
  expect(codexSkillInputs('$deploy and $deploy again', SKILLS)).toHaveLength(1)
})

test('a $ inside a word, a longer name, an unknown name or a skill with no path stays text', () => {
  expect(codexSkillInputs('cost US$deploy', SKILLS)).toEqual([])
  expect(codexSkillInputs('$deploy-staging', SKILLS)).toEqual([])
  expect(codexSkillInputs('$$deploy', SKILLS)).toEqual([])
  expect(codexSkillInputs('echo $HOME and $off', SKILLS)).toEqual([])
  expect(codexSkillInputs('$pathless', SKILLS)).toEqual([])
  expect(codexSkillInputs('no mention at all', SKILLS)).toEqual([])
})

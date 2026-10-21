// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { WorkspaceSkill } from '../../../../shared/electron-api'
import { InlineSkillPicker, SkillPickerPopover } from './SkillPickerPopover'

type ListResult = { ok: true; skills: WorkspaceSkill[] }

let root: Root
let host: HTMLDivElement
let answer: (result: ListResult) => void = () => {}
const onPick = vi.fn()

function skill(id: string): WorkspaceSkill {
  return { id, name: id, source: 'custom', harnesses: [], installState: 'installed' } as WorkspaceSkill
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  Object.assign(window, {
    api: {
      // Held open, so the test decides when the skills arrive.
      workspaceSkillsList: () =>
        new Promise<ListResult>((resolve) => {
          answer = resolve
        }),
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')!
async function key(value: string) {
  await act(async () => {
    search().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })
}

test('ArrowDown while the skills are still loading leaves the first one to arrive highlighted for Enter', async () => {
  await act(async () =>
    root.render(<SkillPickerPopover open onOpenChange={() => {}} workspaceRoot="/Users/dev/project" onPick={onPick} />),
  )
  expect(document.body.textContent).toContain('Loading skills…')

  await key('ArrowDown')
  await act(async () => answer({ ok: true, skills: [skill('review'), skill('deploy')] }))
  expect(document.querySelectorAll('[data-skill-row]')).toHaveLength(2)

  await key('Enter')
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'review' }))
})

/** A machine with one skill installed for every project and one source holding two more. */
function machineWithSources() {
  const workspaceSkillsList = vi.fn(async () => ({ ok: true, skills: [skill('teach')] }))
  const skillsInstall = vi.fn(async () => ({
    ok: true,
    dirName: 'grill-me',
    harnesses: ['claude'],
    paths: [],
    fileCount: 1,
    scope: 'global',
  }))
  Object.assign(window, {
    api: {
      workspaceSkillsList,
      skillsInstall,
      skillsListSources: async () => ({
        ok: true,
        sources: [{ id: 'github:mattpocock/skills', kind: 'github', scannedAt: '2026-10-17T00:00:00.000Z' }],
      }),
      skillsGetScan: async () => ({
        ok: true,
        scan: {
          skills: [
            // Already installed: offered once, as installed, never again as available.
            { id: 'skills/teach', name: 'teach', description: 'Teach a concept', files: [] },
            { id: 'skills/grill-me', name: 'grill-me', description: 'Interview me about a plan', files: [] },
          ],
        },
      }),
    },
  })
  return { workspaceSkillsList, skillsInstall }
}

test('with no folder, the picker lists global skills and every source skill, and a pick installs for every project', async () => {
  const { workspaceSkillsList, skillsInstall } = machineWithSources()
  await act(async () =>
    root.render(<SkillPickerPopover open onOpenChange={() => {}} workspaceRoot={null} onPick={onPick} />),
  )
  expect(workspaceSkillsList).toHaveBeenCalledWith({ workspaceRoot: null, includeGlobal: true })
  const rows = [...document.querySelectorAll('[data-skill-row]')].map((row) => row.getAttribute('data-skill-row'))
  expect(rows).toEqual(['teach', 'grill-me'])
  expect(document.body.textContent).toContain('Installed')
  expect(document.body.textContent).toContain('Available to install')
  expect(document.body.textContent).not.toContain('Open a project folder')

  await act(async () => document.querySelector<HTMLButtonElement>('[data-skill-row="grill-me"]')!.click())
  expect(skillsInstall).toHaveBeenCalledWith({
    sourceId: 'github:mattpocock/skills',
    skillId: 'skills/grill-me',
    scope: 'global',
  })
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'grill-me', installState: 'installed' }))
  expect(onPick.mock.calls[0][0]).not.toHaveProperty('fromSource')
})

test('the type-ahead carries no key legend and no count', async () => {
  machineWithSources()
  const composer = document.createElement('div')
  composer.style.position = 'relative'
  host.append(composer)
  await act(async () => root.render(<InlineSkillPicker workspaceRoot={null} query="" onPick={onPick} />))
  expect(document.querySelectorAll('[data-skill-row]')).toHaveLength(2)
  expect(document.body.textContent).not.toMatch(/choose|esc dismiss|of \d+ skills/)
})

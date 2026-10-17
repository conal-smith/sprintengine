// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { WorkspaceSkill } from '../../../../shared/electron-api'
import { SkillPickerPopover } from './SkillPickerPopover'

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

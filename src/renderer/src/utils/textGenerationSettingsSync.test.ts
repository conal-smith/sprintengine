/**
 * The renderer half of the model-written titles mirror. Main titles a chat
 * with no window to ask, so the push has to reach it while a window is up: on
 * mount, and on every change to the switch or the engine.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { TextGenerationSettings } from '../../../shared/text-generation/contract'
import { useWorkspaceStore } from '../store/workspaceStore'
import { initTextGenerationSettingsSync } from './textGenerationSettingsSync'

const MATCH_REPOSITORY = { mode: 'repository', instructions: '' }
const pushes: TextGenerationSettings[] = []
;(globalThis as { window?: unknown }).window = {
  api: {
    setTextGenerationSettings: (settings: TextGenerationSettings): Promise<void> => {
      pushes.push(settings)
      return Promise.resolve()
    },
  },
}

test('the mount push goes even at the default, and every change after it reaches main', () => {
  const dispose = initTextGenerationSettingsSync()
  try {
    assert.deepEqual(
      pushes,
      [{ enabled: true, engine: null, writingStyle: MATCH_REPOSITORY }],
      'the default is pushed, not skipped',
    )

    useWorkspaceStore.getState().setTextGenerationEnabled(false)
    assert.deepEqual(
      pushes.at(-1),
      { enabled: false, engine: null, writingStyle: MATCH_REPOSITORY },
      'turning it off reaches main',
    )

    useWorkspaceStore.getState().setTextGenerationEngine({ cli: 'codex', model: 'gpt-5.6-luna' })
    assert.deepEqual(pushes.at(-1), {
      enabled: false,
      engine: { cli: 'codex', model: 'gpt-5.6-luna' },
      writingStyle: MATCH_REPOSITORY,
    })

    // The store notifies on every change; only a change to this setting pushes.
    const before = pushes.length
    useWorkspaceStore.getState().setTextGenerationEnabled(false)
    useWorkspaceStore.getState().setSidebarCollapsed(true)
    assert.equal(pushes.length, before, 'an unchanged value is not pushed again')
  } finally {
    dispose()
  }
})

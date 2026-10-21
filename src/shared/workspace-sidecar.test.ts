import assert from 'node:assert/strict'
import { SIDECAR_DIR_NAME } from './workspace-sidecar'
import { test } from 'vitest'

test('the folder older builds kept per-project state in is still recognised by name', () => {
  assert.equal(SIDECAR_DIR_NAME, '.sprintengine')
})

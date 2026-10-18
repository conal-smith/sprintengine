import assert from 'node:assert/strict'

import {
  NAVIGATION_KEY_EXCLUSIONS,
  navigateFile,
  nextDiffPosition,
  resolveEdgeHunkIndex,
  takesNavigationKey,
} from './diffNavigation'
import { test } from 'vitest'

test('diffNavigation', async () => {
  testAdvancesWithinFile()
  testCrossesForwardFileBoundary()
  testCrossesBackwardFileBoundary()
  testStopsAtVeryEnd()
  testStopsAtVeryStart()
  testZeroHunkFileSkipsForward()
  testResolvesEdges()
  testFileStepperWalksWholeFiles()
  testFileStepperDoesNotWrap()
  testFileStepperReachesAHunklessFile()
  testFileStepperOnAnEmptyOrUnfocusedList()
  testMonacoKeepsItsOwnArrowKeys()

  console.log('diffNavigation.test.ts: ok')

  function testAdvancesWithinFile(): void {
    assert.deepEqual(nextDiffPosition({ fileIndex: 0, hunkIndex: 0 }, 'next', 3, 2), {
      type: 'hunk',
      fileIndex: 0,
      hunkIndex: 1,
    })
    assert.deepEqual(nextDiffPosition({ fileIndex: 0, hunkIndex: 2 }, 'prev', 3, 2), {
      type: 'hunk',
      fileIndex: 0,
      hunkIndex: 1,
    })
  }

  function testCrossesForwardFileBoundary(): void {
    // Past the last hunk of file 0 → first hunk of file 1.
    assert.deepEqual(nextDiffPosition({ fileIndex: 0, hunkIndex: 2 }, 'next', 3, 2), {
      type: 'file',
      fileIndex: 1,
      edge: 'first',
    })
  }

  function testCrossesBackwardFileBoundary(): void {
    // Before the first hunk of file 1 → last hunk of file 0.
    assert.deepEqual(nextDiffPosition({ fileIndex: 1, hunkIndex: 0 }, 'prev', 4, 2), {
      type: 'file',
      fileIndex: 0,
      edge: 'last',
    })
  }

  function testStopsAtVeryEnd(): void {
    assert.deepEqual(nextDiffPosition({ fileIndex: 1, hunkIndex: 2 }, 'next', 3, 2), { type: 'none' })
  }

  function testStopsAtVeryStart(): void {
    assert.deepEqual(nextDiffPosition({ fileIndex: 0, hunkIndex: 0 }, 'prev', 3, 2), { type: 'none' })
  }

  function testZeroHunkFileSkipsForward(): void {
    // A binary / mode-only file has no hunks; next should move straight on.
    assert.deepEqual(nextDiffPosition({ fileIndex: 0, hunkIndex: 0 }, 'next', 0, 2), {
      type: 'file',
      fileIndex: 1,
      edge: 'first',
    })
  }

  function testResolvesEdges(): void {
    assert.equal(resolveEdgeHunkIndex('first', 5), 0)
    assert.equal(resolveEdgeHunkIndex('last', 5), 4)
    assert.equal(resolveEdgeHunkIndex('last', 0), 0)
  }

  // ── The file stepper (T4) ────────────────────────────────────────────────────

  function testFileStepperWalksWholeFiles(): void {
    // One press, one file — regardless of how many hunks the current file has
    // left, which is the whole difference from the hunk walk above.
    assert.deepEqual(navigateFile(0, 'next', 27), { type: 'file', fileIndex: 1, edge: 'first' })
    assert.deepEqual(navigateFile(26, 'prev', 27), { type: 'file', fileIndex: 25, edge: 'first' })
    // Backwards lands on the TOP of the previous file, not its last hunk.
    // One call, held in a name: the union narrows on the value that was tested,
    // and a second call would be a fresh unnarrowed move.
    const back = navigateFile(5, 'prev', 27)
    assert.equal(back.type === 'file' && back.edge, 'first')
  }

  function testFileStepperDoesNotWrap(): void {
    assert.deepEqual(navigateFile(26, 'next', 27), { type: 'none' })
    assert.deepEqual(navigateFile(0, 'prev', 27), { type: 'none' })
    // A single-file list has nowhere to go in either direction.
    assert.deepEqual(navigateFile(0, 'next', 1), { type: 'none' })
    assert.deepEqual(navigateFile(0, 'prev', 1), { type: 'none' })
  }

  function testFileStepperReachesAHunklessFile(): void {
    // The move is the same `{type:'file'}` a hunk overflow produces, so the
    // caller resolves it through resolveEdgeHunkIndex — which clamps an empty
    // diff to 0 rather than stepping over the file.
    const move = navigateFile(0, 'next', 2)
    assert.equal(move.type, 'file')
    if (move.type !== 'file') return
    assert.equal(resolveEdgeHunkIndex(move.edge, 0), 0)
  }

  function testFileStepperOnAnEmptyOrUnfocusedList(): void {
    assert.deepEqual(navigateFile(0, 'next', 0), { type: 'none' })
    assert.deepEqual(navigateFile(-1, 'next', 3), { type: 'none' })
  }

  /**
   * The predicate the window-wide listener guards on. Monaco 0.55 focuses a
   * `<div class="native-edit-context" role="textbox">` inside `.monaco-editor` —
   * neither an input, nor a textarea, nor contenteditable — so before this the
   * viewer took an ArrowDown that Monaco was already handling and the caret and
   * the hunk cursor both moved on one press.
   */
  function testMonacoKeepsItsOwnArrowKeys(): void {
    // A fake `closest`: the element answers for the selectors it "matches".
    const target = (...matches: string[]) => ({
      closest: (selector: string) =>
        selector
          .split(',')
          .map((part) => part.trim())
          .some((part) => matches.includes(part))
          ? {}
          : null,
    })

    assert.equal(takesNavigationKey(target()), true, 'the surface itself')
    assert.equal(takesNavigationKey(null), true, 'and a key with no target at all')
    assert.equal(takesNavigationKey({}), true, 'or a target that cannot be asked')

    // Monaco, both ways it can be recognised.
    assert.equal(takesNavigationKey(target('[role="textbox"]')), false)
    assert.equal(takesNavigationKey(target('.monaco-editor')), false)

    // And the band's own controls, which is what the predicate was written for.
    assert.equal(takesNavigationKey(target('[role="radiogroup"]')), false)
    assert.equal(takesNavigationKey(target('[role="menu"]')), false)
    assert.equal(takesNavigationKey(target('input')), false)
    assert.equal(takesNavigationKey(target('textarea')), false)
    assert.equal(takesNavigationKey(target('[contenteditable="true"]')), false)
    // The file tree beside the diff walks its own rows.
    assert.equal(takesNavigationKey(target('[role="tree"]')), false)

    assert.match(NAVIGATION_KEY_EXCLUSIONS, /role="textbox"/)
    assert.match(NAVIGATION_KEY_EXCLUSIONS, /\.monaco-editor/)
  }
})

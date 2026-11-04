import { expect, test } from 'vitest'

import { BRANCH_MIN_CHARS, fitComposerStrip, frontTruncateBranch, type ComposerStripMeasure } from './composerStripFit'

test('a branch gives its front away by whole segments first, keeping the end', () => {
  expect(frontTruncateBranch('fix/cli-update-output', 40)).toBe('fix/cli-update-output')
  expect(frontTruncateBranch('fix/cli-update-output', 20)).toBe('…cli-update-output')
  expect(frontTruncateBranch('feat/a/b-c-d-e-f-g-h', 18)).toBe('…a/b-c-d-e-f-g-h')
  expect(frontTruncateBranch('feat/a/b-c-d-e-f-g-h', 15)).toBe('…b-c-d-e-f-g-h')
})

test('only a last segment too long for the room is cut mid-word, still keeping its end', () => {
  expect(frontTruncateBranch('fix/cli-update-output', 14)).toBe('…update-output')
  expect(frontTruncateBranch('very-long-branch-name-without-slashes', 12)).toBe('…out-slashes')
  // When a word starts near the cut and the floor allows it, the end opens on it.
  expect(frontTruncateBranch('dev/clone-repo-to-other-machine', 16)).toBe('…other-machine')
})

test('below the minimum the branch leaves rather than reading as a stub', () => {
  expect(BRANCH_MIN_CHARS).toBe(10)
  expect(frontTruncateBranch('fix/cli-update-output', BRANCH_MIN_CHARS)).toBe('…te-output')
  expect(frontTruncateBranch('fix/cli-update-output', BRANCH_MIN_CHARS - 1)).toBeNull()
  // A name shorter than the minimum keeps its whole self, or leaves.
  expect(frontTruncateBranch('main', 4)).toBe('main')
  expect(frontTruncateBranch('main', 3)).toBeNull()
})

// A strip whose parts are round numbers: one character of the branch is 7px,
// its padding 16px, every gap 8px.
const measure = (available: number, parts: Partial<ComposerStripMeasure> = {}): ComposerStripMeasure => ({
  available,
  gap: 8,
  ring: 24,
  overflow: 24,
  machine: 24,
  changes: 48,
  branch: { name: 'fix/cli-update-output', charWidth: 7, chrome: 16 },
  ...parts,
})

test('a strip with room draws every item, the branch whole', () => {
  // 24 + 8 + (16 + 21·7) + 8 + 48 + 8 + 24 = 283
  expect(fitComposerStrip(measure(283))).toEqual({
    branchText: 'fix/cli-update-output',
    changes: true,
    machine: true,
  })
})

test('as the strip narrows the branch truncates, then leaves, then the counts, then the machine; the ring stays', () => {
  // Room for 18 characters of branch: the leading segment goes.
  expect(fitComposerStrip(measure(262)).branchText).toBe('…cli-update-output')
  // Room for 10: the shortest cut the strip will draw.
  expect(fitComposerStrip(measure(206))).toEqual({ branchText: '…te-output', changes: true, machine: true })
  // Room for 9: the branch is in the menu, everything else stays.
  // machine 24 + changes 48 + ⋮ 24 + ring 24 + three gaps = 144.
  expect(fitComposerStrip(measure(199))).toEqual({ branchText: null, changes: true, machine: true })
  expect(fitComposerStrip(measure(144))).toEqual({ branchText: null, changes: true, machine: true })
  // Then the counts: machine + ⋮ + ring = 88.
  expect(fitComposerStrip(measure(143))).toEqual({ branchText: null, changes: false, machine: true })
  expect(fitComposerStrip(measure(88))).toEqual({ branchText: null, changes: false, machine: true })
  // Then the machine's glyph; the ring is never dropped, however narrow.
  expect(fitComposerStrip(measure(87))).toEqual({ branchText: null, changes: false, machine: false })
  expect(fitComposerStrip(measure(10))).toEqual({ branchText: null, changes: false, machine: false })
})

test('an absent part takes no room, and nothing in the menu means no menu', () => {
  // No branch and no counts: the machine and the ring fit without a "⋮".
  expect(fitComposerStrip(measure(56, { branch: null, changes: null }))).toEqual({
    branchText: null,
    changes: true,
    machine: true,
  })
  // Not laid out yet (jsdom, a detached strip): everything, whole.
  expect(fitComposerStrip(measure(0))).toEqual({ branchText: 'fix/cli-update-output', changes: true, machine: true })
})

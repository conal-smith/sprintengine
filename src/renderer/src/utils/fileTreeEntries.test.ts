import assert from 'node:assert/strict'
import { test } from 'vitest'

import { buildPathTreeRows, folderPathsSharedWithFiles, treeRowKey, type FileTreeEntry } from './fileTreeEntries'

// Found files as a tree: the Diff tab's changed files and the Files tab's
// search results. A diff can hold a file and a folder at one path — the file
// `docs` deleted, `docs/index.md` added — and both have to be rows.

const ROOT = '/Users/dev/app'

function file(relativePath: string): FileTreeEntry {
  const path = `${ROOT}/${relativePath}`
  const index = path.lastIndexOf('/')
  return { name: path.slice(index + 1), isDir: false, path, parentPath: path.slice(0, index) }
}

function shape(entries: FileTreeEntry[]): string[] {
  return buildPathTreeRows(ROOT, entries).map(
    (row) => `${'  '.repeat(row.depth)}${row.entry.name}${row.entry.isDir ? '/' : ''}`,
  )
}

const BOTH_EXPECTED = ['docs/', '  index.md', 'docs', 'readme.md']

test('a file listed before a folder at its path keeps its row, and the folder still shows its files', () => {
  assert.deepEqual(shape([file('docs'), file('docs/index.md'), file('readme.md')]), BOTH_EXPECTED)
})

test('a folder listed before a file at its path keeps its files, and the file still has its row', () => {
  assert.deepEqual(shape([file('docs/index.md'), file('docs'), file('readme.md')]), BOTH_EXPECTED)
})

test('found files with no shared path are laid out as before', () => {
  assert.deepEqual(shape([file('src/b.ts'), file('package.json'), file('src/a.ts'), file('docs/old.md')]), [
    'docs/',
    '  old.md',
    'src/',
    '  a.ts',
    '  b.ts',
    'package.json',
  ])
})

test('a folder that shares its path with a file is keyed apart from it; every other row is keyed by its path', () => {
  const rows = buildPathTreeRows(ROOT, [file('docs'), file('docs/index.md'), file('src/a.ts')])
  const shared = folderPathsSharedWithFiles(rows)
  assert.deepEqual([...shared], [`${ROOT}/docs`])
  assert.deepEqual(
    rows.map((row) => treeRowKey(row.entry, shared)),
    [`${ROOT}/docs/`, `${ROOT}/docs/index.md`, `${ROOT}/src`, `${ROOT}/src/a.ts`, `${ROOT}/docs`],
  )
  const keys = rows.map((row) => treeRowKey(row.entry, shared))
  assert.equal(new Set(keys).size, keys.length, 'no two rows share a key')

  const plain = buildPathTreeRows(ROOT, [file('src/a.ts'), file('readme.md')])
  assert.equal(folderPathsSharedWithFiles(plain).size, 0)
  assert.deepEqual(
    plain.map((row) => treeRowKey(row.entry, folderPathsSharedWithFiles(plain))),
    plain.map((row) => row.entry.path),
  )
})

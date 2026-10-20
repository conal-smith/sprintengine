#!/usr/bin/env node
// NUL-byte gate: no tracked text source file may contain a literal NUL.
//
// Git decides a file is binary by looking for a NUL byte near its start. A
// source file that carries one — typically a `'\0'` key separator whose escape
// was turned into the real character by an editor or a code generator — stops
// producing diffs, merges without conflict markers, and is skipped by
// `git grep`. The runtime value is identical when written as the `\0` escape, so
// the literal byte is never needed.
//
// Scans every tracked file with a text source extension (plus any untracked,
// non-ignored ones, so a new file is caught before its first commit). The phone
// app under mobile/ is its own package with its own gates, so it is left out.
// Exit 1 with file:line findings on any violation, 0 otherwise.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

const TEXT_SOURCE = /\.(?:[cm]?[jt]sx?|json|css|scss|html|md|mdx|ya?ml|sh|ps1|toml|txt)$/i

const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.', ':(exclude)mobile/'],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  },
)
  .split('\0')
  .filter((path) => path && TEXT_SOURCE.test(path))

const violations = []
let scanned = 0

for (const path of new Set(listed)) {
  const full = join(root, path)
  // A tracked file deleted in the working tree is still listed by --cached.
  if (!existsSync(full)) continue
  scanned += 1
  const bytes = readFileSync(full)
  if (!bytes.includes(0)) continue
  let line = 1
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) line += 1
    else if (bytes[i] === 0) violations.push(`${path}:${line}: literal NUL byte (write it as the \\0 escape)`)
  }
}

if (violations.length > 0) {
  console.error('NUL-byte gate failed (git treats these files as binary):')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`lint-nul-bytes: ok (scanned ${scanned} text source files; 0 violations)`)

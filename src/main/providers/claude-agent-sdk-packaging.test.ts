import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'

// The Agent SDK's per-platform package is a whole Claude Code binary (over
// 200 MB). The app never runs it: every query names the Claude Code the
// person has, so the SDK only looks for its own when no path is given. The
// installer leaves it out, which holds only while every query passes one.

const ROOT = process.cwd()

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

test('the desktop package leaves the Agent SDK’s own Claude Code binary out', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { build: { files: string[] } }
  expect(manifest.build.files).toContain('!node_modules/@anthropic-ai/claude-agent-sdk-*/**')
})

test('every file that loads the Agent SDK at run time names the Claude Code executable', () => {
  const loaders = [...sourceFiles(join(ROOT, 'src/main')), ...sourceFiles(join(ROOT, 'src/server'))].filter((file) =>
    readFileSync(file, 'utf8').includes("import('@anthropic-ai/claude-agent-sdk')"),
  )
  expect(loaders.length).toBeGreaterThan(0)
  const unnamed = loaders
    .filter((file) => !readFileSync(file, 'utf8').includes('pathToClaudeCodeExecutable:'))
    .map((file) => relative(ROOT, file))
  expect(unnamed).toEqual([])
})

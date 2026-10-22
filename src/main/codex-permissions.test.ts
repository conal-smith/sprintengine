import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { CliPermissionPreset } from '../shared/electron-api'
import { renderAgentLaunchArgv } from './agent-launch-render'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { buildCodexLegacyNativeAgentLaunchPowerShellScript } from './terminal-launch'

beforeAll(() => {
  const registry = createPluginRegistry({ bundledRoot: join(process.cwd(), 'resources/plugins') })
  const report = registry.loadSync()
  assert.deepEqual(report.rejected, [])
  __setPluginRegistryForTest(registry, report)
})
afterAll(() => __resetPluginRegistryForTest())

const permissionArgs: Record<CliPermissionPreset, string[]> = {
  none: [],
  manual: ['--ask-for-approval', 'on-request', '--sandbox', 'read-only'],
  auto: ['--approve-for-me'],
  bypass: ['--dangerously-bypass-approvals-and-sandbox'],
}

test('a retired Codex spelling renders the preset that kept its promise', () => {
  for (const [retired, preset] of [
    ['default', 'manual'],
    ['auto_workspace', 'auto'],
  ] as const) {
    const rendered = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'session-example',
      resume: false,
      cliPermissionPreset: retired as unknown as CliPermissionPreset,
      initialPrompt: 'fix the parser',
    })
    assert.deepEqual(rendered.argv, ['codex', ...permissionArgs[preset], '--', 'fix the parser'], retired)
  }
})

function scriptArgs(script: string): string[] {
  const line = script.split('\r\n').find((entry) => entry.startsWith('$arguments = @('))!
  return [...line.matchAll(/FromBase64String\('([^']*)'\)/g)].map(([, value]) =>
    Buffer.from(value, 'base64').toString('utf8'),
  )
}

for (const preset of Object.keys(permissionArgs) as CliPermissionPreset[]) {
  test(`Codex ${preset} uses the same permissions on Windows, POSIX and resume`, () => {
    for (const resume of [false, true]) {
      const input = {
        cli: 'codex',
        sessionId: 'session-example',
        resume,
        cliPermissionPreset: preset,
        initialPrompt: 'fix the parser',
      }
      const rendered = renderAgentLaunchArgv(input)
      assert.deepEqual(rendered.argv, [
        'codex',
        ...permissionArgs[preset],
        ...(resume ? ['resume', 'session-example'] : ['--', 'fix the parser']),
      ])
      const windows = buildCodexLegacyNativeAgentLaunchPowerShellScript(
        input.sessionId,
        resume,
        'C:\\work dir',
        input.initialPrompt,
        { command: '' },
        preset,
      )
      assert.deepEqual(scriptArgs(windows), ['-C', 'C:\\work dir', ...rendered.argv.slice(1)])
      assert.equal(windows.includes('& $resolvedCommand.Source --% %SPRINTENGINE_LAUNCH_ARGS%'), true)
    }
  })
}

test('Windows YOLO preserves quoted prompts, host context and reasoning through the native command line', () => {
  const prompt = 'Explain "permissions"\nKeep C:\\work dir\\ intact; %PATH% is text.'
  const contextText = 'Use the "project" rules.\nPath: C:\\work dir\\'
  const script = buildCodexLegacyNativeAgentLaunchPowerShellScript(
    'session-example',
    false,
    'C:\\work dir',
    prompt,
    { command: 'C:\\agent bin\\codex.exe' },
    'bypass',
    'gpt-5.6-sol',
    'high',
    { contextText },
    'dark',
  )
  const args = scriptArgs(script)
  assert.equal(args.at(-1), prompt)
  assert.ok(args.includes('developer_instructions=' + JSON.stringify(contextText)))
  assert.ok(args.includes('model_reasoning_effort="high"'))
  assert.ok(args.includes('tui.theme="catppuccin-mocha"'))
  assert.ok(!args.includes('--sandbox'))
  assert.ok(!args.includes('--ask-for-approval'))
  const encodedLine = script.split('\r\n').find((line) => line.startsWith('$env:SPRINTENGINE_LAUNCH_ARGS = '))!
  const encoded = encodedLine.match(/FromBase64String\('([^']*)'\)/)![1]
  const commandLine = Buffer.from(encoded, 'base64').toString('utf8')
  assert.ok(commandLine.includes('model_reasoning_effort=\\"high\\"'))
  assert.ok(commandLine.includes('Explain \\"permissions\\"\n'))
  assert.ok(script.includes("$command = 'C:\\agent bin\\codex.exe'"))
})

test.skipIf(process.platform !== 'win32')(
  'Windows launches Codex through an npm shim without losing YOLO flags or quotes',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex launch '))
    try {
      const bin = join(directory, 'node_modules', '@openai', 'codex', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'codex.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
      const shim = join(directory, 'codex.cmd')
      writeFileSync(shim, '@echo off\r\nexit /b 99\r\n')
      const prompt = 'Say "hello"\nKeep 100% and %PATH% literal.'
      const script = buildCodexLegacyNativeAgentLaunchPowerShellScript(
        'session-example',
        false,
        directory,
        prompt,
        { command: shim },
        'bypass',
        undefined,
        'high',
        { contextText: 'Use "project" rules.' },
      )
      const scriptPath = join(directory, 'launch.ps1')
      writeFileSync(scriptPath, script)
      const result = execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { encoding: 'utf8' },
      )
      assert.deepEqual(JSON.parse(result.trim()), scriptArgs(script))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

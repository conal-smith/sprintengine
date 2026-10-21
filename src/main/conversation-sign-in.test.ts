import { expect, test, vi } from 'vitest'

import type { CliDetectResult } from '../shared/ipc/agent-runtime'
import { resolveConversationSignIn } from './conversation-sign-in'

const detected = (resolvedPath: string | null): CliDetectResult => ({
  cli: 'claude-code',
  binary: 'claude',
  installed: resolvedPath !== null,
  version: resolvedPath ? '2.1.283' : null,
  resolvedPath,
  hostId: 'local',
  error: null,
})

test('a Claude chat signs in with the executable the provider runs, not whatever claude the shell finds', async () => {
  const detect = vi.fn(async () => detected('/Users/me/.local/bin/claude'))
  const result = await resolveConversationSignIn(
    { providerId: 'claude-agent', cliRuntimes: { 'claude-code': { command: '/Users/me/.local/bin/claude' } } },
    { detect, platform: 'darwin', home: () => '/Users/me' },
  )
  expect(result).toEqual({
    ok: true,
    commandLine: '/Users/me/.local/bin/claude auth login',
    cwd: '/Users/me',
    platform: 'darwin',
  })
  // The override the chat runs with is the one probed.
  expect(detect).toHaveBeenCalledWith('claude-code', { command: '/Users/me/.local/bin/claude' })
})

test('a path with spaces stays one word in the shell', async () => {
  const result = await resolveConversationSignIn(
    { providerId: 'claude-agent' },
    { detect: async () => detected('/Applications/My Tools/claude'), platform: 'linux', home: () => '/home/me' },
  )
  expect(result.ok && result.commandLine).toBe("'/Applications/My Tools/claude' auth login")
})

test('on Windows the native claude.exe is run from PowerShell', async () => {
  const result = await resolveConversationSignIn(
    { providerId: 'claude-agent' },
    {
      detect: async () => detected("C:\\Users\\O'Neil\\.local\\bin\\claude.exe"),
      platform: 'win32',
      home: () => "C:\\Users\\O'Neil",
    },
  )
  expect(result).toMatchObject({
    ok: true,
    commandLine: "& 'C:\\Users\\O''Neil\\.local\\bin\\claude.exe' auth login",
    cwd: "C:\\Users\\O'Neil",
  })
})

test('a chat on a WSL machine signs in there, with the claude that distribution runs', async () => {
  const detect = vi.fn(async () => detected('/home/me/.local/bin/claude'))
  const wslHome = vi.fn(async () => '\\\\wsl.localhost\\Ubuntu\\home\\me')
  const runtime = { command: '', hostId: 'wsl:Ubuntu' as const }
  const result = await resolveConversationSignIn(
    { providerId: 'claude-agent', cliRuntimes: { 'claude-code': runtime } },
    { detect, wslHome, platform: 'win32', home: () => 'C:\\Users\\me' },
  )
  expect(result).toEqual({
    ok: true,
    commandLine: '/home/me/.local/bin/claude auth login',
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me',
    platform: 'linux',
    hostId: 'wsl:Ubuntu',
  })
  expect(detect).toHaveBeenCalledWith('claude-code', runtime)
  expect(wslHome).toHaveBeenCalledWith('wsl:Ubuntu')
})

test('a missing CLI says so rather than opening a terminal that fails', async () => {
  const result = await resolveConversationSignIn(
    { providerId: 'claude-agent' },
    { detect: async () => detected(null), platform: 'darwin', home: () => '/Users/me' },
  )
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('not installed') })
})

test('a provider that signs in with a stored key has no CLI sign-in', async () => {
  const detect = vi.fn(async () => detected('/usr/bin/claude'))
  const result = await resolveConversationSignIn({ providerId: 'openai-compatible' }, { detect })
  expect(result.ok).toBe(false)
  expect(detect).not.toHaveBeenCalled()
})

test('a Kimi Code chat signs in with kimi login, from the kimi the chat runs', async () => {
  const detect = vi.fn(async () => ({
    ...detected('/Users/me/.kimi-code/bin/kimi'),
    cli: 'kimi-code',
    binary: 'kimi',
  }))
  const result = await resolveConversationSignIn(
    { providerId: 'kimi-code-agent' },
    { detect, platform: 'darwin', home: () => '/Users/me' },
  )
  expect(result).toEqual({
    ok: true,
    commandLine: '/Users/me/.kimi-code/bin/kimi login',
    cwd: '/Users/me',
    platform: 'darwin',
  })
  expect(detect).toHaveBeenCalledWith('kimi-code', undefined)
})

test('a missing Kimi Code CLI is named as Kimi Code', async () => {
  const result = await resolveConversationSignIn(
    { providerId: 'kimi-code-agent' },
    { detect: async () => detected(null), platform: 'darwin', home: () => '/Users/me' },
  )
  expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/^Kimi Code CLI is not installed/) })
})

test('a CLI chat Studio cannot open a sign-in for has none to run', async () => {
  const detect = vi.fn(async () => detected('/usr/local/bin/grok'))
  expect((await resolveConversationSignIn({ providerId: 'grok-agent' }, { detect })).ok).toBe(false)
  expect(detect).not.toHaveBeenCalled()
})

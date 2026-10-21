import { expect, test } from 'vitest'

import { claudeManagedMcpConfigPath, hasClaudeManagedMcpConfig } from './claude-managed-mcp'

test("each platform looks where Claude Code reads an administrator's managed-mcp.json", () => {
  expect(claudeManagedMcpConfigPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-mcp.json')
  expect(claudeManagedMcpConfigPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-mcp.json')
  expect(claudeManagedMcpConfigPath('linux')).toBe('/etc/claude-code/managed-mcp.json')
})

test('the file is there or not, and a check that throws reads as not there', () => {
  const seen: string[] = []
  expect(
    hasClaudeManagedMcpConfig('linux', (path) => {
      seen.push(path)
      return true
    }),
  ).toBe(true)
  expect(seen).toEqual(['/etc/claude-code/managed-mcp.json'])
  expect(hasClaudeManagedMcpConfig('darwin', () => false)).toBe(false)
  expect(
    hasClaudeManagedMcpConfig('darwin', () => {
      throw new Error('EACCES')
    }),
  ).toBe(false)
})

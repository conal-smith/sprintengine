import { existsSync } from 'node:fs'

/**
 * Where an administrator installs Claude Code's `managed-mcp.json`: the paths
 * the CLI itself checks.
 */
export function claudeManagedMcpConfigPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-mcp.json'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-mcp.json'
  return '/etc/claude-code/managed-mcp.json'
}

/**
 * Whether this machine carries an administrator's `managed-mcp.json`. While it
 * exists Claude refuses `--strict-mcp-config` and exits before it answers, but
 * it already ignores the person's own and the project's MCP servers, so a
 * caller that passes the flag only to keep those out can leave it off. Read
 * afresh each call: an administrator's install lands without a restart.
 */
export function hasClaudeManagedMcpConfig(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  try {
    return exists(claudeManagedMcpConfigPath(platform))
  } catch {
    return false
  }
}

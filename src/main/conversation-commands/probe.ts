import type { ConversationCommand } from '../../shared/conversation/commands'
import type { ConversationCliRuntimeOverrides } from '../../shared/conversation-runtime'
import { CLAUDE_COMMANDS_CLI } from './claude'
import { publishConversationCommands } from './registry'

// The ACP CLIs whose `initialize` answer carries their command list. Asking
// any other would start its process only to hear nothing, again on every
// retry while the menu is open.
const HANDSHAKE_COMMAND_CLIS = new Set(['grok'])

/**
 * Lists a chat CLI's commands for a folder before any chat there has started,
 * and publishes them. Only the CLIs that can answer without opening a
 * conversation are asked: Claude Code (its control channel answers with no
 * turn sent), Codex (its app-server lists skills with no thread) and Grok
 * (its ACP handshake carries the list). Cursor, OpenCode and Kimi Code
 * list theirs only inside a session, which would leave an empty chat in their own
 * history, so they publish once a chat's session opens. Resolves null for a
 * CLI with no such way, or when asking failed (the failure is published).
 */
export async function probeConversationCommands(input: {
  cli: string
  cwd: string
  cliRuntimes?: ConversationCliRuntimeOverrides
}): Promise<ConversationCommand[] | null> {
  try {
    if (input.cli === CLAUDE_COMMANDS_CLI) {
      const { probeClaudeConversationCommands } = await import('./claude')
      const commands = await probeClaudeConversationCommands(input)
      publishConversationCommands({ cli: input.cli, cwd: input.cwd, commands })
      return commands
    }
    if (input.cli === 'codex') {
      const { probeCodexConversationCommands } = await import('../providers/codex-conversation-provider')
      return await probeCodexConversationCommands(input)
    }
    if (!HANDSHAKE_COMMAND_CLIS.has(input.cli)) return null
    const { ACP_PROFILES, probeAcpConversationCommands } = await import('../providers/acp-conversation-provider')
    const profile = ACP_PROFILES.find((entry) => entry.cli === input.cli)
    return profile ? await probeAcpConversationCommands(profile, input) : null
  } catch (error) {
    publishConversationCommands({
      cli: input.cli,
      cwd: input.cwd,
      commands: [],
      error: error instanceof Error ? error.message : 'The command list could not be read.',
    })
    return null
  }
}

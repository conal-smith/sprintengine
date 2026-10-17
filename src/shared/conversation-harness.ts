// Which agent CLI each agent-harness conversation provider rides.
//
// A chat agent is the same CLI a terminal agent runs, driven through its
// structured interface instead of its TUI. Main reads this to hide a provider
// whose CLI is not installed; the renderer reads it to offer the terminal
// agent's picker for a chat (the CLI rail, its models, its effort and its
// permission presets) and to map what that picker chose back onto the
// conversation provider. One table, so the two can never disagree about which
// CLIs have a chat runtime.
//
// Providers that are not a CLI (the API-key providers) are deliberately absent.

const CONVERSATION_PROVIDER_CLI: Readonly<Record<string, string>> = {
  'claude-agent': 'claude-code',
  'codex-agent': 'codex',
  'cursor-agent': 'cursor',
  'opencode-agent': 'opencode',
  'grok-agent': 'grok',
  'kimi-code-agent': 'kimi-code',
}

// The permission presets a CLI's chat cannot be held to, with the reason its
// row in the permission menu gives. The provider refuses them with the same
// sentence (acp-conversation-provider.ts), and the launcher and the chat box
// dim them rather than letting a chat start on something looser under the
// preset's name. A CLI missing here runs every preset.
const CONVERSATION_PERMISSION_PRESET_REFUSALS: Readonly<
  Record<string, Partial<Record<import('./cli-permission-preset').CliPermissionPreset, string>>>
> = {
  // Observed with Cursor's default allowlist: commands outside the allowlist
  // are sent for approval, file edits in the workspace are applied directly,
  // and no flag makes it ask about them.
  cursor: { manual: 'Cursor edits files without asking, so it cannot ask before every change.' },
  // Read off Kimi Code 0.42.0's permission policies: in its default mode a
  // Write or Edit whose every file is inside a git project goes through
  // without asking, and `kimi acp` takes no flag or variable that would make
  // it ask (only a rule in the person's own config.toml can).
  'kimi-code': {
    manual: 'Kimi Code edits files in a git project without asking, so it cannot ask before every change.',
  },
}

// The CLI's own permission modes a chat runs beside each preset's own, by the
// id the CLI's manifest keys the mode under, which is where its name, its line
// and its level come from. A chat sets each through its runtime's own channel
// (an SDK mode, an approval policy, a launch flag), so a mode is listed here
// only where its provider maps it; the launcher and the chat box offer a chat
// no other mode of the CLI's own.
const CONVERSATION_PERMISSION_MODES: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['acceptEdits', 'dontAsk'],
  codex: ['workspace'],
  grok: ['acceptEdits', 'dontAsk'],
}

/** The CLI's own modes its chat can run beside the presets' own. */
export function conversationPermissionModes(cli: string | null | undefined): readonly string[] {
  return (cli && CONVERSATION_PERMISSION_MODES[cli]) || []
}

/** The presets a CLI's chat cannot run, each with the reason; empty when it runs every one. */
export function conversationPermissionPresetRefusals(
  cli: string | null | undefined,
): Partial<Record<import('./cli-permission-preset').CliPermissionPreset, string>> {
  return (cli && CONVERSATION_PERMISSION_PRESET_REFUSALS[cli]) || {}
}

/** The CLI a conversation provider rides, or null for a provider that is not a CLI. */
export function cliForConversationProvider(providerId: string | null | undefined): string | null {
  return (providerId && CONVERSATION_PROVIDER_CLI[providerId]) || null
}

/** The conversation provider that drives a CLI as a chat, or null when the CLI has none. */
export function conversationProviderForCli(cli: string | null | undefined): string | null {
  if (!cli) return null
  for (const [providerId, providerCli] of Object.entries(CONVERSATION_PROVIDER_CLI)) {
    if (providerCli === cli) return providerId
  }
  return null
}

/**
 * Every CLI that has a chat runtime. Each one's chat can run on a WSL machine
 * as well as on this one: its child is started inside the distribution, with
 * the login and settings under the Linux home (owner ruling 2026-10-01).
 */
export function conversationClis(): string[] {
  return [...new Set(Object.values(CONVERSATION_PROVIDER_CLI))]
}

/**
 * The model id a chat asks its provider for when the picker is on the CLI's own
 * default row (no model chosen). Every harness provider treats it as "pass no
 * model", the same as a terminal launch without `--model`.
 */
export const CONVERSATION_DEFAULT_MODEL_ID = 'default'

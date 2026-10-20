// Which logo a coding CLI wears. Kept apart from the component so the node
// regression suite can load it without react-native-svg.

export type CliLogoKind =
  | "claude-code"
  | "codex"
  | "opencode"
  | "zai"
  | "grok"
  | "kimi"
  | "cursor"
  | "muse"
  | "terminal";

/**
 * The desktop's CLI-to-logo mapping, widened for the phone: a CLI can arrive
 * as a bare "claude" or a "claude-" variant, and those are still Claude Code.
 * Anything unknown wears the generic prompt tile, which the desktop's mapping
 * calls "terminal".
 */
export function resolveCliLogoKind(cli: string | null | undefined): CliLogoKind {
  if (!cli) return "terminal";
  if (cli === "claude-code" || cli.startsWith("claude")) return "claude-code";
  if (cli === "codex") return "codex";
  if (cli === "opencode") return "opencode";
  if (cli === "zai") return "zai";
  if (cli === "grok") return "grok";
  // Both Kimi runtimes share one mark so they read as one provider in pickers.
  if (cli === "kimi-code" || cli === "kimi-claude") return "kimi";
  if (cli === "cursor") return "cursor";
  if (cli === "muse") return "muse";
  return "terminal";
}

// An environment value that is a whole JSON document (OpenCode's
// OPENCODE_CONFIG_CONTENT) is said to by more than one party at once: the
// person may export their own, the host context adds `instructions`, a launch
// integration adds `mcp` and `plugin`, a permission preset adds `permission`.
// Each must join the others rather than replace them, so the one rule for
// combining two values lives here, stated in terms of JSON and of no CLI.

/**
 * `next` merged over `existing` when both are JSON objects, else `next`.
 *
 * One level deep: arrays concatenate and objects merge key by key, which is
 * what "add my entry to your list" needs and all this channel is for — the
 * app's MCP servers join a person's own `mcp` table rather than replacing it.
 * Anything that does not parse — the overwhelming majority of env values —
 * takes the plain replacement path, so this is invisible to every other
 * variable.
 */
export function mergeJsonEnvValue(existing: string | undefined, next: string): string {
  if (!existing) return next
  const left = parseJsonObject(existing)
  const right = parseJsonObject(next)
  if (!left || !right) return next
  const merged: Record<string, unknown> = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const previous = merged[key]
    if (Array.isArray(previous) && Array.isArray(value)) merged[key] = [...previous, ...value]
    else if (isPlainJsonObject(previous) && isPlainJsonObject(value)) merged[key] = { ...previous, ...value }
    else merged[key] = value
  }
  return JSON.stringify(merged)
}

/** `extra` laid over `base`, each JSON-document value merged with the one it meets (`mergeJsonEnvValue`). */
export function mergeJsonEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) next[key] = value
  for (const [key, value] of Object.entries(extra ?? {})) next[key] = mergeJsonEnvValue(next[key], value)
  return next
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

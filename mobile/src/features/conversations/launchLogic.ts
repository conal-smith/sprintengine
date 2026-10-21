// What New may offer when it starts a chat: the desktop's launchable CLIs and
// their models, and the permission presets. No react-native import, so
// `node --test` can pin every rule here.

import type { ConversationPermissionPreset } from "../../api/conversationWire";

export interface CliRuntimeModel {
  id: string;
  label: string;
}

export interface CliRuntime {
  id: string;
  displayName: string;
  supportsModelSelection: boolean;
  models: CliRuntimeModel[];
  /**
   * The presets a launch on this CLI can honour, where the desktop lists them
   * (`none` always; another only where the CLI names its setting). Absent
   * from a desktop built before the list, which means unknown.
   */
  permissionPresets?: PermissionPreset[];
  /**
   * The effort levels the CLI declares, cheapest first, as its picker lists
   * them. Absent for a CLI that declares none: it has no effort to set.
   */
  reasoningLevels?: CliReasoningLevel[];
  /** The level the CLI runs at when none is passed, where it names one. */
  defaultReasoningLevel?: string;
  /**
   * The desktop model picker's own rows for this CLI, from a desktop that
   * advertises `cli-runtime-catalog`. Absent from any other, and dropped when
   * it arrives in a shape this build does not know: the picker then reads
   * `models` as it did before the catalog.
   */
  catalog?: CliRuntimeCatalog;
}

export interface CliReasoningLevel {
  id: string;
  label: string;
}

/** What the desktop's model picker offers for one CLI (`catalog` on `cli.runtime.list`). */
export interface CliRuntimeCatalog {
  /** False for a CLI `conversation.create` cannot start as a chat; New does not offer it. */
  conversational: boolean;
  /** The CLI a hosted runtime rides, when it rides one. */
  hostedVia: "claude-code" | null;
  /** The line under each row on the desktop: "Z.AI · via Claude Code", or the CLI's name. */
  providerLabel: string;
  allowCustomModelId: boolean;
  /** The picker's rows in its order; every id sharing a `family` is one row. */
  models: CliCatalogModel[];
}

export interface CliCatalogModel {
  id: string;
  label?: string;
  /** The row it renders under. */
  family: string;
  /** Whether this is the id the row selects, and whose label names the row. */
  familyDefault: boolean;
  /** The context window it pins, as the picker names it: "1M", or "Standard". */
  contextLabel: string;
  /** The picker marks the row New: one of its ids was first listed recently. */
  isNew?: boolean;
}

/**
 * The launchable CLIs from `cli.runtime.list`, with the models each declares.
 *
 * Read strictly, and filtered to `agentSelectable` — the registry also holds
 * rows that exist only for install and detection, and every launch door refuses
 * those, so offering one would be offering a button that cannot work.
 *
 * The point of reading this at all is that `cli` and `cliModel` are otherwise
 * blind strings: a hand-kept model list on the phone would be wrong the day the
 * desktop gained a model, and wrong in the direction that looks like the phone
 * is broken.
 */
export function readCliRuntimes(payload: unknown): CliRuntime[] {
  const rows = isRecord(payload) && Array.isArray(payload.clis) ? payload.clis : [];
  const runtimes: CliRuntime[] = [];
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    if (entry.agentSelectable !== true) continue;
    const id = typeof entry.id === "string" ? entry.id : null;
    if (!id) continue;
    const models: CliRuntimeModel[] = [];
    if (Array.isArray(entry.models)) {
      for (const model of entry.models) {
        if (!isRecord(model)) continue;
        const modelId = typeof model.id === "string" ? model.id : null;
        if (!modelId) continue;
        models.push({ id: modelId, label: typeof model.label === "string" && model.label ? model.label : modelId });
      }
    }
    const presets = Array.isArray(entry.permissionPresets)
      ? entry.permissionPresets.filter((preset): preset is PermissionPreset =>
          PERMISSION_PRESET_OPTIONS.some((option) => option.id === preset),
        )
      : null;
    const levels = readReasoningLevels(entry.reasoningLevels);
    const defaultLevel =
      typeof entry.defaultReasoningLevel === "string" && levels.some((level) => level.id === entry.defaultReasoningLevel)
        ? entry.defaultReasoningLevel
        : null;
    const catalog = readCliRuntimeCatalog(entry.catalog);
    runtimes.push({
      id,
      displayName: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : id,
      supportsModelSelection: entry.supportsModelSelection === true,
      models,
      ...(presets ? { permissionPresets: presets } : {}),
      ...(levels.length ? { reasoningLevels: levels } : {}),
      ...(defaultLevel ? { defaultReasoningLevel: defaultLevel } : {}),
      ...(catalog ? { catalog } : {}),
    });
  }
  return runtimes;
}

function readReasoningLevels(value: unknown): CliReasoningLevel[] {
  if (!Array.isArray(value)) return [];
  const levels: CliReasoningLevel[] = [];
  for (const level of value) {
    if (!isRecord(level) || typeof level.id !== "string" || !level.id.trim()) continue;
    if (levels.some((known) => known.id === level.id)) continue;
    levels.push({ id: level.id, label: typeof level.label === "string" && level.label.trim() ? level.label.trim() : level.id });
  }
  return levels;
}

/**
 * A row's `catalog`, or null when it is absent or not the shape the desktop
 * documents. All or nothing for the catalog's own fields, since a picker
 * drawn from half of one would disagree with the desktop's; a model row in
 * the wrong shape is skipped on its own.
 */
export function readCliRuntimeCatalog(value: unknown): CliRuntimeCatalog | null {
  if (!isRecord(value) || typeof value.conversational !== "boolean" || !Array.isArray(value.models)) return null;
  const providerLabel = typeof value.providerLabel === "string" ? value.providerLabel.trim() : "";
  if (!providerLabel) return null;
  const models: CliCatalogModel[] = [];
  for (const model of value.models) {
    if (!isRecord(model)) continue;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    const family = typeof model.family === "string" ? model.family.trim() : "";
    if (!id || !family || models.some((known) => known.id === id)) continue;
    const label = typeof model.label === "string" ? model.label.trim() : "";
    const contextLabel = typeof model.contextLabel === "string" ? model.contextLabel.trim() : "";
    models.push({
      id,
      ...(label ? { label } : {}),
      family,
      familyDefault: model.familyDefault === true,
      contextLabel: contextLabel || "Standard",
      ...(model.isNew === true ? { isNew: true } : {}),
    });
  }
  return {
    conversational: value.conversational,
    hostedVia: value.hostedVia === "claude-code" ? "claude-code" : null,
    providerLabel,
    allowCustomModelId: value.allowCustomModelId === true,
    models,
  };
}

/**
 * Whether New offers its Worktree chip for a project, as the desktop's New
 * chat offers its own: the desktop must take `worktree` (`new-chat-worktree`),
 * and the folder must be one it can fork. A folder on an SSH machine (spelled
 * `ssh://<machine>/…` on the desktop) never can, and one the desktop says is
 * not a git repository cannot either. A folder whose checkout has not been
 * read yet, or could not be, is offered: the desktop refuses it with
 * `worktree_unavailable` if it cannot, and New offers to start without one.
 */
export function newChatWorktreeOffered(input: {
  advertised: boolean;
  folderPath: string | null;
  /** True where the checkout read found a repository, false where it found none, null where it is not known. */
  git: boolean | null;
}): boolean {
  if (!input.advertised) return false;
  if (input.folderPath?.startsWith("ssh://")) return false;
  return input.git !== false;
}

export type PermissionPreset = ConversationPermissionPreset;

/**
 * The four permission presets in the desktop's own words, in the order its
 * menu lists them: strictest first, and No flag, which asks whatever the CLI
 * is configured to, last. `chip` is the chip-width name the desktop uses.
 */
export const PERMISSION_PRESET_OPTIONS: readonly {
  id: PermissionPreset;
  label: string;
  chip: string;
  hint: string;
}[] = [
  { id: "manual", label: "Manual", chip: "Manual", hint: "Asks before every edit and command." },
  { id: "auto", label: "Auto", chip: "Auto", hint: "Edits go through; commands and the rest ask." },
  { id: "bypass", label: "Bypass permissions", chip: "Bypass", hint: "Skips every prompt. Trusted repos only." },
  { id: "none", label: "No flag", chip: "No flag", hint: "No permission flag is passed; the CLI's own settings decide." },
];

/**
 * The presets a CLI's chat cannot be held to, as the desktop's chat launcher
 * and chat box dim them. The desktop's provider refuses them too, so this
 * only spares a person a refusal where the desktop listed nothing for the
 * chat: one with no live session, or New with the desktop's default CLI. A
 * CLI missing here runs every preset.
 */
const CHAT_PRESET_REFUSALS: Readonly<Record<string, readonly PermissionPreset[]>> = {
  // Cursor edits files in the workspace without asking, so it cannot ask
  // before every change.
  cursor: ["manual"],
};

/**
 * The CLI a chat provider rides. The desktop names each CLI's chat provider
 * `<cli>-agent`, with one exception kept here rather than guessed: Claude's is
 * `claude-agent` while its CLI plugin is `claude-code`. The catalog's own `cli`
 * wins whenever the desktop sent one; this is the fallback for a desktop that
 * did not.
 */
export function cliForChatProvider(providerId: string | null | undefined): string | null {
  const id = providerId?.trim() ?? "";
  if (!id) return null;
  if (id === "claude-agent") return "claude-code";
  const match = /^(.+)-agent$/u.exec(id);
  return match ? match[1] : null;
}

/**
 * The presets a phone may offer for a chat on one desktop, in the menu's order.
 *
 * A desktop that declares `conversation-permission-modes` runs all four, cut
 * to the ones the CLI (or the chat's provider) says it can run when it says,
 * and otherwise to the ones that CLI's chat is known to run. One that does
 * not runs only Bypass and No flag, and reads Manual or Auto as No flag, so
 * only those two are offered there: offering a mode the chat would never run
 * is the bug this exists to prevent. The preset a chat already runs under is
 * always offered, so the menu can say where it stands.
 */
export function offeredPermissionPresets(input: {
  fourPresets: boolean;
  /** What the CLI or the chat's provider lists, when the desktop said. */
  listed?: readonly PermissionPreset[];
  /** The chat's CLI, where it is known; read only when nothing is listed. */
  cli?: string | null;
  current?: PermissionPreset;
}): (typeof PERMISSION_PRESET_OPTIONS)[number][] {
  const refused = (input.cli && CHAT_PRESET_REFUSALS[input.cli]) || [];
  const allowed = new Set<PermissionPreset>(
    !input.fourPresets
      ? ["bypass", "none"]
      : input.listed?.length
        ? input.listed
        : PERMISSION_PRESET_OPTIONS.map((option) => option.id).filter((id) => !refused.includes(id)),
  );
  if (input.current) allowed.add(input.current);
  return PERMISSION_PRESET_OPTIONS.filter((option) => allowed.has(option.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The screens that make up New: the project picker and the composer.
const NEW_CHAT_FLOW = new Set(["ChooseProject", "NewChat"]);

/**
 * The stack once New has started a chat: the picker and the composer leave
 * with the prompt they sent, and the chat takes their place, so Back from it
 * returns to wherever New was opened from rather than to a picker whose choice
 * is already made. Only the flow's own screens at the top of the stack go.
 */
export function routesAfterNewChat<R extends { name: string }, C>(routes: readonly R[], chat: C): (R | C)[] {
  let end = routes.length;
  while (end > 0 && NEW_CHAT_FLOW.has(routes[end - 1].name)) end--;
  return [...routes.slice(0, end), chat];
}

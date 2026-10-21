// The model picker's rules, New's and an open chat's alike: the desktop's
// `CliModelPicker` read for a phone's bottom sheet. No react-native import, so
// `node --test` pins every rule the sheet draws by.
//
// The desktop's picker is a provider rail down the left and a flat list of
// models on the right, searched from a field over it. On the phone the rail
// is a row of chips across the top of the sheet. Each row is one MODEL, not
// one catalog id: the ids a CLI ships one model under at several context
// windows (`claude-opus-5` beside `claude-opus-5[1m]`) are one family row, and
// the window is a second choice on that row. A CLI's own default model leads
// its rows under the CLI's name, and selecting it sends no model at all.
//
// A desktop that advertises `cli-runtime-catalog` says how its picker groups
// each CLI's models (`catalog.models`, each with its `family`). One that does
// not lists bare ids, and they are grouped here by the same rule the desktop's
// grouping uses (`cli-model-families.ts` there): a bracketed suffix names the
// window. So an older desktop's picker reads the same; it only lacks the New
// marks and the provider lines.

import type { ConversationThread } from "../../api/conversationWire";
import type { CliCatalogModel, CliReasoningLevel, CliRuntime } from "./launchLogic";

/** One catalog id as the picker reads it; the catalog's grouping fields where the desktop sent them. */
export type PickerModel = {
  id: string;
  label?: string;
  family?: string;
  familyDefault?: boolean;
  contextLabel?: string;
  isNew?: boolean;
};

/** One context window a family offers: the id it selects and what it is called ("Standard", "1M"). */
export type PickerVariant = { id: string; label: string; base: boolean };

/** One model, with every window the catalog offers it at. */
export type PickerFamily = {
  key: string;
  /** The id the row selects when it is chosen with no window in mind. */
  defaultId: string;
  /** Its name; absent when nothing labelled it, and the row then shows the id in mono. */
  label?: string;
  /** Base window first. One entry: the model has no window to choose. */
  variants: PickerVariant[];
  isNew: boolean;
};

/** One row of the list. */
export type PickerRow = {
  key: string;
  cli: string;
  /** The model's name, or the CLI's for the CLI's own default. */
  name: string;
  /** The name is a bare id nothing labelled: drawn in the mono face. */
  mono: boolean;
  /** The raw id under a friendly name, only where it says something the name does not. */
  detailId?: string;
  /** The provider line, which the row shows while the list spans more than one provider. */
  provider: string;
  /** A muted note at the row's end: a current model the catalog no longer lists. */
  note?: string;
  /** The id this row selects; null selects the CLI's own default model. */
  model: string | null;
  family?: PickerFamily;
  isNew: boolean;
};

export type EffortLevel = CliReasoningLevel;

/** One CLI, as the rail and its list show it. */
export type PickerProvider = {
  cli: string;
  /** The rail's name for it: the CLI's display name. */
  label: string;
  /** The line naming who runs it: "Z.AI · via Claude Code", else the CLI's name. */
  providerLabel: string;
  rows: PickerRow[];
  /** Its effort levels, cheapest first; empty where it declares none, or effort cannot be sent. */
  levels: EffortLevel[];
  /** The level it runs at when none is passed, where it names one. */
  defaultLevel: string | null;
};

/** What is picked: the CLI (null is New's "Desktop default") and its model (null is the CLI's own default). */
export type PickerSelection = { cli: string | null; model: string | null };

/** The trigger's words while nothing is picked on New, and the sheet's row for it. */
export const DESKTOP_DEFAULT_LABEL = "Desktop default";
/** The effort ramp's first stop: no level passed, the CLI's own default effort. The desktop's word. */
export const EFFORT_UNSET_LABEL = "Auto";
/** The note a chat whose model cannot change wears over its list, in the desktop's words. */
export const MODEL_SET_ONCE_NOTE = "model is set once the chat starts";
/** The note on a model the chat runs that the catalog no longer lists. */
export const NOT_LISTED_NOTE = "Not listed";

const WINDOW_SUFFIX = /^(.+)\[([^\]]+)\]$/u;

/**
 * A catalog id split into the model it names and the window it pins:
 * `claude-opus-5[1m]` is `claude-opus-5` at `1m`. An id with no bracketed
 * suffix is the model at its own window.
 */
export function parseModelWindow(id: string): { baseId: string; window?: string } {
  const trimmed = id.trim();
  const match = WINDOW_SUFFIX.exec(trimmed);
  if (!match) return { baseId: trimmed };
  return { baseId: match[1], window: match[2] };
}

/**
 * The models grouped into families, in the order each family first appears.
 * The catalog's `family` decides the grouping where the desktop sent it, and
 * `familyDefault` which id names and selects the row; without them, the
 * bracketed suffix decides, and the un-suffixed id names the row, as the
 * desktop's own grouping does. A family the catalog ships only suffixed
 * keeps its first id in both roles.
 */
export function modelFamilies(models: readonly PickerModel[]): PickerFamily[] {
  const families = new Map<string, PickerFamily & { named: "catalog" | "base" | "first" }>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const { baseId, window } = parseModelWindow(id);
    const key = model.family?.trim() || baseId;
    let family = families.get(key);
    if (!family) {
      family = { key, defaultId: id, label: model.label, variants: [], isNew: false, named: "first" };
      families.set(key, family);
    }
    if (family.variants.some((variant) => variant.id === id)) continue;
    family.variants.push({
      id,
      label: model.contextLabel?.trim() || (window ? window.toUpperCase() : "Standard"),
      base: !window,
    });
    if (model.familyDefault === true && family.named !== "catalog") {
      family.defaultId = id;
      family.label = model.label;
      family.named = "catalog";
    } else if (!window && family.named === "first") {
      family.defaultId = id;
      family.label = model.label;
      family.named = "base";
    }
    if (model.isNew) family.isNew = true;
  }
  return [...families.values()].map(({ named: _named, ...family }) => ({
    ...family,
    // Base window first, as the desktop's window menu lists them; a stable
    // sort keeps the catalog's order otherwise.
    variants: [...family.variants].sort((a, b) => Number(b.base) - Number(a.base)),
  }));
}

/** The family a model id belongs to, or undefined when it is not in the catalog at all. */
export function familyForModel(families: readonly PickerFamily[], modelId: string | null | undefined): PickerFamily | undefined {
  if (!modelId) return undefined;
  return families.find((family) => family.variants.some((variant) => variant.id === modelId));
}

/**
 * A model's raw id, shown under its friendly name only when it adds something
 * the name does not already carry: `opus[1m]` under "Opus" stays,
 * `gpt-5.5` under "GPT-5.5" goes. The desktop's `meaningfulModelId`.
 */
export function meaningfulModelId(id: string, label: string | undefined): string | undefined {
  if (!label) return undefined;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const normalizedId = normalize(id);
  const normalizedLabel = normalize(label);
  if (!normalizedId || !normalizedLabel) return undefined;
  return normalizedLabel.includes(normalizedId) ? undefined : id;
}

/**
 * One CLI's rows: its own default model first, under the CLI's name, then a
 * row per family. A model the chat runs that the catalog no longer lists is
 * a row of its own at the end, marked "Not listed", so the current pick is
 * never missing from the list it was picked from.
 */
export function providerRows(input: {
  cli: string;
  label: string;
  providerLabel: string;
  models: readonly PickerModel[];
  current?: string | null;
}): PickerRow[] {
  const families = modelFamilies(input.models);
  const rows: PickerRow[] = [
    { key: rowKey(input.cli, null), cli: input.cli, name: input.label, mono: false, provider: input.providerLabel, model: null, isNew: false },
  ];
  for (const family of families) {
    const detailId = meaningfulModelId(family.defaultId, family.label);
    rows.push({
      key: rowKey(input.cli, family.defaultId),
      cli: input.cli,
      name: family.label ?? family.defaultId,
      mono: !family.label,
      ...(detailId ? { detailId } : {}),
      provider: input.providerLabel,
      model: family.defaultId,
      family,
      isNew: family.isNew,
    });
  }
  const current = input.current?.trim();
  if (current && !familyForModel(families, current)) {
    rows.push({
      key: rowKey(input.cli, current),
      cli: input.cli,
      name: current,
      mono: true,
      provider: input.providerLabel,
      note: NOT_LISTED_NOTE,
      model: current,
      isNew: false,
    });
  }
  return rows;
}

function rowKey(cli: string, model: string | null): string {
  return `${cli}::${model ?? ""}`;
}

/** The catalog's rows as the picker reads them. */
function catalogModels(models: readonly CliCatalogModel[]): PickerModel[] {
  return models.map((model) => ({
    id: model.id,
    ...(model.label ? { label: model.label } : {}),
    family: model.family,
    familyDefault: model.familyDefault,
    contextLabel: model.contextLabel,
    ...(model.isNew ? { isNew: true } : {}),
  }));
}

/**
 * New's rail: every CLI the desktop can start a chat on, in the order it
 * lists them. With the catalog that is each CLI it says is conversational,
 * whether or not it has models to choose (its own default is still a choice),
 * read from the picker's own rows. Without the catalog it is what New offered
 * before: the CLIs that list models, read from that list.
 *
 * `effort` is whether the desktop takes an effort on `conversation.create`;
 * without it no CLI offers levels, since none could be sent.
 */
export function newChatProviders(
  runtimes: readonly CliRuntime[],
  options: { catalog: boolean; effort: boolean },
): PickerProvider[] {
  const providers: PickerProvider[] = [];
  for (const runtime of runtimes) {
    const catalog = options.catalog ? runtime.catalog : undefined;
    if (catalog && !catalog.conversational) continue;
    if (!catalog && (!runtime.supportsModelSelection || runtime.models.length === 0)) continue;
    const providerLabel = catalog?.providerLabel || runtime.displayName;
    const models: PickerModel[] = catalog ? catalogModels(catalog.models) : runtime.models;
    const levels = options.effort ? (runtime.reasoningLevels ?? []) : [];
    providers.push({
      cli: runtime.id,
      label: runtime.displayName,
      providerLabel,
      rows: providerRows({ cli: runtime.id, label: runtime.displayName, providerLabel, models }),
      levels,
      defaultLevel: levels.length ? (runtime.defaultReasoningLevel ?? null) : null,
    });
  }
  return providers;
}

/**
 * An open chat's rail: its own CLI alone, as the desktop's chat offers it,
 * with the models the desktop lists for the chat (`thread.models`), which are
 * the ones it can switch to. Where the desktop also lists its picker's rows
 * for that CLI (`runtime.catalog`), a model is matched to its row by id for
 * the family, window and New mark the chat's own list does not carry. No
 * levels: a chat's effort cannot be changed over the wire.
 */
export function chatProvider(
  models: NonNullable<ConversationThread["models"]>,
  runtime: CliRuntime | null,
  current: string | null,
): PickerProvider {
  const byId = new Map((runtime?.catalog?.models ?? []).map((model) => [model.id, model]));
  const pickerModels: PickerModel[] = models.options.map((option) => {
    const known = byId.get(option.id);
    const label = option.label || known?.label;
    return {
      id: option.id,
      ...(label ? { label } : {}),
      ...(known
        ? { family: known.family, familyDefault: known.familyDefault, contextLabel: known.contextLabel, ...(known.isNew ? { isNew: true } : {}) }
        : {}),
    };
  });
  const label = models.cliLabel || models.cli;
  const providerLabel = runtime?.catalog?.providerLabel || label;
  return {
    cli: models.cli,
    label,
    providerLabel,
    rows: providerRows({ cli: models.cli, label, providerLabel, models: pickerModels, current }),
    levels: [],
    defaultLevel: null,
  };
}

/**
 * A chat whose desktop lists no models for it (no `conversation-models`, or
 * no catalog for the chat): its model alone, as the record of what it runs,
 * for a sheet opened for its Access row.
 */
export function readOnlyProvider(input: { cli: string; label: string; modelName: string }): PickerProvider {
  return {
    cli: input.cli,
    label: input.label,
    providerLabel: input.label,
    rows: [{ key: rowKey(input.cli, "current"), cli: input.cli, name: input.modelName, mono: false, provider: input.label, model: null, isNew: false }],
    levels: [],
    defaultLevel: null,
  };
}

/**
 * Whether the sheet offers its search: where there is a choice to search,
 * which a list that cannot be picked from, or one with a single row, is not.
 * The desktop's popover always has one; it also always has a choice.
 */
export function pickerSearchOffered(providers: readonly PickerProvider[], locked: boolean): boolean {
  if (locked) return false;
  return providers.reduce((total, provider) => total + provider.rows.length, 0) > 1;
}

/**
 * What the list shows. A query searches every provider at once, as the
 * desktop's does (a name you can spell is faster than a rail you have to pick
 * first), matching the name, the provider line and the id; with no query, the
 * rows of the provider the rail is on.
 */
export function visiblePickerRows(
  providers: readonly PickerProvider[],
  input: { filter: string | null; query: string },
): { rows: PickerRow[]; searching: boolean } {
  const needle = input.query.trim().toLowerCase();
  if (needle) {
    const rows = providers
      .flatMap((provider) => provider.rows)
      .filter(
        (row) =>
          row.name.toLowerCase().includes(needle) ||
          row.provider.toLowerCase().includes(needle) ||
          (row.model ?? "").toLowerCase().includes(needle),
      );
    return { rows, searching: true };
  }
  const provider = providers.find((entry) => entry.cli === input.filter) ?? providers[0];
  return { rows: provider ? [...provider.rows] : [], searching: false };
}

/** Where the rail opens: on the picked CLI, else on the first. */
export function initialPickerFilter(providers: readonly PickerProvider[], selection: PickerSelection): string | null {
  return providers.find((provider) => provider.cli === selection.cli)?.cli ?? providers[0]?.cli ?? null;
}

/** Whether a row is the current pick: a family row is, whichever of its windows is picked. */
export function pickerRowSelected(row: PickerRow, selection: PickerSelection): boolean {
  if (row.cli !== selection.cli) return false;
  if (row.model === null) return selection.model === null;
  if (row.family) return row.family.variants.some((variant) => variant.id === selection.model);
  return row.model === selection.model;
}

/**
 * The pick a tap on a row makes. Choosing the family already picked keeps the
 * window picked on it rather than dropping it back to the row's default.
 */
export function choosePickerRow(row: PickerRow, selection: PickerSelection): PickerSelection {
  if (row.model === null) return { cli: row.cli, model: null };
  if (pickerRowSelected(row, selection) && selection.model) return { cli: row.cli, model: selection.model };
  return { cli: row.cli, model: row.model };
}

/**
 * A row's second line, as the desktop's picker writes it: it qualifies the
 * name and never restates it. The provider only while the list spans more
 * than one (under a search; with the rail on one provider the rail already
 * said it, and on the CLI's own row the name IS the provider), and the raw id
 * only where the name does not already spell it (`meaningfulModelId`). Empty
 * for most rows, and then no second line is drawn.
 */
export function pickerRowDetail(row: PickerRow, input: { spansProviders: boolean }): string {
  return [input.spansProviders && row.model !== null ? row.provider : null, row.detailId].filter(Boolean).join(" · ");
}

/** The windows a row offers as its second choice: none unless the family ships more than one. */
export function windowChoices(row: PickerRow): PickerVariant[] {
  return row.family && row.family.variants.length > 1 ? row.family.variants : [];
}

/**
 * What the picker's trigger says: the model, not the CLI that carries it (the
 * CLI's mark beside it already says which). The CLI's name for its own
 * default, the family's name for any of its windows, and the raw id for a
 * model nothing names. `fallback` while no CLI is picked.
 */
export function pickerLabel(providers: readonly PickerProvider[], selection: PickerSelection, fallback: string): string {
  if (!selection.cli) return fallback;
  const provider = providers.find((entry) => entry.cli === selection.cli);
  if (selection.model === null) return provider?.label ?? selection.cli;
  const row = provider?.rows.find((entry) => entry.model !== null && pickerRowSelected(entry, selection));
  if (row?.family) return row.family.label ?? selection.model;
  return row?.name ?? selection.model;
}

/** The picked window's name, where the picked model's family has more than one; null otherwise. */
export function pickedWindowLabel(providers: readonly PickerProvider[], selection: PickerSelection): string | null {
  const provider = providers.find((entry) => entry.cli === selection.cli);
  const family = familyForModel(
    (provider?.rows ?? []).flatMap((row) => (row.family ? [row.family] : [])),
    selection.model,
  );
  if (!family || family.variants.length < 2) return null;
  return family.variants.find((variant) => variant.id === selection.model)?.label ?? null;
}

/** One stop of the effort ramp; `id` null is Auto, which passes no level. */
export type EffortStop = { id: string | null; label: string };

/** The ramp: Auto first, where nothing is dialled in, then each level, cheapest first. */
export function effortStops(levels: readonly EffortLevel[]): EffortStop[] {
  return [{ id: null, label: EFFORT_UNSET_LABEL }, ...levels.map((level) => ({ id: level.id, label: level.label }))];
}

/** The picked level's name, or Auto for none (or one the CLI does not declare). */
export function effortLabel(levels: readonly EffortLevel[], value: string | null): string {
  return levels.find((level) => level.id === value)?.label ?? EFFORT_UNSET_LABEL;
}

/** The costliest level, which the ramp draws in the warn tone: the last one declared. */
export function costliestEffort(levels: readonly EffortLevel[]): string | null {
  return levels[levels.length - 1]?.id ?? null;
}

/** A picked level the CLI still declares, else none: a level left from another CLI is not sent. */
export function keptEffort(levels: readonly EffortLevel[], value: string | null): string | null {
  return value && levels.some((level) => level.id === value) ? value : null;
}

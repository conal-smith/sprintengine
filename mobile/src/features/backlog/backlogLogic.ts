import {
  MobileControlBacklogItemCriticality,
  MobileControlBacklogItemDifficulty,
  MobileControlBacklogItemSnapshot,
  MobileControlBacklogItemStatus,
  MobileControlBacklogItemType,
} from "../../shared/mobile-control";

export interface BacklogRowItem extends MobileControlBacklogItemSnapshot {
  workspacePath: string;
  workspaceName: string;
}

export interface BacklogWorkspaceGroup {
  workspaceId: string;
  workspacePath: string;
  /** The repo this group belongs to, when the desktop published one. */
  projectKey?: string;
  workspaceName: string;
  items: BacklogRowItem[];
  /**
   * Epic metadata by slug — display id, chosen colour, rollup. Always a
   * Map, empty when the desktop published none, so callers never branch on
   * absence just to do a lookup.
   */
  epics: Map<string, BacklogEpicMeta>;
}

const backlogStatuses = new Set<MobileControlBacklogItemStatus>([
  "idea",
  "ready",
  "in_progress",
  "needs_input",
  "completed",
  "archived",
]);
const backlogTypes = new Set<MobileControlBacklogItemType>(["epic", "feature", "bug", "mockup", "spike"]);
const backlogDifficulties = new Set<MobileControlBacklogItemDifficulty>(["xs", "s", "m", "l", "xl"]);
const backlogCriticalities = new Set<MobileControlBacklogItemCriticality>(["low", "normal", "high", "critical"]);

// Defensive normalizer for the snapshot's backlog field: the desktop is the
// source of truth, but the phone never trusts the wire shape blindly.
export function normalizeBacklogWorkspaces(input: unknown): BacklogWorkspaceGroup[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter(isRecord)
    .map((workspace) => {
      const workspacePath = readString(workspace.workspacePath);
      const workspaceName = readString(workspace.workspaceName) || lastPathSegment(workspacePath);
      if (!workspacePath) {
        return null;
      }

      const items = Array.isArray(workspace.items)
        ? workspace.items
            .filter(isRecord)
            .map((item) => normalizeBacklogItem(item, workspacePath, workspaceName))
            .filter((item): item is BacklogRowItem => Boolean(item))
        : [];

      const projectKey = readString(workspace.projectKey);

      return {
        workspaceId: readString(workspace.workspaceId) || `backlog:${workspacePath}`,
        workspacePath,
        ...(projectKey ? { projectKey } : {}),
        workspaceName,
        items,
        epics: normalizeBacklogEpics(workspace.epics),
      };
    })
    .filter((workspace): workspace is BacklogWorkspaceGroup => Boolean(workspace));
}

function normalizeBacklogItem(
  input: Record<string, unknown>,
  workspacePath: string,
  workspaceName: string,
): BacklogRowItem | null {
  const relativePath = readString(input.relativePath);
  if (!relativePath) {
    return null;
  }

  const status = input.status;
  // Lowercased, because everything that matches against it already is: the epic
  // container's slug is derived from its filename and lowercased
  // (`epicSlugForContainer`), and the snapshot's `epics` block is keyed the same
  // way. Left raw, a member whose frontmatter said `epic: Mobile-Engine-Parity`
  // formed its own group beside the container it meant to join, and missed its
  // own epic's colour and display id.
  const epic = readString(input.epic).toLowerCase();
  return {
    itemId: readString(input.itemId) || relativePath,
    relativePath,
    title: readString(input.title) || lastPathSegment(relativePath),
    ...(typeof input.excerpt === "string" && input.excerpt.trim() ? { excerpt: input.excerpt.trim() } : {}),
    status: backlogStatuses.has(status as MobileControlBacklogItemStatus)
      ? (status as MobileControlBacklogItemStatus)
      : "idea",
    ...(backlogTypes.has(input.type as MobileControlBacklogItemType)
      ? { type: input.type as MobileControlBacklogItemType }
      : {}),
    ...(backlogDifficulties.has(input.difficulty as MobileControlBacklogItemDifficulty)
      ? { difficulty: input.difficulty as MobileControlBacklogItemDifficulty }
      : {}),
    ...(backlogCriticalities.has(input.criticality as MobileControlBacklogItemCriticality)
      ? { criticality: input.criticality as MobileControlBacklogItemCriticality }
      : {}),
    ...(epic ? { epic } : {}),
    ...(typeof input.updatedAt === "string" ? { updatedAt: input.updatedAt } : {}),
    workspacePath,
    workspaceName,
  };
}

export const backlogStatusLabel: Record<MobileControlBacklogItemStatus, string> = {
  idea: "Idea",
  ready: "Ready",
  in_progress: "In progress",
  needs_input: "Needs input",
  completed: "Completed",
  archived: "Archived",
};

export function backlogStatusTone(
  status: MobileControlBacklogItemStatus,
): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "needs_input":
      return "warning";
    case "completed":
      return "success";
    default:
      return "neutral";
  }
}

export function triageSummary(item: MobileControlBacklogItemSnapshot): string {
  const parts: string[] = [];
  if (item.type) {
    parts.push(item.type.charAt(0).toUpperCase() + item.type.slice(1));
  }
  if (item.difficulty) {
    parts.push(item.difficulty.toUpperCase());
  }
  if (item.criticality) {
    parts.push(item.criticality.charAt(0).toUpperCase() + item.criticality.slice(1));
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Triage: view / sort / group, ported 1:1 from the desktop panel's pure logic
// (../multicode/src/renderer/src/utils/backlogTriage.ts) so an identical data
// set orders identically on both. The desktop `Triageable` carries `risk`,
// `createdAtMs`, `isEpic` and a numeric `modifiedAt`; the mobile snapshot has
// none of those verbatim, so `toTriageable` derives what it can and leaves the
// rest absent. The comparators already sink absent axes, so the port stays
// faithful for every axis the snapshot can feed. Gaps recorded on the takeover
// review log: `risk` (absent → `best` sort degrades to criticality→difficulty)
// and `createdAtMs` (absent → `created` sort falls back to updated time).
//
// A `dependency` sort used to sit beside these. It was different in kind: `risk`
// and `createdAtMs` degrade an axis the user did not name, while "Dependency
// order" was a control the user chose that then sorted by recency — and the two
// orders correlate on a young backlog, so it read as working. It is removed
// rather than left degrading. Restoring it needs `dependsOn` on
// MobileControlBacklogItemSnapshot, which the desktop models
// (renderer/src/utils/backlogDependencies.ts) but does not project.
// ---------------------------------------------------------------------------

export type BacklogView =
  | "active"
  | "all"
  | "epics"
  | "quick_wins"
  | "strategic_bets"
  | "defer"
  | "unestimated"
  | "completed"
  | "archived";
export type BacklogSort =
  | "best"
  | "recent"
  | "created"
  | "status"
  | "priority"
  | "largest"
  | "smallest";
export type BacklogGroup = "none" | "by_epic";
export type BacklogRisk = "low" | "normal" | "high";

export const backlogViewLabel: Record<BacklogView, string> = {
  active: "Active",
  all: "All items",
  epics: "Epics",
  quick_wins: "Quick wins",
  strategic_bets: "Strategic bets",
  defer: "Defer candidates",
  unestimated: "Unestimated",
  completed: "Completed",
  archived: "Archived",
};
export const backlogSortLabel: Record<BacklogSort, string> = {
  best: "Best",
  recent: "Recently updated",
  created: "Recently created",
  status: "Status",
  priority: "Priority",
  largest: "Largest first",
  smallest: "Smallest first",
};
export const backlogGroupLabel: Record<BacklogGroup, string> = {
  none: "None",
  by_epic: "By epic",
};

export const backlogViewOptions: readonly BacklogView[] = [
  "active",
  "all",
  "epics",
  "quick_wins",
  "strategic_bets",
  "defer",
  "unestimated",
  "completed",
  "archived",
];
export const backlogSortOptions: readonly BacklogSort[] = [
  "best",
  "recent",
  "created",
  "status",
  "priority",
  "largest",
  "smallest",
];
export const backlogGroupOptions: readonly BacklogGroup[] = ["none", "by_epic"];

const DIFFICULTY_RANK: Record<MobileControlBacklogItemDifficulty, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };
const CRITICALITY_RANK: Record<MobileControlBacklogItemCriticality, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};
const RISK_RANK: Record<BacklogRisk, number> = { low: 0, normal: 1, high: 2 };
const STATUS_RANK: Record<MobileControlBacklogItemStatus, number> = {
  needs_input: 0,
  in_progress: 1,
  ready: 2,
  idea: 3,
  completed: 4,
  archived: 5,
};

const SMALL = new Set<MobileControlBacklogItemDifficulty>(["xs", "s"]);
const LARGE = new Set<MobileControlBacklogItemDifficulty>(["l", "xl"]);
const URGENT = new Set<MobileControlBacklogItemCriticality>(["high", "critical"]);

/** The subset of an item the triage lenses and sorts read — desktop `Triageable`. */
export interface Triageable {
  difficulty?: MobileControlBacklogItemDifficulty;
  criticality?: MobileControlBacklogItemCriticality;
  risk?: BacklogRisk;
  status: MobileControlBacklogItemStatus;
  modifiedAt: number;
  createdAtMs: number;
  relativePath: string;
  isEpic: boolean;
}

/** Derive the desktop `Triageable` shape from a mobile snapshot row. */
export function toTriageable(item: BacklogRowItem): Triageable {
  const modifiedAt = item.updatedAt ? Date.parse(item.updatedAt) || 0 : 0;
  return {
    ...(item.difficulty ? { difficulty: item.difficulty } : {}),
    ...(item.criticality ? { criticality: item.criticality } : {}),
    // `risk` is absent from the mobile snapshot; the comparators treat it as
    // missing (sinks below estimated peers) rather than guessing.
    status: item.status,
    modifiedAt,
    // The snapshot carries no separate creation time; fall back to updated.
    createdAtMs: modifiedAt,
    relativePath: item.relativePath,
    isEpic: item.type === "epic",
  };
}

export function isBacklogUnestimated(item: Pick<Triageable, "difficulty" | "criticality">): boolean {
  return item.difficulty == null || item.criticality == null;
}

export function matchesBacklogView(item: Triageable, view: BacklogView): boolean {
  if (view === "all") return true;
  if (view === "archived") return item.status === "archived";
  if (view === "completed") return item.status === "completed";
  // Epics is structural — every epic container at any stage — so it is tested
  // before the terminal-state guard, letting completed/archived epics show.
  if (view === "epics") return item.isEpic;
  if (item.status === "archived" || item.status === "completed") return false;

  switch (view) {
    case "active":
      return true;
    case "quick_wins":
      return item.difficulty != null && SMALL.has(item.difficulty) && item.criticality != null && URGENT.has(item.criticality);
    case "strategic_bets":
      return item.difficulty != null && LARGE.has(item.difficulty) && item.criticality != null && URGENT.has(item.criticality);
    case "defer":
      return item.difficulty != null && LARGE.has(item.difficulty) && item.criticality === "low";
    case "unestimated":
      return isBacklogUnestimated(item);
    default:
      return true;
  }
}

export function compareBacklogItems(a: Triageable, b: Triageable, sort: BacklogSort): number {
  switch (sort) {
    case "status": {
      const sa = STATUS_RANK[a.status];
      const sb = STATUS_RANK[b.status];
      if (sa !== sb) return sa - sb;
      return b.modifiedAt - a.modifiedAt;
    }
    case "priority": {
      const ca = a.criticality ? CRITICALITY_RANK[a.criticality] : -1;
      const cb = b.criticality ? CRITICALITY_RANK[b.criticality] : -1;
      if (ca !== cb) return cb - ca;
      const da = a.difficulty ? DIFFICULTY_RANK[a.difficulty] : Number.POSITIVE_INFINITY;
      const db = b.difficulty ? DIFFICULTY_RANK[b.difficulty] : Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return b.modifiedAt - a.modifiedAt;
    }
    case "largest":
    case "smallest": {
      const da = a.difficulty ? DIFFICULTY_RANK[a.difficulty] : null;
      const db = b.difficulty ? DIFFICULTY_RANK[b.difficulty] : null;
      if (da == null && db == null) return b.modifiedAt - a.modifiedAt;
      if (da == null) return 1;
      if (db == null) return -1;
      if (da !== db) return sort === "largest" ? db - da : da - db;
      return b.modifiedAt - a.modifiedAt;
    }
    case "best": {
      const ca = a.criticality ? CRITICALITY_RANK[a.criticality] : -1;
      const cb = b.criticality ? CRITICALITY_RANK[b.criticality] : -1;
      if (ca !== cb) return cb - ca;
      const ra = a.risk ? RISK_RANK[a.risk] : Number.POSITIVE_INFINITY;
      const rb = b.risk ? RISK_RANK[b.risk] : Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      const da = a.difficulty ? DIFFICULTY_RANK[a.difficulty] : Number.POSITIVE_INFINITY;
      const db = b.difficulty ? DIFFICULTY_RANK[b.difficulty] : Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.relativePath.localeCompare(b.relativePath);
    }
    case "created":
      return b.createdAtMs - a.createdAtMs;
    case "recent":
    default:
      return b.modifiedAt - a.modifiedAt;
  }
}

// The seven-color highlight wheel. The dark set is copied from
// ../multicode/src/renderer/src/utils/highlight.ts (order and hex verbatim);
// the desktop wheel is dark-tuned, and used as 11px chip text on a white
// card its lightest members sat near 1.4:1 — so Light re-inks each
// slot with a darkened same-hue counterpart, exactly how the theme re-inks its
// tone tokens. Every pairing is pinned at the 4.5:1 small-text floor by
// glyphContrast.regression.test.js; retune there, not by eye.
export const backlogHighlightColors = ["red", "orange", "amber", "green", "blue", "purple", "pink"] as const;
export type BacklogHighlightColor = (typeof backlogHighlightColors)[number];
export const backlogHighlightHexByTheme: Record<"light" | "dark", Record<BacklogHighlightColor, string>> = {
  dark: {
    red: "#ff5a5f",
    orange: "#ff8c42",
    amber: "#ffbf2f",
    green: "#30d158",
    blue: "#5c7cff",
    purple: "#a78bfa",
    pink: "#ff7eb3",
  },
  light: {
    red: "#b02430",
    orange: "#8a4210",
    amber: "#755408",
    green: "#1d6b34",
    blue: "#3c50c8",
    purple: "#6742c4",
    pink: "#a62c62",
  },
};

/**
 * The one epic band hue per theme. Grouping is structure, not identity: every
 * By-epic band wears the same restrained blue (brand: per-section tinting with
 * competing hues is a reject), while the per-epic wheel color survives only as
 * the small dot in an ungrouped row's epic reference.
 */
export const epicBandHexByTheme: Record<"light" | "dark", string> = {
  dark: "#7c9ffc",
  light: "#4a68b8",
};

/**
 * What the snapshot knows about one epic, reduced to what the phone
 * renders. The `epics` block rides the backlog workspace; items carry only the
 * `epic:` up-slug, so this is the only source for an epic's chosen colour, its
 * display id, and its rollup.
 */
export interface BacklogEpicMeta {
  slug: string;
  displayId?: string;
  title?: string;
  /** The hand-picked wheel colour, when the epic file sets one. */
  color?: BacklogHighlightColor;
  doneCount: number;
  totalCount: number;
}

/**
 * Defensive normalizer for the snapshot's per-workspace epic metadata, keyed by
 * slug for lookup from a member row.
 *
 * `color` is validated against the wheel rather than trusted: it arrives as an
 * open `string` on the wire, and an unrecognised value must fall back to the slug
 * hash instead of reaching a theme lookup that would return `undefined` and paint
 * nothing.
 */
export function normalizeBacklogEpics(input: unknown): Map<string, BacklogEpicMeta> {
  const bySlug = new Map<string, BacklogEpicMeta>();
  if (!Array.isArray(input)) return bySlug;

  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const slug = readString(entry.slug).toLowerCase();
    if (!slug || bySlug.has(slug)) continue;

    const rawColor = readString(entry.color) as BacklogHighlightColor;
    const color = backlogHighlightColors.includes(rawColor) ? rawColor : undefined;
    const displayId = readString(entry.displayId);
    const title = readString(entry.title);

    bySlug.set(slug, {
      slug,
      ...(displayId ? { displayId } : {}),
      ...(title ? { title } : {}),
      ...(color ? { color } : {}),
      doneCount: readCount(entry.doneCount),
      totalCount: readCount(entry.totalCount),
    });
  }

  return bySlug;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * The epic's colour: the one its file chose when the desktop told us, else a
 * stable hash of the slug.
 *
 * The hash existed because the snapshot did not carry the chosen colour. It now
 * does, so the hash is the fallback for an epic the block does not
 * cover — a member pointing at an epic in another workspace, or a desktop that
 * predates the field — rather than the default path.
 */
export function epicColor(slug: string, meta?: BacklogEpicMeta): BacklogHighlightColor {
  return meta?.color ?? epicColorFromSlug(slug);
}

/**
 * A stable epic color derived from the slug, for an epic the snapshot's `epics`
 * block does not cover. FNV-1a over the lowercased slug, matching the desktop's
 * `stableBacklogObjectId` hash pattern, mapped onto the wheel.
 */
export function epicColorFromSlug(slug: string): BacklogHighlightColor {
  const normalized = slug.toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return backlogHighlightColors[(hash >>> 0) % backlogHighlightColors.length];
}

export interface BacklogSearchAndTriage {
  view: BacklogView;
  sort: BacklogSort;
  search: string;
}

function matchesBacklogSearch(item: BacklogRowItem, needle: string): boolean {
  if (!needle) return true;
  return (
    item.title.toLowerCase().includes(needle) ||
    (item.excerpt ? item.excerpt.toLowerCase().includes(needle) : false) ||
    item.itemId.toLowerCase().includes(needle)
  );
}

/** Client-side view + search + sort over one workspace's rows. */
export function selectBacklogRows(items: BacklogRowItem[], { view, sort, search }: BacklogSearchAndTriage): BacklogRowItem[] {
  const needle = search.trim().toLowerCase();
  return items
    .map((item) => ({ item, triage: toTriageable(item) }))
    .filter(({ triage }) => matchesBacklogView(triage, view))
    .filter(({ item }) => matchesBacklogSearch(item, needle))
    .sort((a, b) => compareBacklogItems(a.triage, b.triage, sort))
    .map(({ item }) => item);
}

export interface BacklogEpicGroup {
  /** Stable key: the epic slug, or "" for the ungrouped bucket. */
  key: string;
  epicSlug: string | null;
  /** The epic container row itself, when it is present in this workspace. */
  epicItem: BacklogRowItem | null;
  color: BacklogHighlightColor | null;
  /** The snapshot's metadata for this epic, when it published any. */
  meta?: BacklogEpicMeta;
  items: BacklogRowItem[];
  /**
   * Rollup over the rows in THIS group. Deliberately counted locally rather than
   * taken from `meta.doneCount`: the group holds what the current view and search
   * left behind, so the desktop's whole-epic rollup would disagree with the rows
   * on screen — the design system calls the same count in two places showing
   * different values a reject. `meta` carries the whole-epic figure when a surface
   * genuinely wants it.
   */
  doneCount: number;
  totalCount: number;
}

const UNGROUPED_KEY = "";

/**
 * Group already-filtered/sorted rows by their epic slug. The epic container row
 * (type `epic`) heads its group; its members keep the sorted order they arrived
 * in. Rows with no epic collect into one trailing ungrouped bucket. Rollups
 * count member rows (excluding the epic container) that are completed.
 */
export function groupBacklogByEpic(
  items: BacklogRowItem[],
  epics: Map<string, BacklogEpicMeta> = new Map(),
): BacklogEpicGroup[] {
  const groups = new Map<string, BacklogEpicGroup>();
  const order: string[] = [];

  const ensure = (key: string, slug: string | null): BacklogEpicGroup => {
    let group = groups.get(key);
    if (!group) {
      const meta = slug ? epics.get(slug) : undefined;
      group = {
        key,
        epicSlug: slug,
        epicItem: null,
        color: slug ? epicColor(slug, meta) : null,
        ...(meta ? { meta } : {}),
        items: [],
        doneCount: 0,
        totalCount: 0,
      };
      groups.set(key, group);
      order.push(key);
    }
    return group;
  };

  for (const item of items) {
    if (item.type === "epic") {
      // An epic container heads its own slug's group. Its slug is its own
      // identity (`epic:` points *up*, so a container has no `epic` of its own).
      const slug = epicSlugForContainer(item);
      const group = ensure(slug ?? UNGROUPED_KEY, slug);
      group.epicItem = item;
      continue;
    }

    const slug = item.epic ?? null;
    const group = ensure(slug ?? UNGROUPED_KEY, slug);
    group.items.push(item);
    group.totalCount += 1;
    if (item.status === "completed") {
      group.doneCount += 1;
    }
  }

  return order.map((key) => groups.get(key) as BacklogEpicGroup);
}

/**
 * An epic container's own slug. The snapshot has no explicit field for it, so it
 * is derived from the filename stem of its `relativePath` (the desktop's slug
 * source), lowercased — the same value a member's `epic:` frontmatter points to.
 */
function epicSlugForContainer(item: BacklogRowItem): string | null {
  const stem = lastPathSegment(item.relativePath).replace(/\.mdx?$/iu, "");
  return stem ? stem.toLowerCase() : null;
}

// Create-form option lists. Ordered for the picker, not by the validator sets
// above (which are unordered membership checks). Mirrors the desktop create
// dialog's selectable axes; `status` is fixed to `idea` by the desktop service.
export const backlogCreateTypeOptions: readonly MobileControlBacklogItemType[] = ["feature", "bug", "spike", "mockup"];
export const backlogCreateDifficultyOptions: readonly MobileControlBacklogItemDifficulty[] = ["xs", "s", "m", "l", "xl"];
export const backlogCreateCriticalityOptions: readonly MobileControlBacklogItemCriticality[] = [
  "low",
  "normal",
  "high",
  "critical",
];

// Triage option lists for `backlog.update` (item 27). These are the *edit*
// vocabulary, which is why `epic` is offered here and not on create: create mints
// a leaf item, but an existing item can be promoted to an epic container, and the
// desktop executor accepts it.
//
// There is no "unset" option on any axis: an omitted field on the wire means
// "leave this alone", so the protocol has no way to express "clear it". Offering
// a deselect would silently no-op — the picker therefore only ever sets.
export const backlogTypeOptions: readonly MobileControlBacklogItemType[] = [
  "epic",
  "feature",
  "bug",
  "mockup",
  "spike",
];
export const backlogDifficultyOptions = backlogCreateDifficultyOptions;
export const backlogCriticalityOptions = backlogCreateCriticalityOptions;

export const backlogCreateTitleMaxChars = 200;
export const backlogCreateDescriptionMaxChars = 4000;

export interface BacklogCreateWorkspaceOption {
  workspaceId: string;
  workspacePath: string;
  workspaceName: string;
}

// The create form offers the same per-workspace grouping the list uses, so the
// phone writes into a workspace the desktop already knows about (no silent
// default — the user must pick). Workspaces with zero items are kept so the
// first item in a fresh workspace can still be captured.
export function selectBacklogCreateWorkspaces(input: unknown): BacklogCreateWorkspaceOption[] {
  return normalizeBacklogWorkspaces(input).map((workspace) => ({
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.workspacePath,
    workspaceName: workspace.workspaceName,
  }));
}

export interface BacklogCreateDraft {
  workspacePath: string | null;
  title: string;
  description: string;
  type?: MobileControlBacklogItemType;
  difficulty?: MobileControlBacklogItemDifficulty;
  criticality?: MobileControlBacklogItemCriticality;
}

export interface BacklogCreatePayload {
  workspacePath: string;
  title: string;
  description?: string;
  type?: MobileControlBacklogItemType;
  difficulty?: MobileControlBacklogItemDifficulty;
  criticality?: MobileControlBacklogItemCriticality;
}

export type BacklogCreateValidation =
  | { ok: true; payload: BacklogCreatePayload }
  | { ok: false; error: string };

// Pure client-side guard mirroring the desktop payload validator (required
// workspace + non-empty title). The desktop revalidates and is the authority;
// this keeps the user from sending an obviously-invalid command and gives a
// precise message instead of a round trip to the desktop.
export function buildBacklogCreatePayload(draft: BacklogCreateDraft): BacklogCreateValidation {
  const workspacePath = typeof draft.workspacePath === "string" ? draft.workspacePath.trim() : "";
  if (!workspacePath) {
    return { ok: false, error: "Choose a workspace before creating the item." };
  }

  const title = draft.title.trim();
  if (!title) {
    return { ok: false, error: "Add a title before creating the item." };
  }
  if (title.length > backlogCreateTitleMaxChars) {
    return { ok: false, error: `Title must be ${backlogCreateTitleMaxChars} characters or fewer.` };
  }

  const description = draft.description.trim();
  if (description.length > backlogCreateDescriptionMaxChars) {
    return { ok: false, error: `Description must be ${backlogCreateDescriptionMaxChars} characters or fewer.` };
  }

  return {
    ok: true,
    payload: {
      workspacePath,
      title,
      ...(description ? { description } : {}),
      ...(draft.type ? { type: draft.type } : {}),
      ...(draft.difficulty ? { difficulty: draft.difficulty } : {}),
      ...(draft.criticality ? { criticality: draft.criticality } : {}),
    },
  };
}

export function selectBacklogEmptyState({
  errorMessage,
  isLoading,
  projectName,
  hasBacklogGroup = true,
}: {
  errorMessage?: string | null;
  isLoading: boolean;
  /** The current project, so an empty list says *which* backlog is empty. */
  projectName?: string | null;
  /**
   * Whether the snapshot carried a backlog group for this project at all.
   *
   * "The desktop sent a backlog and it was empty" and "no backlog reached us for
   * this project" are different facts, and this screen used to state the first
   * whenever the second was true. That is how a project-key bug hid: every repo with both
   * runs and a backlog was split in two, and the half with no backlog calmly
   * reported "no backlog items yet" over 50 items that were right there.
   * Never claim an emptiness that has not been observed.
   */
  hasBacklogGroup?: boolean;
}): { title: string; body: string } {
  if (errorMessage) {
    return { title: "Backlog unavailable", body: errorMessage };
  }
  if (isLoading) {
    return { title: "Loading backlog", body: "Fetching backlog items from your desktop." };
  }
  if (projectName && !hasBacklogGroup) {
    return {
      title: "No backlog for this project",
      body: `The paired desktop sent no backlog for ${projectName}. It may not have a backlog/ directory — or the backlog may be under another project in the header.`,
    };
  }
  if (projectName) {
    return {
      title: "No backlog items",
      body: `${projectName} has no backlog items yet. Capture ideas under backlog/ on the desktop, or switch project from the header.`,
    };
  }
  return {
    title: "No backlog items",
    body: "Workspaces on the paired desktop have no backlog items yet. Capture ideas under backlog/ on the desktop and they will appear here.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lastPathSegment(path: string): string {
  const cleaned = path.trim().replace(/\/+$/u, "");
  return cleaned.split("/").filter(Boolean).at(-1) ?? cleaned;
}

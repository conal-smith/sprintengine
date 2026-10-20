import type { ConversationThread } from "../../api/conversationWire";
import type { MobileSession } from "../../api/types";
import type { DesktopWorkspace } from "../../api/tailnetWorkspaces";
import { conversationCanOperate, conversationEnabled, conversationOffered, DEFAULT_MODEL_ID, modelLabel } from "./conversationLogic";
import { cliForChatProvider } from "./launchLogic";

// Where it lived first; the launch rules need it too, without importing this file.
export { cliForChatProvider };

// The Chats list, as rules: which mark a row wears, what its trailing seat
// says, which surface it draws, and whether it sits under "Earlier". Kept free
// of React Native so the regression suite runs the same rules the screen does.

/** One listed chat and where it lives. */
export interface ChatListRow {
  deviceId: string;
  desktopName: string;
  /**
   * The project's name, when the desktop's workspace list could be read; the
   * pill is omitted otherwise. A chat in one of the project's worktrees wears
   * the project's name, with `worktree` saying it runs in one.
   */
  projectName: string | null;
  /** The worktree's name when the chat's folder is one of its project's worktrees ("pool-02"). */
  worktree?: string | null;
  /**
   * The workspace's own name: the chat's title summary ("WSL agent access
   * issue"), the line the desktop's sidebar leads with. Null when the
   * workspace list could not be read.
   */
  workspaceTitle?: string | null;
  /** What groups chats into one project (repository, else folder); see `DesktopWorkspace.projectKey`. */
  projectKey?: string | null;
  /** The project's hue from the desktop, or null to draw the folder in the resting ink. */
  projectHue?: number | null;
  /** How many listed chats share this chat's workspace, itself included. */
  workspaceChats?: number;
  /**
   * Whether the chat's desktop advertises `conversation-lifecycle`: its list
   * carries the chat's clocks, and it takes Settle and visit stamps.
   */
  lifecycle?: boolean;
  /** Whether this phone may settle the chat: a lifecycle desktop, and a pairing that operates its chats. */
  settleable?: boolean;
  /**
   * Whether this phone may mark the chat unread: a desktop that advertises
   * `chat-mark-unread`, and a pairing that operates its chats. Where it is
   * offered is `markUnreadOffered`'s to say.
   */
  canMarkUnread?: boolean;
  thread: ConversationThread;
}

/**
 * What a row is called. The title summary leads, never the agent's name: a
 * list of "Dara Clune", "Oscar Doran" says nothing about what any of them is
 * doing. The summary is the chat's title as the
 * desktop's sidebar shows it, where the desktop lists one (`chatTitle`), else
 * the workspace's name. The agent's name joins only when a workspace holds
 * more than one chat, where it is what tells them apart, as a tab's name does
 * on the desktop. A desktop that gave neither leaves the thread's own title,
 * which is the best there is.
 */
export function chatRowTitle(row: ChatListRow): { title: string; agent: string | null } {
  const agentName = row.thread.title.trim();
  const summary = row.thread.chatTitle?.trim() || row.workspaceTitle?.trim();
  if (!summary) return { title: agentName || "Chat", agent: null };
  const agent = (row.workspaceChats ?? 1) > 1 && agentName && agentName !== summary ? agentName : null;
  return { title: summary, agent };
}

/**
 * Whether a chat whose turn is over still has work going: an agent it
 * launched in the background, or a monitor that will wake its agent, as the
 * desktop lists them (`backgroundWork`). The desktop's sidebar counts such a
 * chat as working, and so does the list here; it is never a turn, so nothing
 * that holds a send while a turn runs reads it. A chat waiting on the person,
 * or one that failed, says that first. An older desktop lists none, and the
 * chat reads as at rest, as it always did.
 */
export function chatWorksInBackground(thread: Pick<ConversationThread, "phase" | "backgroundWork">): boolean {
  return (thread.phase === "completed" || thread.phase === "idle") && !!thread.backgroundWork;
}

/**
 * The last line's words, the sidebar's: what the chat is doing, beside its
 * CLI's logo and model. Working reads "Thinking" (the desktop names the
 * running tool there, which the chat list does not carry yet); waiting says
 * what for. A resting chat says nothing: the logo and the model pill are the
 * agent information, and "Claude Code" in words beside Claude's logo said it
 * twice.
 */
export type ChatActivity = { tone: "working" | "warn" | "failed" | "quiet"; text: string };

export function chatActivity(thread: ConversationThread): ChatActivity {
  if (chatWorksInBackground(thread)) return { tone: "working", text: "Working in background" };
  switch (thread.phase) {
    case "running":
      return { tone: "working", text: "Thinking" };
    case "starting":
      return { tone: "working", text: "Starting" };
    case "waiting_for_approval":
      return { tone: "warn", text: "Needs approval" };
    case "waiting_for_input":
      return { tone: "warn", text: "Asked a question" };
    case "failed":
      return { tone: "failed", text: "Failed" };
    default:
      return { tone: "quiet", text: "" };
  }
}

/** The model as its pill names it, beside the CLI's logo: "Opus 5.5", or "Default". */
export function chatModelName(thread: ConversationThread): string {
  if (!thread.modelId || thread.modelId === DEFAULT_MODEL_ID) return "Default";
  return modelLabel(thread);
}

/** Chats under their project, as the desktop sidebar's project view shows them. */
export interface ChatProjectGroup {
  key: string;
  projectName: string;
  projectHue: number | null;
  rows: ChatListRow[];
}

/**
 * The project view: one group per project, the one last written in first.
 * A group sits where its most recently messaged chat puts it, and a chat
 * waiting on you does not lift its project: as on the desktop, a state tints
 * a row and never moves it. Inside each, chats keep
 * the recent list's order. A chat with no project (no folder, or a list that
 * could not be read) goes under "Other".
 */
export function groupChatsByProject(rows: readonly ChatListRow[], now: number): ChatProjectGroup[] {
  const groups = new Map<string, ChatProjectGroup>();
  for (const row of rows) {
    const key = `${row.deviceId}|${row.projectKey ?? row.projectName ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, projectName: row.projectName ?? "Other", projectHue: row.projectHue ?? null, rows: [] };
      groups.set(key, group);
    }
    if (group.projectHue === null && row.projectHue != null) group.projectHue = row.projectHue;
    group.rows.push(row);
  }
  const latest = (group: ChatProjectGroup) => Math.max(...group.rows.map(chatRecencyAt));
  const list = [...groups.values()];
  for (const group of list) {
    const { recent, earlier } = chatSections(group.rows, now);
    group.rows = [...recent, ...earlier];
  }
  return list.sort((a, b) => latest(b) - latest(a));
}

/**
 * Where a chat sits in every list: when the person last sent it a message,
 * the desktop's ordering key. A chat moves when someone says something in it
 * and never because an agent finished, a session restarted or a clock ticked.
 *
 * A lifecycle desktop's chat with no message yet counts from when it was
 * made, as the desktop counts it. An older desktop sends no message clock at
 * all, and there `updatedAt`, the only clock it lists, is the best there is.
 */
export function chatRecencyAt(row: Pick<ChatListRow, "thread" | "lifecycle">): number {
  const { thread } = row;
  return thread.lastUserMessageAt ?? (row.lifecycle ? thread.createdAt : thread.updatedAt);
}

/**
 * When the chat last came to rest, for the bare time on a resting row: when
 * its last turn ended, from a desktop that lists it. An older desktop lists no
 * turn clock, and there it is `updatedAt` as before.
 */
export function chatRestingAt(thread: Pick<ConversationThread, "lastTurnEndedAt" | "updatedAt">): number {
  return thread.lastTurnEndedAt ?? thread.updatedAt;
}

/**
 * One desktop's chat list as rows: each thread with its workspace's project,
 * name and hue, less every chat that is settled. A lifecycle desktop already
 * leaves settled chats off its list; a workspace the workspace list marks
 * settled is dropped here as well, so a chat settled between the two reads,
 * or by a desktop mid-update, never reaches the list or a project group.
 */
export function buildChatRows(input: {
  deviceId: string;
  desktopName: string;
  threads: readonly ConversationThread[];
  workspaces: readonly DesktopWorkspace[] | null;
  lifecycle: boolean;
  canOperate: boolean;
  /** Whether the desktop advertises `chat-mark-unread`. */
  markUnread?: boolean;
}): ChatListRow[] {
  const byId = new Map((input.workspaces ?? []).map((workspace) => [workspace.workspaceId, workspace]));
  const listed: ChatListRow[] = [];
  for (const thread of input.threads) {
    const workspace = byId.get(thread.workspaceId);
    if (workspace?.settledAt != null) continue;
    listed.push({
      deviceId: input.deviceId,
      desktopName: input.desktopName,
      projectName: workspace?.projectName ?? null,
      worktree: workspace?.worktree ?? null,
      workspaceTitle: workspace?.name ?? null,
      projectKey: workspace?.projectKey ?? null,
      projectHue: workspace?.projectHue ?? null,
      lifecycle: input.lifecycle,
      settleable: input.lifecycle && input.canOperate,
      canMarkUnread: !!input.markUnread && input.canOperate,
      thread,
    });
  }
  const counts = countWorkspaceChats(listed);
  return listed.map((row) => ({ ...row, workspaceChats: counts.get(chatWorkspaceKey(row)) ?? 1 }));
}

/** How many listed chats each workspace holds, keyed as `chatWorkspaceKey` does. */
export function countWorkspaceChats(rows: readonly ChatListRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = chatWorkspaceKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export const chatWorkspaceKey = (row: { deviceId: string; thread: Pick<ConversationThread, "workspaceId"> }) =>
  `${row.deviceId}|${row.thread.workspaceId}`;

/** One project New may start a chat in: a folder, asked about through one of its workspaces. */
export interface PickableProject {
  /** Stable across reads: the normalised path of the project's folder. */
  key: string;
  projectName: string;
  /** The project's own folder. */
  folderPath: string;
  /**
   * The workspace the project is asked about with: one in the project's own
   * folder where there is one, else one of its worktrees; the lowest id of
   * those, so a re-read does not move it.
   */
  workspaceId: string;
  /**
   * The worktree that workspace runs in, when the project has no workspace in
   * its own folder: a chat started without a worktree of its own starts there.
   */
  worktree: string | null;
  /** The desktop's usage score for the folder, when it sends one (`DesktopWorkspace.projectFrecency`). */
  frecency?: number;
  /** The desktop's latest new chat in the folder, epoch ms, when it sends one. */
  lastUsedAt?: number | null;
}

/**
 * When this phone last chose each project on New, per desktop: by device id,
 * then by the folder key `pickableProjects` gives (`PickableProject.key`),
 * epoch ms. The order New falls back to when the desktop sends no usage.
 */
export type ProjectPicks = Record<string, Record<string, number>>;

/** At most this many projects are remembered per desktop; the oldest picks fall off. */
export const PROJECT_PICKS_LIMIT = 50;

/**
 * Step one of New, folded out of `workspace.list`. That list is the desktop's
 * open WORKSPACES, and a workspace is a chat, so drawn raw it was one row per
 * chat: "wingfoil" seven times over. A project is a folder, as it is in the
 * desktop's own remote project picker (`remoteProjectsOf`), and a chat in one
 * of the project's worktrees ("pool-02") is the project's, as the desktop's
 * sidebar files it, not a project of its own.
 *
 * Folded by the project's folder and not by `projectKey`: another clone of
 * the repository shares its key and is a different checkout on disk, and
 * merging the two would start the chat in whichever folder happened to win.
 * A workspace with no folder is dropped, since there is nowhere for a new
 * chat to run in it.
 *
 * Listed with the projects used most first, as New chat on
 * the desktop lists them. The desktop is the one that knows: it counts every
 * new chat, its own and this phone's, as a use, and sends each folder's score
 * (`projectFrecency`), a count of uses that halves every week. A desktop
 * that sends no score leaves the order to `picks`, this phone's own choices on
 * New, most recent first. Projects never used, or never picked, keep the
 * alphabetical order below them.
 */
export function pickableProjects(
  workspaces: readonly (Pick<
    DesktopWorkspace,
    "workspaceId" | "projectName" | "folderPath" | "projectFrecency" | "projectLastUsedAt"
  > &
    Partial<Pick<DesktopWorkspace, "projectFolder" | "worktree">>)[],
  picks?: Readonly<Record<string, number>> | null,
): PickableProject[] {
  const byFolder = new Map<string, PickableProject>();
  let desktopScores = false;
  for (const workspace of workspaces) {
    const folderPath = workspace.folderPath?.trim();
    if (!folderPath) continue;
    const projectFolder = workspace.projectFolder?.trim() || folderPath;
    const worktree = workspace.worktree ?? null;
    const key = projectFolderKey(projectFolder);
    const existing = byFolder.get(key);
    const project = existing ?? {
      key,
      projectName: workspace.projectName,
      folderPath: projectFolder,
      workspaceId: workspace.workspaceId,
      worktree,
    };
    if (!existing) byFolder.set(key, project);
    else {
      // The project's own folder over any worktree of it, then the lowest id.
      const own = worktree === null;
      const existingOwn = existing.worktree === null;
      if ((own && !existingOwn) || (own === existingOwn && workspace.workspaceId < existing.workspaceId)) {
        existing.workspaceId = workspace.workspaceId;
        existing.worktree = worktree;
      }
    }
    // Every workspace in a folder carries the folder's score; take the
    // highest, so one row read at a different moment cannot pull it down.
    if (typeof workspace.projectFrecency === "number") {
      desktopScores = true;
      project.frecency = Math.max(project.frecency ?? 0, workspace.projectFrecency);
      project.lastUsedAt = Math.max(project.lastUsedAt ?? 0, workspace.projectLastUsedAt ?? 0) || null;
    }
  }
  const alphabetical = [...byFolder.values()].sort(
    (a, b) => a.projectName.localeCompare(b.projectName) || a.folderPath.localeCompare(b.folderPath),
  );
  // Array.prototype.sort is stable, so a tie keeps the alphabetical order.
  if (desktopScores) {
    return alphabetical.sort(
      (a, b) => (b.frecency ?? 0) - (a.frecency ?? 0) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
    );
  }
  if (!picks) return alphabetical;
  return alphabetical.sort((a, b) => (picks[b.key] ?? 0) - (picks[a.key] ?? 0));
}

/** The folder key New's projects are folded and remembered by: forward slashes, no trailing slash, lower case. */
export function projectFolderKey(folderPath: string): string {
  return folderPath.trim().replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
}

/** `picks` with `projectKey` chosen on `deviceId` at `at`, the oldest dropped past the limit. Pure. */
export function recordProjectPick(picks: ProjectPicks, deviceId: string, projectKey: string, at: number): ProjectPicks {
  if (!deviceId || !projectKey) return picks;
  const entries = Object.entries({ ...picks[deviceId], [projectKey]: at })
    .sort((a, b) => b[1] - a[1])
    .slice(0, PROJECT_PICKS_LIMIT);
  return { ...picks, [deviceId]: Object.fromEntries(entries) };
}

/** Stored picks, fail-soft: anything that is not a device's map of folder to time is dropped. */
export function normalizeProjectPicks(value: unknown): ProjectPicks {
  const picks: ProjectPicks = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return picks;
  for (const [deviceId, entries] of Object.entries(value)) {
    if (!deviceId || !entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    const kept: Record<string, number> = {};
    for (const [key, at] of Object.entries(entries)) {
      if (key && typeof at === "number" && Number.isFinite(at)) kept[key] = at;
    }
    picks[deviceId] = kept;
  }
  return picks;
}

/**
 * The mark a chat wears: the CLI it rides, as the desktop's
 * `conversationLineMark` draws it. Claude wears its own mark; any other CLI a neutral
 * tile with the prompt, the name reaching the screen reader through `label`.
 * A provider that is not a CLI at all (an API-key provider) has no CLI to show
 * and takes its own initial.
 */
export type ChatCliMark =
  | { kind: "claude"; cli: string; label: string }
  | { kind: "cli"; cli: string; label: string; mark: string }
  | { kind: "chat"; label: string; mark: string };

export function chatCliMark(thread: Pick<ConversationThread, "providerId" | "models">): ChatCliMark {
  const cli = thread.models?.cli?.trim() || cliForChatProvider(thread.providerId);
  if (!cli) {
    const initial = thread.providerId.trim().charAt(0).toUpperCase();
    return { kind: "chat", label: "Chat", mark: initial || "C" };
  }
  const label = thread.models?.cliLabel?.trim() || titleCase(cli);
  if (isClaudeCli(cli)) return { kind: "claude", cli, label };
  return { kind: "cli", cli, label, mark: ">_" };
}


/** CLIs that ship Anthropic's own mark, so a row can wear it rather than an initial. */
export function isClaudeCli(cli: string | null): boolean {
  return cli === "claude-code" || cli === "claude" || cli === "kimi-claude";
}

function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The row's surface.
 *
 * - `needs-input` — the gold wash: an approval or a question is waiting.
 * - `working` — no surface; the seat's working mark and timer carry it.
 * - `finished` — the green wash, for a chat that finished a turn nobody has
 *   seen yet, and only within the last day: a chat that finished on Saturday
 *   is history, not news, whether or not it was ever opened. Unless the
 *   person marked it unread: that is theirs, and it shows at any age. See
 *   `chatHasUnseenTurn`.
 * - `failed` — no surface either; the seat's error shape and word say it.
 * - `idle` — nothing to say beyond when.
 */
export type ChatRowState = "needs-input" | "working" | "finished" | "failed" | "idle";

/** A chat at rest longer ago than this moves under "Earlier". */
export const CHAT_EARLIER_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the attention rule reads off a listed chat. */
export type ChatAttentionThread = Pick<
  ConversationThread,
  "phase" | "updatedAt" | "lastTurnEndedAt" | "lastVisitedAt" | "visitRewoundAt" | "backgroundWork"
>;

export interface ChatAttentionInput {
  now: number;
  /** When this phone last opened the chat, by `chatOpenedKey`. */
  openedAt?: number | null;
  /** Whether the chat's desktop advertises `conversation-lifecycle`; see `ChatListRow.lifecycle`. */
  lifecycle?: boolean;
}

/**
 * When the chat's last turn ended, as far as the list can tell, or null when
 * no turn has.
 *
 * A lifecycle desktop lists the turn clock itself (`lastTurnEndedAt`), and a
 * chat it lists without one has never finished a turn. An older desktop lists
 * only `updatedAt`, which also moves on a rename, a session starting or
 * stopping, a usage report and a restart; there it is still the best there is.
 */
export function chatTurnEndedAt(thread: ChatAttentionThread, lifecycle = false): number | null {
  if (thread.lastTurnEndedAt !== undefined) return thread.lastTurnEndedAt;
  return lifecycle ? null : thread.updatedAt;
}

/**
 * When a person last saw the chat: the later of this phone opening it and
 * anyone having it on screen anywhere, the desktop included (`lastVisitedAt`).
 *
 * Except that a Mark unread made after this phone last opened the chat wins
 * over that opening: the chat carries the mark's time (`visitRewoundAt`, as
 * the desktop lists it or as `withVisitRewind` folds in one this phone knows
 * of), and an opening before it no longer counts. Taking the later of the two
 * regardless would keep the chat read here after it was marked unread.
 */
export function chatSeenAt(
  thread: Pick<ConversationThread, "lastVisitedAt" | "visitRewoundAt">,
  openedAt?: number | null,
): number {
  const rewoundAt = thread.visitRewoundAt;
  const opened = openedAt != null && (rewoundAt === undefined || openedAt > rewoundAt) ? openedAt : 0;
  return Math.max(opened, thread.lastVisitedAt ?? 0);
}

/**
 * Whether the chat stands marked unread: it carries a Mark unread
 * (`visitRewoundAt`, the desktop's, this phone's own, or one inferred from
 * the visit clock going back, as `withVisitRewind` folds them in) and nobody
 * has seen it since, here or anywhere. Opening it reads it, and the mark is
 * gone.
 */
export function chatMarkedUnread(
  thread: Pick<ConversationThread, "lastVisitedAt" | "visitRewoundAt">,
  openedAt?: number | null,
): boolean {
  const rewoundAt = thread.visitRewoundAt;
  return rewoundAt !== undefined && chatSeenAt(thread, openedAt) <= rewoundAt;
}

/**
 * The one "finished, unseen" rule, which the list's green reads, and the
 * bell's finished notice within its day: a completed chat whose last turn
 * ended after anyone last saw it, within the last day. Strictly after: a turn
 * that ended in the same millisecond the chat was seen is one the person
 * watched end.
 *
 * A chat the person marked unread (`chatMarkedUnread`) is unread at any age:
 * the day is there so an old finish nobody looked at is not news, and a mark
 * is the person asking for exactly that chat to read as new. Without it a
 * chat under Earlier took the mark and showed nothing.
 */
export function chatHasUnseenTurn(thread: ChatAttentionThread, input: ChatAttentionInput): boolean {
  // Not finished while it works in the background: its news is when that ends.
  if (thread.phase !== "completed" || chatWorksInBackground(thread)) return false;
  const ended = chatTurnEndedAt(thread, input.lifecycle);
  if (ended === null || ended <= chatSeenAt(thread, input.openedAt)) return false;
  return input.now - ended < CHAT_EARLIER_AFTER_MS || chatMarkedUnread(thread, input.openedAt);
}

export function chatRowState(thread: ChatAttentionThread, input: ChatAttentionInput): ChatRowState {
  if (chatWorksInBackground(thread)) return "working";
  switch (thread.phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return "needs-input";
    case "running":
    case "starting":
      return "working";
    case "failed":
      return "failed";
    case "completed":
      return chatHasUnseenTurn(thread, input) ? "finished" : "idle";
    default:
      return "idle";
  }
}

/** "38s", "4m 12s", "1h 4m": the working timer, precise enough to see it move. */
export function formatChatElapsed(since: number, now: number): string {
  if (!Number.isFinite(since)) return "";
  const seconds = Math.floor(Math.max(0, now - since) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * When a settled chat last moved, bare: "now", "2m", "3h", then the weekday
 * for this week ("Sat") and the date beyond it ("12 Sep"). No "ago": the seat
 * is a time, like a mail list's, and the word would push the title.
 */
export function formatChatSettledAt(at: number, now: number): string {
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const date = new Date(at);
  if (diff < 6 * CHAT_EARLIER_AFTER_MS) return WEEKDAYS[date.getDay()];
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * Recent first, then "Earlier" for chats last written in more than a day ago,
 * each in the order the person last messaged them (`chatRecencyAt`), newest
 * first. A state tints a row and never moves it: a chat that starts waiting on
 * you or finishes a turn stays where it was, as it does in the desktop's
 * sidebar: chats stay put, ordered by when you last sent them a message. Working and waiting chats never
 * go under Earlier, however long ago they were written in: they are not at
 * rest, and a chat asking for something stays in view.
 */
export function chatSections(
  rows: readonly ChatListRow[],
  now: number,
): { recent: ChatListRow[]; earlier: ChatListRow[] } {
  const recent: ChatListRow[] = [];
  const earlier: ChatListRow[] = [];
  for (const row of rows) {
    const phase = row.thread.phase;
    const live =
      phase === "running" ||
      phase === "starting" ||
      phase === "waiting_for_approval" ||
      phase === "waiting_for_input" ||
      chatWorksInBackground(row.thread);
    if (!live && now - chatRecencyAt(row) > CHAT_EARLIER_AFTER_MS) earlier.push(row);
    else recent.push(row);
  }
  // Array.prototype.sort is stable: chats on the same instant keep the order
  // the desktop listed them in.
  const newest = (a: ChatListRow, b: ChatListRow) => chatRecencyAt(b) - chatRecencyAt(a);
  recent.sort(newest);
  earlier.sort(newest);
  return { recent, earlier };
}

/** Search covers what the row shows: the title summary, the agent, the project, the machine and the CLI. */
export function matchesChatSearch(row: ChatListRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.thread.chatTitle, row.workspaceTitle, row.thread.title, row.projectName, row.desktopName, chatCliMark(row.thread).label].some((value) =>
    value?.toLowerCase().includes(needle),
  );
}

/**
 * Where a desktop's chat link (`parseChatLink`) leads among the chats listed
 * from every paired desktop. The link names a workspace and no desktop, so
 * each desktop listing it is a candidate: one is opened, several are offered,
 * none is said. On a desktop, the link's agent's chat where the workspace has
 * it, else the workspace's chat last written in, as the desktop opens the chat
 * as it was left when the agent is not there.
 */
export type ChatLinkTarget =
  | { kind: "none" }
  | { kind: "one"; row: ChatListRow }
  | { kind: "several"; rows: ChatListRow[] };

export function resolveChatLink(
  link: { workspaceId: string; agentId: string | null },
  rows: readonly ChatListRow[],
): ChatLinkTarget {
  const byDesktop = new Map<string, ChatListRow>();
  for (const row of rows) {
    if (row.thread.workspaceId !== link.workspaceId) continue;
    const held = byDesktop.get(row.deviceId);
    const better =
      !held ||
      (link.agentId !== null && row.thread.agentId === link.agentId && held.thread.agentId !== link.agentId) ||
      ((link.agentId === null || held.thread.agentId !== link.agentId) && chatRecencyAt(row) > chatRecencyAt(held));
    if (better) byDesktop.set(row.deviceId, row);
  }
  const found = [...byDesktop.values()];
  if (found.length === 0) return { kind: "none" };
  if (found.length === 1) return { kind: "one", row: found[0] };
  return { kind: "several", rows: found };
}

/**
 * The stack once a chat takes the top screen's place: a chat link's, or the
 * chat on screen when the person goes on to another. Back from it returns to
 * what was under that screen, and to the list when nothing was, as on a link
 * that started the app.
 */
export function routesInPlaceOfTop<R extends { name: string }, C, H>(routes: readonly R[], chat: C, home: H): (R | C | H)[] {
  const below = routes.slice(0, -1);
  return [...(below.length ? below : [home]), chat];
}

/**
 * The key a chat's "opened" moment is kept under in the device notes. The
 * device keeps two desktops' chats apart, since an agent id is only unique
 * within the desktop that made it.
 */
export function chatOpenedKey(deviceId: string, agentId: string): string {
  return `chat:${deviceId}:${agentId}`;
}

/**
 * Whether this pairing may read the desktop's projects (`workspace.list`,
 * `cli.runtime.list`). The gateway's rule is that operate implies read within
 * a family, so either grant will do.
 */
export function canReadWorkspaces(session: Pick<MobileSession, "status" | "tailnetScopes">): boolean {
  if (session.status === "revoked") return false;
  return session.tailnetScopes.includes("workspace:read") || session.tailnetScopes.includes("workspace:operate");
}

/**
 * Whether New may start a chat on this desktop: it streams chats, this phone
 * may operate them, and it may read the projects step one lists.
 */
export function canStartChats(session: MobileSession): boolean {
  return conversationCanOperate(session) && canReadWorkspaces(session);
}

/**
 * Whether New may offer a chat on this desktop, and if not, the one line that
 * says why. The desktop has to stream chats at all, and this phone's grant has
 * to include operating them.
 */
export type ChatLaunchAvailability = { available: true } | { available: false; reason: string };

export function chatLaunchAvailability(
  session: MobileSession | null,
  input: { machineName: string },
): ChatLaunchAvailability {
  const machine = input.machineName.trim() || "This desktop";
  if (!session || !conversationOffered(session)) {
    return { available: false, reason: `${machine} does not stream chats yet. Update SprintEngine Studio there to start one.` };
  }
  if (!conversationEnabled(session)) {
    return { available: false, reason: `This phone may not use chats on ${machine}. Pair again with chat control.` };
  }
  if (!conversationCanOperate(session)) {
    return { available: false, reason: `This phone may read chats on ${machine} but not start them. Pair again with chat control.` };
  }
  return { available: true };
}

import { presentToolItem } from "../../api/conversation-protocol/presentation";
import type { AgentLane } from "./agentLogic";
import { toolPicture, type ToolPicture } from "./conversationImageLogic";
import { recordValue, stringValue, type ConversationRow, type MobileTool } from "./conversationLogic";
import type { SentImage } from "./sentPhotos";

// What the agent touched in one chat, read off the rows the phone already
// projects: the rows of the chat's page, which its title pill opens. The
// desktop's card lists the same things (`agentChat/chatActivity.ts`), in the
// same order: each the first time the agent touched it, and the Library, what
// came out of the run, last. No react-native import, so `node --test` can pin
// it.

export type ChatActivityKind = "changes" | "agents" | "browser" | "canvas" | "library";

/** A picture a step made or read, as the transcript draws it. */
export type StepPicture = { tool: MobileTool; picture: ToolPicture };

export type ChatActivity = {
  order: ChatActivityKind[];
  /** An edit is running now. */
  editing: boolean;
  agents: { total: number; working: number } | null;
  browser: { live: boolean; url: string | null } | null;
  canvas: { live: boolean; board: string | null } | null;
  /** The pictures the person sent, oldest first. */
  sent: SentImage[];
  /** The pictures the agent's steps made or read, newest first. */
  steps: StepPicture[];
};

/** The app's own MCP server: only its browser and canvas tools drive the desktop's tabs. */
const STUDIO_SERVER = "sprintengine-studio";

/**
 * The tool's name with its server prefix taken off, for one of the app's own
 * tools: `mcp__sprintengine-studio__browser_open` and
 * `sprintengine-studio.browser_open` both read `browser_open`. Null for any
 * other server's.
 */
export function studioToolName(tool: Pick<MobileTool, "name" | "serverName">): string | null {
  if (tool.serverName !== STUDIO_SERVER && !tool.name.includes(STUDIO_SERVER)) return null;
  return tool.name.split(/__|[./]/u).at(-1) ?? tool.name;
}

function toolsOf(row: ConversationRow): MobileTool[] {
  if (row.kind === "tools") return row.tools;
  if (row.kind === "fold") return row.parts.flatMap((part) => (part.kind === "tools" ? part.tools : []));
  return [];
}

const EDIT_ICONS = new Set(["file_edit", "file_write"]);

export function phoneChatActivity(rows: readonly ConversationRow[], lanes: readonly AgentLane[]): ChatActivity {
  const order: ChatActivityKind[] = [];
  const touch = (kind: ChatActivityKind) => {
    if (!order.includes(kind)) order.push(kind);
  };
  let editing = false;
  let browser: ChatActivity["browser"] = null;
  let canvas: ChatActivity["canvas"] = null;
  const sent: SentImage[] = [];
  const steps: StepPicture[] = [];

  for (const row of rows) {
    if (row.kind === "message" && row.images?.length) sent.push(...row.images);
    if (row.kind === "diff") touch("changes");
    if (row.kind === "agent") touch("agents");
    for (const tool of toolsOf(row)) {
      const running = tool.status === "running";
      const studio = studioToolName(tool);
      const input = recordValue(tool.input);
      if (EDIT_ICONS.has(presentToolItem(tool).icon)) {
        touch("changes");
        if (running) editing = true;
      } else if (studio?.startsWith("browser_")) {
        touch("browser");
        const seen = browser as ChatActivity["browser"];
        browser = { live: running || Boolean(seen?.live), url: stringValue(input.url).trim() || seen?.url || null };
      } else if (studio?.startsWith("canvas_")) {
        touch("canvas");
        const seen = canvas as ChatActivity["canvas"];
        canvas = { live: running || Boolean(seen?.live), board: stringValue(input.board).trim() || seen?.board || null };
      }
      const picture = toolPicture(tool);
      if (picture) steps.push({ tool, picture });
    }
  }

  const working = lanes.filter((lane) => lane.status === "running").length;
  if (lanes.length) touch("agents");
  if (sent.length || steps.length) touch("library");
  // The Library is what came out of the run, not a place the agent worked: last.
  const placed = order.filter((kind) => kind !== "library");
  return {
    order: order.includes("library") ? [...placed, "library"] : placed,
    editing,
    agents: lanes.length ? { total: lanes.length, working } : null,
    browser,
    canvas,
    sent,
    steps: steps.reverse(),
  };
}

/** The page host a URL names, for the Browser row: "localhost:5173". */
export function urlHost(url: string | null): string | null {
  if (!url) return null;
  const match = /^(?:[a-z]+:\/\/)?([^/?#]+)/iu.exec(url.trim());
  return match?.[1] ?? url;
}

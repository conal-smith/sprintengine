import type { DesktopWorkspace, WorkspacesApi } from "../api/tailnetWorkspaces";
import { readCliRuntimes } from "../features/conversations/launchLogic";
import { workspaceProject } from "../features/projects/worktreeProjectLogic";
import { verifySettledAt } from "./fakeConversations";

// A fake of the gateway's workspace and CLI reads for the screenshot harness,
// in the shapes `workspace.list` and `cli.runtime.list` return, so the chat
// list's project pills, step one of New and New's model picker draw exactly as
// they would against a real desktop. Never bundled into the app (see index.js
// / App.tsx).
//
// The CLIs are what a desktop that advertises `cli-runtime-catalog` answers,
// read through the app's own parse: Claude Code with a model at two context
// windows (Opus 5.5 and its 1M) and one marked New (Fable 5), Codex with
// effort levels, a runtime hosted on Claude Code, and one that cannot run as
// a chat, which New leaves off its rail.
//
// The Docs chat runs in one of the mobile project's pooled worktrees, as
// the desktop's New chat starts one by default: it lists under mobile
// with the worktree's mark, and New's projects fold its folder into the
// project. Another pooled worktree of multicode has a workspace and no chat.
const CLI_RUNTIMES = readCliRuntimes({
  clis: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      agentSelectable: true,
      supportsModelSelection: true,
      models: [
        { id: "claude-opus-5-5", label: "Opus 5.5" },
        { id: "opus[1m]", label: "Opus (latest, 1M context)" },
      ],
      reasoningLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra high" },
        { id: "max", label: "Max" },
      ],
      defaultReasoningLevel: "high",
      permissionPresets: ["manual", "auto", "bypass", "none"],
      catalog: {
        conversational: true,
        hostedVia: null,
        providerLabel: "Claude Code",
        allowCustomModelId: true,
        models: [
          { id: "claude-opus-5-5", label: "Opus 5.5", family: "claude-opus-5-5", familyDefault: true, contextLabel: "Standard", origin: "discovered" },
          { id: "claude-opus-5-5[1m]", label: "Opus 5.5 (1M context)", family: "claude-opus-5-5", familyDefault: false, contextLabel: "1M", origin: "discovered" },
          { id: "claude-sonnet-5-5", label: "Sonnet 5.5", family: "claude-sonnet-5-5", familyDefault: true, contextLabel: "Standard", origin: "discovered" },
          { id: "claude-fable-5", label: "Fable 5", family: "claude-fable-5", familyDefault: true, contextLabel: "Standard", isNew: true, origin: "discovered" },
          { id: "claude-haiku-4-5", label: "Haiku 4.5", family: "claude-haiku-4-5", familyDefault: true, contextLabel: "Standard", origin: "discovered" },
          { id: "opus[1m]", label: "Opus (latest, 1M context)", family: "opus", familyDefault: true, contextLabel: "1M", origin: "manifest" },
        ],
      },
    },
    {
      id: "codex",
      displayName: "Codex",
      agentSelectable: true,
      supportsModelSelection: true,
      models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
      reasoningLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra high" },
      ],
      defaultReasoningLevel: "medium",
      permissionPresets: ["none", "auto", "bypass"],
      catalog: {
        conversational: true,
        hostedVia: null,
        providerLabel: "Codex",
        allowCustomModelId: false,
        models: [
          { id: "gpt-5.5", label: "GPT-5.5", family: "gpt-5.5", familyDefault: true, contextLabel: "Standard", origin: "manifest" },
          { id: "gpt-5.5-codex", label: "GPT-5.5 Codex", family: "gpt-5.5-codex", familyDefault: true, contextLabel: "Standard", origin: "discovered" },
        ],
      },
    },
    {
      id: "kimi-claude",
      displayName: "Kimi K3",
      agentSelectable: true,
      supportsModelSelection: false,
      models: [],
      catalog: { conversational: true, hostedVia: "claude-code", providerLabel: "Kimi K3 · via Claude Code", allowCustomModelId: false, models: [] },
    },
    {
      id: "aider",
      displayName: "Aider",
      agentSelectable: true,
      supportsModelSelection: true,
      models: [{ id: "sonnet", label: "Sonnet" }],
      catalog: { conversational: false, hostedVia: null, providerLabel: "Aider", allowCustomModelId: true, models: [] },
    },
  ],
});

/** A listed workspace as `listWorkspaces` reads one: its project from its folder. */
function listed(entry: Omit<DesktopWorkspace, "projectName" | "projectFolder" | "worktree">): DesktopWorkspace {
  const project = workspaceProject({ folderPath: entry.folderPath });
  return {
    ...entry,
    projectName: project.projectName ?? entry.name,
    projectFolder: project.projectFolder,
    worktree: project.worktree,
    settledAt: verifySettledAt.get(entry.workspaceId) ?? null,
  };
}

const POOLED_DOCS = "/Users/dev/code/.sprintengine-worktrees/mobile/pool-02";

export const fakeWorkspacesApi: WorkspacesApi = {
  async listCliRuntimes() {
    return { ok: true, data: CLI_RUNTIMES };
  },
  async listWorkspaces() {
    return {
      ok: true as const,
      // A settled workspace carries `settledAt`, which is what keeps its chat
      // off the phone's list even where the chat list still names it.
      data: [
        { workspaceId: "ws-mobile", name: "Mobile", folderPath: "/Users/dev/code/mobile", projectKey: "repo:github.com/acme/mobile", projectHue: 152 },
        { workspaceId: "ws-studio", name: "Studio", folderPath: "/Users/dev/code/multicode", projectKey: "repo:github.com/acme/multicode", projectHue: 262 },
        { workspaceId: "ws-docs", name: "Docs", folderPath: POOLED_DOCS, projectKey: "repo:github.com/acme/mobile", projectHue: 152 },
        { workspaceId: "ws-plan", name: "Pairing", folderPath: "/Users/dev/code/multicode", projectKey: "repo:github.com/acme/multicode", projectHue: 262 },
        { workspaceId: "ws-rich", name: "Diagrams", folderPath: "/Users/dev/code/multicode", projectKey: "repo:github.com/acme/multicode", projectHue: 262 },
        { workspaceId: "ws-rich-live", name: "Diagrams", folderPath: "/Users/dev/code/multicode", projectKey: "repo:github.com/acme/multicode", projectHue: 262 },
        { workspaceId: "ws-settled", name: "Icons", folderPath: "/Users/dev/code/mobile", projectKey: "repo:github.com/acme/mobile", projectHue: 152 },
        {
          workspaceId: "ws-pool",
          name: "Chat",
          folderPath: "/Users/dev/code/.sprintengine-worktrees/multicode/pool-01",
          projectKey: "repo:github.com/acme/multicode",
          projectHue: 262,
        },
      ].map(listed),
    };
  },
  async readCheckout(workspace) {
    // A pooled worktree is on its chat's branch; the main checkout, which a
    // new worktree is cut from, is on main.
    if (workspace.folderPath === POOLED_DOCS) {
      return { ok: true as const, data: { branch: "agent/chat-7f3a", worktree: "pool-02", mainBranch: "main" } };
    }
    return { ok: true as const, data: { branch: "main", worktree: null, mainBranch: "main" } };
  },
};

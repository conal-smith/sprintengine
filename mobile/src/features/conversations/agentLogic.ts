// The agents a chat sends off to work, as the phone reads them off the
// conversation's events: the lane each one gets in the transcript, the Agents
// screen's lists, and one agent's own thread. Ported from the studio's chat
// (subagentStatus.tsx, subagentResult.tsx and the Agents tab) so a lane says
// the same words on both surfaces.

import type { MobileTool } from "./conversationLogic";
import { formatTokenCount } from "./promptCache";

export type AgentState = "running" | "completed" | "failed" | "stopped" | "unknown";
export type AgentMessage = { at: number; text: string; truncated?: boolean };
/**
 * What the agent reported about itself. `unknown` is a background agent from
 * history recorded before its end was: it ran, but how it ended was never
 * written down.
 */
export type AgentReport = {
  state: AgentState;
  background?: boolean;
  subagentType?: string;
  description?: string;
  lastToolName?: string;
  progressSummary?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  error?: string;
};
/** One agent the chat spawned: its Task/Agent call, and everything reported about it since. */
export type AgentLane = {
  /** The spawning call's tool use id; every report about the agent names it. */
  id: string;
  turn: string;
  /** The lane this agent was spawned from, when an agent spawned it. */
  parentId?: string;
  subagentType?: string;
  /** What the model sent it to do. */
  task: string;
  status: "running" | "done";
  outcome?: "ok" | "error" | "stopped" | "declined";
  agent?: AgentReport;
  startedAt: number;
  completedAt?: number;
  /** What it came back with: the spawning call's own output, or a background agent's result. */
  report?: string;
  /** What it said between its steps, in order. */
  messages: AgentMessage[];
  /** The tool calls it made itself, in the order they started. */
  steps: MobileTool[];
};

// What Claude Code returns at once for an agent launched in the background.
// It is written for the model, never shown; the real result arrives later.
const BACKGROUND_LAUNCH_ACK = "Async agent launched successfully";
export function isBackgroundLaunchAck(output: unknown): boolean {
  return typeof output === "string" && output.trimStart().startsWith(BACKGROUND_LAUNCH_ACK);
}

const STATES = new Set(["running", "completed", "failed", "stopped"]);
/** A `subagent_status` payload, or null when it is malformed. */
export function readSubagentStatus(
  payload: unknown,
): (AgentReport & { toolUseId: string; endedAt?: number }) | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.toolUseId !== "string" || !record.toolUseId) return null;
  if (!STATES.has(record.status as string)) return null;
  const text = (key: string) =>
    typeof record[key] === "string" && record[key] ? (record[key] as string) : undefined;
  const usage =
    record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? (record.usage as Record<string, unknown>)
      : null;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    toolUseId: record.toolUseId,
    state: record.status as AgentState,
    ...(typeof record.background === "boolean" ? { background: record.background } : {}),
    ...(text("subagentType") ? { subagentType: text("subagentType") } : {}),
    ...(text("description") ? { description: text("description") } : {}),
    ...(text("lastToolName") ? { lastToolName: text("lastToolName") } : {}),
    ...(text("progressSummary") ? { progressSummary: text("progressSummary") } : {}),
    ...(text("error") ? { error: text("error") } : {}),
    ...(typeof record.endedAt === "number" ? { endedAt: record.endedAt } : {}),
    ...(usage
      ? {
          usage: {
            totalTokens: count(usage.totalTokens),
            toolUses: count(usage.toolUses),
            durationMs: count(usage.durationMs),
          },
        }
      : {}),
  };
}

/**
 * Fold a report into its lane. Running only ever updates what the agent is
 * doing: a lane closes on its result or a final status, and a late
 * progress report must not reopen one.
 */
export function applyAgentReport(lane: AgentLane, report: AgentReport, at: number): void {
  const merged: AgentReport = { ...lane.agent, ...report };
  if (report.state === "running" && lane.agent && lane.agent.state !== "running")
    merged.state = lane.agent.state;
  lane.agent = merged;
  if (!lane.subagentType && merged.subagentType) lane.subagentType = merged.subagentType;
  if (!lane.task && merged.description) lane.task = merged.description;
  if (merged.state === "running") return;
  lane.status = "done";
  lane.completedAt ??= at;
  if (merged.state === "failed") lane.outcome = "error";
  else if (merged.state === "stopped") lane.outcome ??= "stopped";
  else lane.outcome ??= "ok";
}

/** "Explore agent", or "Agent" when the call named no type. */
export function laneLabel(lane: Pick<AgentLane, "subagentType">): string {
  const type = lane.subagentType?.trim();
  return type ? `${type} agent` : "Agent";
}

export type AgentGlyphState = "working" | "done" | "failed" | "stopped" | "unknown";
export function laneGlyphState(lane: AgentLane): AgentGlyphState {
  if (lane.status === "running") return "working";
  if (lane.agent?.state === "failed" || lane.outcome === "error") return "failed";
  if (lane.agent?.state === "stopped" || lane.outcome === "stopped" || lane.outcome === "declined")
    return "stopped";
  if (lane.agent?.state === "unknown") return "unknown";
  return "done";
}

/**
 * How long a step or an agent took, on one clock: tenths under a second,
 * whole seconds under a minute, then minutes and seconds ("1m 29s"). A whole
 * minute drops its "0s".
 */
export function formatDuration(ms: number): string {
  if (ms < 950) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
  // Rounded once, before it is split: 1m 59.7s must not read "1m 60s".
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const rest = seconds % 60;
  return rest ? `${Math.floor(seconds / 60)}m ${rest}s` : `${Math.floor(seconds / 60)}m`;
}
/** A running clock: whole seconds from the first, since the first seconds are the interesting ones. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
/** "45k tokens", "900 tokens". */
export function formatTokens(count: number): string {
  return `${formatTokenCount(count)} tokens`;
}

function laneDurationMs(lane: AgentLane): number | undefined {
  if (lane.completedAt !== undefined) return Math.max(0, lane.completedAt - lane.startedAt);
  return lane.agent?.usage?.durationMs || undefined;
}

/**
 * Where an agent stands, in words and ink: "Working · 42s" in the accent
 * while it runs; "Done in 1m 29s", "Failed after 9s" (error ink), "Stopped
 * after 3m", or "Ran in the background" for one whose end was never recorded.
 */
export function laneStatus(
  lane: AgentLane,
  now: number,
): { text: string; tone: "working" | "failed" | "quiet" } {
  const state = laneGlyphState(lane);
  if (state === "working") return { text: `Working · ${formatElapsed(now - lane.startedAt)}`, tone: "working" };
  if (state === "unknown") return { text: "Ran in the background", tone: "quiet" };
  const duration = laneDurationMs(lane);
  const took = duration !== undefined ? formatDuration(duration) : undefined;
  if (lane.outcome === "declined") return { text: "Declined", tone: "quiet" };
  if (state === "failed") return { text: took ? `Failed after ${took}` : "Failed", tone: "failed" };
  if (state === "stopped") return { text: took ? `Stopped after ${took}` : "Stopped", tone: "quiet" };
  return { text: took ? `Done in ${took}` : "Done", tone: "quiet" };
}

/** What it is doing right now, while it runs: its own summary, else its latest tool. */
export function laneNow(lane: AgentLane): string {
  if (lane.status !== "running") return "";
  return lane.agent?.progressSummary ?? (lane.agent?.lastToolName ? `using ${lane.agent.lastToolName}` : "");
}

/** The report's first line of prose, with the markdown that opens it dropped. */
export function reportPreview(report: string | undefined): string {
  const line = report?.split(/\r?\n/u).find((candidate) => candidate.trim()) ?? "";
  return line
    .trim()
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/u, "")
    .replace(/^(\*\*|__)(.+)\1$/u, "$2")
    .trim();
}

/** The line under an agent in a list: what it is doing now, why it failed, or what it found. */
export function laneDetail(lane: AgentLane): { text: string; error: boolean } {
  if (lane.status === "running") {
    const now = laneNow(lane);
    return { text: now ? `Now: ${now}` : "", error: false };
  }
  if (lane.agent?.error) return { text: lane.agent.error, error: laneGlyphState(lane) === "failed" };
  return { text: reportPreview(lane.report), error: false };
}

/** How many steps it took: what it reported, else the calls seen. */
export function laneStepCount(lane: AgentLane): number {
  return lane.agent?.usage?.toolUses || lane.steps.length;
}

/**
 * Where an agent's own words go in its thread: each before the first step it
 * started after, as a turn's prose sits before the tools it explains, and the
 * rest after the last step. The last thing a finished agent says is its
 * report, which the thread shows as the report, so it is not said twice.
 */
export function placeAgentMessages(lane: AgentLane): {
  beforeSteps: { text: string; beforeToolUseId: string }[];
  afterSteps: string[];
} {
  const beforeSteps: { text: string; beforeToolUseId: string }[] = [];
  const afterSteps: string[] = [];
  for (const message of lane.messages) {
    const next = lane.steps.find((step) => step.startedAt !== undefined && step.startedAt > message.at);
    if (next) beforeSteps.push({ text: message.text, beforeToolUseId: next.id });
    else afterSteps.push(message.text);
  }
  const report = lane.report?.trim();
  const last = afterSteps.at(-1)?.trim();
  if (lane.status !== "running" && report && last && report.startsWith(last.slice(0, 200))) afterSteps.pop();
  return { beforeSteps, afterSteps };
}

/**
 * The Agents screen: the ones still working, then the finished ones newest
 * first, and the footer's totals ("2 working · 3 finished · 45k tokens").
 */
export function summarizeAgents(lanes: AgentLane[]): {
  working: AgentLane[];
  finished: AgentLane[];
  tokens: number;
  footer: string;
} {
  const working = lanes.filter((lane) => lane.status === "running");
  const finished = lanes.filter((lane) => lane.status !== "running").reverse();
  const tokens = lanes.reduce((sum, lane) => sum + (lane.agent?.usage?.totalTokens ?? 0), 0);
  const footer = [
    working.length ? `${working.length} working` : null,
    finished.length ? `${finished.length} finished` : null,
    tokens ? formatTokens(tokens) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { working, finished, tokens, footer };
}

/** The working line's words: "2 agents working" while agents run, else "Working". */
export function workingLabel(lanes: AgentLane[]): string {
  const running = lanes.filter((lane) => lane.status === "running").length;
  if (!running) return "Working";
  return `${running} ${running === 1 ? "agent" : "agents"} working`;
}

/**
 * The working line once the turn is over and something still works: "2
 * agents working in background", or "Working in background" for a monitor
 * that will wake the agent. The agents are the more of those the transcript
 * shows running and those the desktop lists (`listedAgents`), since either
 * may be ahead of the other.
 */
export function backgroundWorkLabel(lanes: AgentLane[], listedAgents = 0): string {
  const running = Math.max(lanes.filter((lane) => lane.status === "running").length, listedAgents);
  if (!running) return "Working in background";
  return `${running} ${running === 1 ? "agent" : "agents"} working in background`;
}

// Said for the agents every Claude session has, when the session has not
// described them itself.
const BUILT_IN_AGENT_TYPES: Record<string, string> = {
  Explore: "A read-only helper that searches the code and reports back.",
  Plan: "A read-only helper that works out an approach before anything changes.",
  "general-purpose":
    "A helper that takes on part of the task in parallel, with the same tools as the main agent.",
};
/** What an agent of this type is for, in a sentence, when anything says. */
export function agentTypeDescription(
  type: string | undefined,
  described: Record<string, string>,
): string | undefined {
  if (!type) return undefined;
  const text = described[type] ?? BUILT_IN_AGENT_TYPES[type];
  if (!text) return undefined;
  // A provider's description is written for the model choosing an agent and
  // runs long; its first sentence says what the agent is.
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/u.exec(text.trim())?.[0] ?? text.trim();
  return sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence;
}

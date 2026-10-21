// What a chat wears beside its title: the machine it runs on, and its pull
// request. Pure, so the regression suite reads the same rules the list row,
// the chat's header and New's context strip draw from.

import {
  CONVERSATION_LOCAL_HOST_ID,
  type ConversationHost,
  type ConversationPullRequest,
  type ConversationPullRequestState,
} from "../../api/conversationWire";
import {
  readMachineMark,
  type MachineColour,
  type MachineKind,
} from "../../components/glyphs/machineMarks";
import type { ThemeColors } from "../../theme/tokens";

/** A machine as a surface marks it: the drawing, the ink, and the name beside it. */
export interface MachineMarkView {
  /** The desktop's id for the machine (`wsl:Ubuntu`); for a test or a key, never shown. */
  id: string;
  kind: MachineKind;
  colour: MachineColour;
  label: string;
}

/**
 * The mark a chat's machine wears, or null for none.
 *
 * None when the desktop did not say where the chat runs (an older Studio): the
 * row then reads as it always has, and no colour is guessed. None for `local`
 * either, the desktop itself, which is the unmarked default on both apps: only
 * a chat that runs somewhere else (a WSL distribution, an SSH machine, another
 * paired machine) is marked.
 */
export function chatHostMark(host: ConversationHost | null | undefined): MachineMarkView | null {
  if (!host || host.id === CONVERSATION_LOCAL_HOST_ID) return null;
  const mark = readMachineMark(host);
  return mark ? { id: host.id, label: host.label, ...mark } : null;
}

/**
 * The mark a paired desktop wears where the phone chooses between desktops
 * (New's context strip, the "Run on" sheet), from the `machine` its identity
 * answered with. Null for a desktop that sent none: the caller draws the
 * generic remote mark in neutral ink instead, never a guessed colour.
 */
export function desktopMachineMark(
  desktop: { deviceId: string; name: string; machineMark?: { kind: string; color: string } | null },
): MachineMarkView | null {
  const mark = desktop.machineMark ? readMachineMark(desktop.machineMark) : null;
  return mark ? { id: desktop.deviceId, label: desktop.name, ...mark } : null;
}

/**
 * The tone each pull request state inks its glyph with, the desktop's map:
 * open is the accent (the one you can still act on), merged the violet a landed
 * branch wears, closed the error red. The shape says the state first.
 */
export const PULL_REQUEST_TONE: Record<ConversationPullRequestState, keyof ThemeColors> = {
  open: "accentPrimary",
  merged: "toneMerged",
  closed: "toneError",
};

/** The word for a state, as a spoken label says it. */
export const PULL_REQUEST_STATE_WORDS: Record<ConversationPullRequestState, string> = {
  open: "open",
  merged: "merged",
  // "closed" alone reads as resolved; the cross is drawing that it did NOT land.
  closed: "closed without merging",
};

/** A pull request as a chat wears it: the drawing, its number, and where a tap goes. */
export interface PullRequestMarkView {
  state: ConversationPullRequestState;
  number: number;
  url: string;
  /** `#42`, beside the glyph. */
  text: string;
  tone: keyof ThemeColors;
  /** The whole mark spoken: "Pull request #42, open: Fix the login. Opens it in the browser." */
  accessibilityLabel: string;
  /** The mark as a list row says it among its other facts: "pull request #42 open". */
  spokenInRow: string;
  /** How many others the chat has, which the spoken label also counts. */
  others: number;
}

/**
 * The one pull request a chat shows: an open one if it has any, else its
 * newest. A higher number is a newer pull request on a repository, and the
 * wire carries no dates.
 *
 * The list row and an open chat's strip leave closed ones out, as the
 * desktop's sidebar and strip do: open asks for you and merged says it went
 * in, while closed unmerged says neither.
 */
export function pullRequestMark(
  pullRequests: readonly ConversationPullRequest[] | null | undefined,
  options: { includeClosed: boolean },
): PullRequestMarkView | null {
  const shown = (pullRequests ?? []).filter((pr) => options.includeClosed || pr.state !== "closed");
  if (shown.length === 0) return null;
  const newest = [...shown].sort((a, b) => b.number - a.number);
  const primary = newest.find((pr) => pr.state === "open") ?? newest[0]!;
  const others = shown.length - 1;
  const title = primary.title.trim();
  return {
    state: primary.state,
    number: primary.number,
    url: primary.url,
    text: `#${primary.number}`,
    tone: PULL_REQUEST_TONE[primary.state],
    others,
    spokenInRow: `pull request #${primary.number} ${PULL_REQUEST_STATE_WORDS[primary.state]}`,
    accessibilityLabel: [
      `Pull request #${primary.number}, ${PULL_REQUEST_STATE_WORDS[primary.state]}${title ? `: ${title}` : ""}.`,
      others > 0 ? `${others} more on this chat.` : null,
      "Opens it in the browser.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * The pull request on an open chat's strip, in the desktop's strip words:
 * "Open PR #42", or "Merged PR #39" once the chat's work went in (an open one
 * wins over a merged one). A chat whose pull requests all closed unmerged has
 * none to offer. It sits at the line's pinned end beside the context ring,
 * where a person finishing with a chat looks, and opens in the browser.
 */
export function stripPullRequest(
  pullRequests: readonly ConversationPullRequest[] | null | undefined,
): { mark: PullRequestMarkView; text: string } | null {
  const mark = pullRequestMark(pullRequests, { includeClosed: false });
  if (!mark) return null;
  return { mark, text: `${mark.state === "merged" ? "Merged" : "Open"} PR #${mark.number}` };
}

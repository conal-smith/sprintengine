import { useEffect, useState } from "react";

import type { LiveConversation, LiveConversationKey } from "../conversations/liveConversation";
import { readTurnDiff, type ChangedFile } from "./unifiedDiff";

// A checkpointed turn's diff is between the two refs the desktop wrote as the
// turn began and ended, so it never changes once the turn has one: an answer
// read once holds for as long as the app runs. Remembering it is what lets the
// file screen step through the list the changes screen already read (and know
// a binary file without asking for text the desktop refuses), and lets Back and
// Previous land on a diff already drawn. Bounded, oldest out: a long session
// opens many turns, and a patch can be large.
const REMEMBERED = 48;
const remembered = new Map<string, unknown>();
function remember(key: string, value: unknown) {
  remembered.delete(key);
  remembered.set(key, value);
  if (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value as string);
}

type Request = LiveConversation["request"];
export type TurnDiffKey = LiveConversationKey & { turnSeq: number };

const filesKey = (turn: TurnDiffKey) =>
  JSON.stringify(["files", turn.deviceId, turn.workspaceId, turn.agentId, turn.turnSeq]);

/** The turn's file list if a screen has already read it. */
export function recallTurnFiles(turn: TurnDiffKey): ChangedFile[] | undefined {
  return remembered.get(filesKey(turn)) as ChangedFile[] | undefined;
}

async function loadFiles(request: Request, turn: TurnDiffKey): Promise<ChangedFile[]> {
  const known = recallTurnFiles(turn);
  if (known) return known;
  const { files } = readTurnDiff(await request({ type: "getTurnDiff", turnSeq: turn.turnSeq }));
  remember(filesKey(turn), files);
  return files;
}

export type FileDiff = { files: ChangedFile[]; file: ChangedFile; patch: string | null };

async function loadFile(request: Request, turn: TurnDiffKey, path: string): Promise<FileDiff> {
  const files = await loadFiles(request, turn);
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error("This file isn't among this turn's changes.");
  // The desktop refuses a binary file's text; the list already said so.
  if (file.binary) return { files, file, patch: null };
  const read = readTurnDiff(await request({ type: "getTurnDiff", turnSeq: turn.turnSeq, path }));
  return { files, file, patch: read.patch ?? "" };
}

export type TurnDiffView<T> =
  /** Nothing to show yet and no way to ask: `closed` when the chat isn't open at all. */
  | { status: "offline"; closed: boolean }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

/**
 * One answer from the chat's own socket (see liveConversation.ts): the turn's
 * file list, or one file of it when `path` is given. Remembered once read,
 * asked for again when the chat reconnects after a failure, and on `retry`.
 */
function useTurnAnswer<T>(
  live: LiveConversation | null,
  turn: TurnDiffKey,
  path?: string,
): { view: TurnDiffView<T>; retry: () => void } {
  const connected = live?.state === "live";
  const request = live?.request;
  const { deviceId, workspaceId, agentId, turnSeq } = turn;
  const key =
    path === undefined
      ? filesKey(turn)
      : JSON.stringify(["file", deviceId, workspaceId, agentId, turnSeq, path]);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Bumped when an answer lands, so the render reads it from `remembered`.
  const [, setLanded] = useState(0);
  useEffect(() => {
    if (!connected || !request || remembered.has(key)) return;
    let current = true;
    const at = { deviceId, workspaceId, agentId, turnSeq };
    (path === undefined ? loadFiles(request, at) : loadFile(request, at, path))
      .then((value) => {
        remember(key, value);
        if (current) setLanded((tick) => tick + 1);
      })
      .catch((error: unknown) => {
        if (current)
          setFailure({
            key,
            message: error instanceof Error ? error.message : "The desktop could not read this turn's changes.",
          });
      });
    return () => {
      current = false;
    };
  }, [connected, request, key, attempt, deviceId, workspaceId, agentId, turnSeq, path]);
  const retry = () => {
    setFailure(null);
    setAttempt((value) => value + 1);
  };
  const view: TurnDiffView<T> = remembered.has(key)
    ? { status: "ready", value: remembered.get(key) as T }
    : !connected
      ? { status: "offline", closed: !live }
      : failure?.key === key
        ? { status: "error", message: failure.message }
        : { status: "loading" };
  return { view, retry };
}

/** The files a turn changed, with their line counts. */
export function useTurnFiles(live: LiveConversation | null, turn: TurnDiffKey) {
  return useTurnAnswer<ChangedFile[]>(live, turn);
}

/** One file of a turn: its patch (null for a binary file), and the list it sits in. */
export function useTurnFile(live: LiveConversation | null, turn: TurnDiffKey, path: string) {
  return useTurnAnswer<FileDiff>(live, turn, path);
}

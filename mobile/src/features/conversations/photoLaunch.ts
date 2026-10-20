// Starting a chat with pictures, from New.
//
// A picture is uploaded to a chat's session, and the session does not exist
// until `conversation.create` has made it. So a launch that carries pictures
// runs in three steps: start the chat with no first message, upload each
// picture to the session that answer names, then hand the words and the
// upload ids to the chat, which sends them as its first message once it is
// live.
//
// The first two steps run here, while New still holds the words and the
// pictures, so a failure leaves both where the person put them. A retry picks
// up where the last try stopped: the chat that was started is used again
// rather than a second one started beside it, and a picture that already
// uploaded is not sent twice. Pure, with the network passed in, so the
// regression suite runs the same steps the screen does.

import type { CreateConversationResult, LaunchedConversation } from "../../api/conversationLaunch";
import type { PickedImage } from "./composerOptions";

/** How far a launch with pictures got: kept by New between tries. */
export interface PhotoLaunchProgress {
  /** Where the chat was to start; a try anywhere else starts afresh. */
  target: { deviceId: string; workspaceId: string };
  /** The chat `conversation.create` started, once it has. */
  conversation: LaunchedConversation | null;
  /** The pictures already on the desktop, by the picker's uri. */
  uploaded: readonly { uri: string; id: string; name: string }[];
}

export type PhotoLaunchResult =
  | {
      ok: true;
      conversation: LaunchedConversation;
      /** The chat's first message's pictures, in the order the person added them. */
      uploads: { id: string; name: string }[];
      progress: PhotoLaunchProgress;
    }
  | {
      ok: false;
      /** Whether a chat was started: the line New shows says so, and a retry uses it. */
      started: boolean;
      message: string;
      /** The desktop's refusal code when the chat did not start, as `conversation.create` gave it. */
      code?: string;
      progress: PhotoLaunchProgress;
    };

/**
 * Runs the first two steps of a launch with pictures, resuming `progress` when
 * it was for the same project on the same desktop.
 */
export async function launchWithPhotos<Picked extends PickedImage>(
  input: {
    target: { deviceId: string; workspaceId: string; machineName: string };
    /** The pictures, and any files, in the order the person added them: each uploaded alike. */
    images: readonly Picked[];
    progress: PhotoLaunchProgress | null;
  },
  steps: {
    create: () => Promise<CreateConversationResult>;
    upload: (sessionId: string, image: Picked) => Promise<string>;
  },
): Promise<PhotoLaunchResult> {
  const target = { deviceId: input.target.deviceId, workspaceId: input.target.workspaceId };
  const resumed =
    input.progress &&
    input.progress.target.deviceId === target.deviceId &&
    input.progress.target.workspaceId === target.workspaceId
      ? input.progress
      : null;
  // Only the pictures still in the tray count: one the person took out since
  // the last try is not sent, though it stays on the desktop until it expires.
  let uploaded = (resumed?.uploaded ?? []).filter((entry) => input.images.some((image) => image.uri === entry.uri));
  let conversation = resumed?.conversation ?? null;
  const progress = (): PhotoLaunchProgress => ({ target, conversation, uploaded });

  if (!conversation) {
    const created = await steps.create();
    if (!created.ok) {
      return {
        ok: false,
        started: false,
        message: [created.title, created.message].filter(Boolean).join(" "),
        ...(created.code ? { code: created.code } : {}),
        progress: progress(),
      };
    }
    conversation = created.conversation;
  }
  const machine = input.target.machineName.trim() || "The desktop";
  if (!conversation.sessionId) {
    return {
      ok: false,
      started: true,
      message: `${machine} started the chat but did not name its session, so the pictures cannot go to it. It is under Chats.`,
      progress: progress(),
    };
  }
  for (const image of input.images) {
    if (uploaded.some((entry) => entry.uri === image.uri)) continue;
    try {
      const id = await steps.upload(conversation.sessionId, image);
      uploaded = [...uploaded, { uri: image.uri, id, name: image.name }];
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : "The picture did not upload.";
      return {
        ok: false,
        started: true,
        message: `The chat started on ${machine}, but ${image.name} did not upload: ${reason} Send again to try the pictures again in the same chat.`,
        progress: progress(),
      };
    }
  }
  const uploads = input.images.map((image) => {
    const entry = uploaded.find((candidate) => candidate.uri === image.uri)!;
    return { id: entry.id, name: entry.name };
  });
  return { ok: true, conversation, uploads, progress: progress() };
}

/**
 * What a chat New started with pictures opens holding: the words and the
 * uploaded pictures, in the box as though typed there, sent once the chat is
 * live. In the box rather than out of sight, so if the chat never goes live,
 * or the send is refused, the person sees what is waiting and can send it
 * themselves.
 */
export interface ChatOpening {
  text: string;
  uploads: { id: string; name: string }[];
}

/**
 * Whether the opening is still what the box holds, so sending it sends what
 * the person wrote in New. Once they edit it the box is theirs, and it goes
 * when they press send.
 */
export function openingStillInBox(
  opening: ChatOpening,
  box: { text: string; uploads: readonly { id: string }[] },
): boolean {
  return (
    box.text === opening.text &&
    box.uploads.length === opening.uploads.length &&
    box.uploads.every((upload, index) => upload.id === opening.uploads[index]?.id)
  );
}

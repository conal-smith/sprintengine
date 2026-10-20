// A chat's pictures, fetched from the paired desktop over the tailnet: what
// Codex generated, and the images an agent looked at. No react-native import,
// so `node --test` can pin it.
//
// The desktop serves one tool call's picture at
// `GET /tailnet/v1/conversation-image?workspaceId&agentId&toolUseId` with the
// device token as a bearer (`conversation:read`), and says it does by
// declaring the `conversation-images` capability. One that also declares
// `conversation-message-images` serves a picture the person sent with a
// message on the same route, by `attachment` (the `ref` its `user_message`
// recorded) in place of `toolUseId`. The answer is the image's
// bytes, or `{ error: { code, message } }`: 403 tailnet_scope_required,
// 404 unknown_conversation / unknown_image, 413 image_too_large,
// 415 not_an_image.

export const CONVERSATION_IMAGE_PATH = "/tailnet/v1/conversation-image";
const PROBLEM_TIMEOUT_MS = 8_000;

/**
 * Which picture: the chat it is in, and either the tool call that made or
 * read it or, for one the person sent, the `ref` its message recorded.
 */
export type ConversationImageRef = { workspaceId: string; agentId: string } & (
  | { toolUseId: string; attachment?: never }
  | { attachment: string; toolUseId?: never }
);

/** What React Native's `<Image source>` takes: the address, and the token it is fetched with. */
export interface ConversationImageSource {
  uri: string;
  headers?: Record<string, string>;
}

/**
 * Why a picture did not load, as a person needs it: `gone` (the desktop no
 * longer has it, or the chat), `too_large`, or `unavailable` for anything else.
 */
export type ConversationImageProblem = "gone" | "too_large" | "unavailable";

/** The picture's address on the desktop. Every id is encoded: they are the desktop's, not ours. */
export function conversationImageUrl(baseUrl: string, ref: ConversationImageRef): string {
  const query = [
    `workspaceId=${encodeURIComponent(ref.workspaceId)}`,
    `agentId=${encodeURIComponent(ref.agentId)}`,
    ref.attachment !== undefined
      ? `attachment=${encodeURIComponent(ref.attachment)}`
      : `toolUseId=${encodeURIComponent(ref.toolUseId)}`,
  ].join("&");
  return `${baseUrl.replace(/\/+$/u, "")}${CONVERSATION_IMAGE_PATH}?${query}`;
}

/** The picture as an `<Image>` source, authorised the way the image upload is. */
export function conversationImageSource(
  input: { baseUrl: string; deviceToken: string },
  ref: ConversationImageRef,
): ConversationImageSource {
  return {
    uri: conversationImageUrl(input.baseUrl, ref),
    headers: { Authorization: `Bearer ${input.deviceToken}` },
  };
}

/** Reads the desktop's refusal: its error code first, the status when there is none. */
export function conversationImageProblem(status: number, body: unknown): ConversationImageProblem {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "unknown_image" || code === "unknown_conversation") return "gone";
  if (code === "image_too_large") return "too_large";
  if (typeof code === "string") return "unavailable";
  if (status === 404) return "gone";
  if (status === 413) return "too_large";
  return "unavailable";
}

/**
 * Why the desktop refused a picture the phone uploaded, as a sentence: the
 * desktop's own message when it sent one, else what its status means on the
 * upload route. The route refuses a type it does not take (415), a picture
 * over its ceiling (413: 5 MB, or 20 MB on a desktop that sizes pictures
 * itself), a chat whose agent reads no pictures (409) and
 * a session it does not know (404).
 */
export function conversationUploadRefusal(status: number, body: unknown): string {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  if (typeof message === "string" && message.trim()) return message.trim();
  switch (status) {
    case 404:
      return "The desktop no longer has this chat.";
    case 409:
      return "This chat's agent does not take pictures.";
    case 413:
      return "The picture is over the desktop's size limit.";
    case 415:
      return "The desktop takes JPEG, PNG, GIF and WebP pictures only.";
    default:
      return "The desktop refused the image upload.";
  }
}

/**
 * Why the desktop turned a file away (`kind=file`), in its own words where it
 * gave some. A 415 is an older desktop, which takes pictures only.
 */
export function conversationFileUploadRefusal(status: number, body: unknown): string {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  if (status !== 415 && typeof message === "string" && message.trim()) return message.trim();
  switch (status) {
    case 404:
      return "The desktop no longer has this chat.";
    case 413:
      return "The file is over the desktop's size limit.";
    case 415:
      return "This desktop takes pictures only. Update Studio there to send files.";
    default:
      return "The desktop refused the file upload.";
  }
}

/** The one quiet line a picture that did not load leaves in its place. */
export function conversationImageProblemText(problem: ConversationImageProblem): string {
  switch (problem) {
    case "gone":
      return "This image is no longer on the desktop.";
    case "too_large":
      return "This image is too large to show.";
    default:
      return "This image could not be loaded.";
  }
}

/**
 * Asks the desktop once why a picture would not load. `<Image>` reports a
 * failure without its status, so this reads the refusal itself; anything it
 * cannot read (no answer, a picture that did come back) is `unavailable`.
 */
export async function readConversationImageProblem(
  input: { baseUrl: string; deviceToken: string },
  ref: ConversationImageRef,
  fetcher: typeof fetch = fetch,
): Promise<ConversationImageProblem> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBLEM_TIMEOUT_MS);
  try {
    const source = conversationImageSource(input, ref);
    const response = await fetcher(source.uri, { headers: source.headers, signal: controller.signal });
    if (response.ok) return "unavailable";
    const body: unknown = await response.json().catch(() => null);
    return conversationImageProblem(response.status, body);
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

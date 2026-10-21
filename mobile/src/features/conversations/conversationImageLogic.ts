import { presentToolItem } from "../../api/conversation-protocol/presentation";
import { recordValue, stringValue, type MobileTool } from "./conversationLogic";

// Which steps in a chat carry a picture, and how big it is drawn. The picture
// itself lives on the desktop (see api/conversationImages.ts).

// The formats the desktop serves as pictures. An SVG is markup the agent read
// as text, and that text is what it went on; the rest the phone cannot draw.
const IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/iu;

/** Whether a path the agent read names a picture: png, jpg, jpeg, webp or gif, in any case. */
export function isConversationImagePath(path: string): boolean {
  return IMAGE_PATH.test(path.trim());
}

/**
 * The picture a step carries, and where it shows.
 *
 * - `inline`: a picture Codex generated (`GenerateImage`). It is what the step
 *   was for, so it shows under the step without the step being opened, as on
 *   the desktop, captioned with the prompt Codex used.
 * - `expanded`: an image an agent read (a `Read` of a picture path, which is
 *   also how Codex's `imageView` arrives). It shows when the step is opened,
 *   in place of the text a read opens onto.
 *
 * Only a step the desktop marked done: a running step has nothing to show yet,
 * and a failed, declined or stopped one never will. A generated picture also
 * needs the path the desktop saved it to, which it adds once it has.
 */
export type ToolPicture = {
  placement: "inline" | "expanded";
  /** What a screen reader says for the picture: the prompt, else what it is. */
  label: string;
  /** The line under a generated picture: its prompt, when Codex gave one. */
  caption?: string;
};
export function toolPicture(tool: MobileTool): ToolPicture | null {
  if (tool.status !== "ok") return null;
  const input = recordValue(tool.input);
  if (tool.name === "GenerateImage") {
    if (!stringValue(input.path).trim()) return null;
    const prompt = stringValue(input.prompt).trim();
    return prompt ? { placement: "inline", label: prompt, caption: prompt } : { placement: "inline", label: "Generated image" };
  }
  if (presentToolItem(tool).icon !== "file_read") return null;
  const path = [input.path, input.file_path, input.filePath].map(stringValue).find(Boolean) ?? "";
  if (!isConversationImagePath(path)) return null;
  return { placement: "expanded", label: path.trim().split(/[\\/]/u).at(-1) || "Image" };
}

/**
 * The size a picture is drawn at: its own proportions, as wide as the space
 * allows but never taller than `maxHeight`, and never blown up past its own
 * pixels.
 */
export function fitPicture(
  natural: { width: number; height: number },
  bounds: { maxWidth: number; maxHeight: number },
): { width: number; height: number } {
  if (!(natural.width > 0) || !(natural.height > 0) || !(bounds.maxWidth > 0) || !(bounds.maxHeight > 0))
    return { width: Math.max(0, bounds.maxWidth), height: Math.max(0, Math.min(bounds.maxHeight, bounds.maxWidth)) };
  const scale = Math.min(1, bounds.maxWidth / natural.width, bounds.maxHeight / natural.height);
  return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
}

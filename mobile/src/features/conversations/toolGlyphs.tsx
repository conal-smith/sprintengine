import { Path, Rect } from "react-native-svg";

import type { ConversationToolKind } from "../../api/conversation-protocol/tool-types";
import { GlyphFrame, iconSize } from "../../components/glyphs/Glyph";

// The chat's own marks. The tool kinds are the desktop's design-system glyphs
// (design-system/glyphs/tool-*.svg) path for path, so a step wears the same
// mark on both surfaces; the rest (compaction, send, stop, the permission
// chip's) are drawn to the same 16 grid, 1.4 line and round caps. Ink comes
// from the caller as a theme colour; nothing here names one.

const TOOL_PATHS: Record<Exclude<ConversationToolKind, "mcp">, string> = {
  command: "M3.5 4.5 7 8l-3.5 3.5M8.5 11.5h4",
  file_edit: "M10.5 3 13 5.5 6 12.5H3.5V10L10.5 3ZM9 4.5 11.5 7",
  file_read: "M9 2.5H4.5v11h7V5L9 2.5ZM9 2.5V5h2.5M6.5 8.5h3M6.5 10.5h3",
  file_write: "M9 2.5H4.5v11h7V5L9 2.5ZM9 2.5V5h2.5M8 7.5v4M6 9.5h4",
  list: "M2.5 4.5v8h11v-6.5H8L6.5 4.5h-4Z",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.25 10.25 13.5 13.5",
  subagent: "M3.5 6h9v6.5h-9V6ZM8 3.5V6M6 9h.01M10 9h.01",
  todo: "M2.75 4.5 4 5.75 6 3.5M2.75 10.5 4 11.75 6 9.5M8.5 5h5M8.5 11h5",
  web: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM8 2.5c-1.6 1.6-2.4 3.4-2.4 5.5s.8 3.9 2.4 5.5M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5s-.8 3.9-2.4 5.5M2.5 8h11",
  other: "M10.2 2.7a3 3 0 0 0-3.9 3.9L2.8 10.1a1.4 1.4 0 0 0 2 2l3.5-3.5a3 3 0 0 0 3.9-3.9L10.4 6.5 9.2 6.3 9 5.1l1.2-2.4Z",
};
// An MCP call wears the plug the desktop draws for MCP (CapabilityGlyphs).
const MCP_PATH = "M5.5 2v3M10.5 2v3M4 5h8v3.5a4 4 0 0 1-8 0zM8 12.5V14";

interface MarkProps {
  color: string;
  size?: number;
  label?: string;
}
function Stroke({ d, color, size = iconSize.xs, label }: MarkProps & { d: string }) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={color} size={size} label={label}>
      <Path d={d} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </GlyphFrame>
  );
}

export function ToolKindGlyph({ kind, ...props }: MarkProps & { kind: ConversationToolKind }) {
  const d = kind === "mcp" ? MCP_PATH : TOOL_PATHS[kind] ?? TOOL_PATHS.other;
  return <Stroke d={d} {...props} />;
}
/** A bulb: the model thinking on its way to a reply. The desktop's `ThoughtGlyph`. */
export function ThoughtGlyph(props: MarkProps) {
  return <Stroke d="M6 12h4M6.75 14h2.5M8 2.5a4 4 0 0 0-2.4 7.2c.6.45.9.95.9 1.3h3c0-.35.3-.85.9-1.3A4 4 0 0 0 8 2.5Z" {...props} />;
}
/** Two arrows closing on a line: the conversation pressed into less context. */
export function CompactGlyph(props: MarkProps) {
  return <Stroke d="M2.5 8h11M8 2.5V6M6 4l2 2 2-2M8 13.5V10M6 12l2-2 2 2" {...props} />;
}
/** The send button's arrow. */
export function SendGlyph(props: MarkProps) {
  // The desktop's composer send arrow, `glyphs/send` in ComposerGlyphs.
  return <Stroke d="M8 12.8V3.6M4.3 7.3 8 3.6l3.7 3.7" {...props} />;
}
/** Queue: lines with a plus, a message added behind the turn. The desktop's `glyphs/queue`. */
export function QueueGlyph(props: MarkProps) {
  return <Stroke d="M2.8 4.2h7.4M2.8 8h7.4M2.8 11.8h4.4M11.8 9.6v4.4M9.6 11.8H14" {...props} />;
}
/** Steer: an arrow turning into the running line. The desktop's `glyphs/steer`. */
export function SteerGlyph(props: MarkProps) {
  return <Stroke d="M3.6 12.8V9.4a3 3 0 0 1 3-3h6.2M9.6 3.2l3.2 3.2-3.2 3.2" {...props} />;
}
/** The stop button's square, filled. */
export function StopGlyph({ color, size = iconSize.xs, label }: MarkProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={color} size={size} label={label}>
      <Rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" />
    </GlyphFrame>
  );
}
/** Bypass: the chat acts without asking. */
export function BypassGlyph(props: MarkProps) {
  return <Stroke d="M9 1.8 3.8 9h4l-1 5.2L12.2 7h-4z" {...props} />;
}
/** The CLI's own permission rules. */
export function ShieldGlyph(props: MarkProps) {
  return <Stroke d="M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4z" {...props} />;
}
/** A disclosure chevron, pointing right when closed and down when open. */
export function DisclosureGlyph({ open, ...props }: MarkProps & { open: boolean }) {
  return <Stroke d={open ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"} {...props} />;
}

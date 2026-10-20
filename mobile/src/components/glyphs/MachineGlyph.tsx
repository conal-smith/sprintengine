import { Circle, Path, Rect } from "react-native-svg";

import type { ConversationPullRequestState } from "../../api/conversationWire";
import { useTheme } from "../../theme/ThemeProvider";
import { GlyphFrame, iconSize, type GlyphProps } from "./Glyph";
import {
  MACHINE_KIND_DRAWINGS,
  machineMarkInk,
  type MachineColour,
  type MachineDrawingPart,
  type MachineKind,
} from "./machineMarks";

// The machine marks and the pull request marks, drawn from the desktop's
// design-system/glyphs on the 16 grid at the house stroke. One component per
// family, so the chat list, the chat's header, New's context strip and the
// "Run on" sheet cannot draw one machine two ways.

const STROKE = 1.4;

/** A drawing's parts, stroked in `currentColor`. */
export function DrawingParts({ parts }: { parts: readonly MachineDrawingPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        "rect" in part ? (
          <Rect
            key={index}
            {...part.rect}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
          />
        ) : (
          <Path
            key={index}
            d={part.path}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </>
  );
}

/**
 * A machine's glyph in its colour. Decorative by default: the surface it sits
 * on names the machine beside it. Never drawn for the desktop itself — the
 * caller passes no mark for `local`.
 */
export function MachineGlyph({
  kind,
  colour,
  size = iconSize.xs,
  label,
}: GlyphProps & { kind: MachineKind; colour: MachineColour }) {
  const { colors } = useTheme();
  return (
    <GlyphFrame viewBox="0 0 16 16" color={machineMarkInk(colors, colour)} size={size} label={label}>
      <DrawingParts parts={MACHINE_KIND_DRAWINGS[kind]} />
    </GlyphFrame>
  );
}

/**
 * A pull request's state as a drawing: the same three nodes, and where the
 * branch ends is the state. Desktop `pull-request-open`, `-merged`, `-closed`.
 * The caller passes the ink (`PULL_REQUEST_TONE`): the shape says the state
 * first and the tone only agrees.
 */
export function PullRequestStateGlyph({
  state,
  color,
  size = iconSize.xs,
  label,
}: GlyphProps & { state: ConversationPullRequestState; color: string }) {
  const node = { fill: "none", stroke: "currentColor", strokeWidth: STROKE } as const;
  const line = { stroke: "currentColor", strokeWidth: STROKE, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <GlyphFrame viewBox="0 0 16 16" color={color} size={size} label={label}>
      <Circle cx="4.5" cy="3.5" r="1.6" {...node} />
      <Circle cx="4.5" cy="12.5" r="1.6" {...node} />
      {state === "merged" ? (
        <>
          <Circle cx="11.5" cy="8.5" r="1.6" {...node} />
          <Path d="M4.5 5.1v5.8" {...line} />
          <Path d="M4.5 5.2c.4 2.2 2 3.3 5.4 3.3" {...line} />
        </>
      ) : state === "closed" ? (
        <>
          <Circle cx="11.5" cy="12.5" r="1.6" {...node} />
          <Path d="M4.5 5.1v5.8M11.5 10.9V8.6" {...line} />
          <Path d="m9.6 3.2 3.8 3.8M13.4 3.2 9.6 7" {...line} />
        </>
      ) : (
        <>
          <Circle cx="11.5" cy="12.5" r="1.6" {...node} />
          <Path d="M4.5 5.1v5.8" {...line} />
          <Path d="M11.5 10.9V6.2a1.9 1.9 0 0 0-1.9-1.9H7.9" {...line} />
          <Path d="M9.6 2.6 7.9 4.3l1.7 1.7" {...line} />
        </>
      )}
    </GlyphFrame>
  );
}

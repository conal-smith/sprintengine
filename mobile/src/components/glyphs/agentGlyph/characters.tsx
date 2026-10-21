import type { ReactElement } from "react";
import { Circle, Ellipse, G, Path, Rect } from "react-native-svg";

import type { AgentCharacterId } from "./seasons";

// Port of ../multicode/src/renderer/src/components/ui/agentGlyph/characters.tsx,
// path for path, drawn on the 16 grid in currentColor line work. Each drawing
// is split so one serves every state:
//
//   body      — always drawn, never moves on its own
//   still     — drawn only while working, moving only with the whole body
//               (the pumpkin's grin)
//   parts     — drawn only while working, each on its own loop (AgentGlyph)
//   rest      — those same parts standing still, for a finished agent
//   eyes      — where the eyes sit ([left x, right x, y]), so the finished
//               faces (^ ^ done, x x failed, - - stopped) are drawn from them
//   doneExtra — a smile or mouth some characters add when they are done
//
// The desktop hangs its moving parts off class names its keyframes key on. A
// phone has no stylesheet, so the parts are named here and AgentGlyph gives
// each its own layer to move.

export type { AgentCharacterId } from "./seasons";

/** The parts a character's loops move, as the desktop's `agent-glyph__*` classes. */
export type AgentPart = "eyes" | "antenna" | "legs" | "whiskers" | "hat";

export interface AgentCharacter {
  name: string;
  body: ReactElement;
  still?: ReactElement;
  parts: Partial<Record<AgentPart, ReactElement>>;
  rest: ReactElement | null;
  eyes: readonly [left: number, right: number, y: number];
  /** Half the span of a failed face's x, for characters with small eyes. */
  crossSize?: number;
  doneExtra?: ReactElement;
}

const BODY = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinejoin: "round",
  strokeLinecap: "round",
} as const;
const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinejoin: "round",
  strokeLinecap: "round",
} as const;
const INK = { fill: "currentColor" } as const;

const octopusLegs = (
  <Path
    {...LINE}
    d="M3.6 9.4q-.3 2.6-1.6 3.3M5.8 9.8q.2 2.8-.9 3.9M8 10v3.9M10.2 9.8q-.2 2.8.9 3.9M12.4 9.4q.3 2.6 1.6 3.3"
  />
);
const catWhiskers = <Path {...LINE} d="M1.6 9.8l2.4.4M1.8 11.8l2.4-.6M14.4 9.8l-2.4.4M14.2 11.8l-2.4-.6" />;
const elfHat = (
  <G>
    <Path {...BODY} d="M3.8 7.5h8.4M5 7.5L8.4 2.8q2.2.1 3.3 1.8M8.4 2.8L11 7.5" />
    <Circle {...INK} cx="12.2" cy="5.2" r=".95" />
  </G>
);
const santaHat = (
  <G>
    <Path {...BODY} d="M4.6 6.2L8.6 2.2q3 .1 4.2 2.9M8.6 2.2l3 4" />
    <Circle {...INK} cx="13.1" cy="5.9" r="1" />
  </G>
);

export const AGENT_CHARACTERS: Record<AgentCharacterId, AgentCharacter> = {
  robot: {
    name: "Robot",
    body: (
      <G>
        <Rect {...BODY} x="3" y="5.4" width="10" height="7.8" rx="2.4" />
        <Path {...LINE} d="M8 5.4V3.3M2.1 8.4v1.8M13.9 8.4v1.8" />
      </G>
    ),
    parts: {
      antenna: <Circle {...INK} cx="8" cy="2.4" r=".95" />,
      eyes: (
        <G>
          <Rect {...INK} x="5.4" y="8" width="1.6" height="2.2" rx=".6" />
          <Rect {...INK} x="9" y="8" width="1.6" height="2.2" rx=".6" />
        </G>
      ),
    },
    rest: <Circle {...INK} cx="8" cy="2.4" r=".95" opacity={0.35} />,
    eyes: [6.2, 9.8, 9.2],
  },
  blob: {
    name: "Bubble",
    body: <Path {...BODY} d="M8 3.2c3.1 0 5.1 2.6 5.1 5.9 0 2.6-1.6 4.1-5.1 4.1s-5.1-1.5-5.1-4.1C2.9 5.8 4.9 3.2 8 3.2z" />,
    parts: {
      eyes: (
        <G>
          <Circle {...INK} cx="6.5" cy="8.4" r=".95" />
          <Circle {...INK} cx="9.5" cy="8.4" r=".95" />
        </G>
      ),
    },
    rest: null,
    eyes: [6.5, 9.5, 8.4],
    doneExtra: <Path {...LINE} d="M7.2 10.4q.8.6 1.6 0" />,
  },
  octopus: {
    name: "Octopus",
    body: (
      <G>
        <Path {...BODY} d="M3.6 9.4C3.4 5.8 5.4 3 8 3s4.6 2.8 4.4 6.4" />
        <Path {...LINE} d="M3.6 9.4Q8 10.9 12.4 9.4" />
      </G>
    ),
    parts: {
      legs: octopusLegs,
      eyes: (
        <G>
          <Ellipse {...INK} cx="6.5" cy="7" rx=".75" ry=".95" />
          <Ellipse {...INK} cx="9.5" cy="7" rx=".75" ry=".95" />
        </G>
      ),
    },
    rest: octopusLegs,
    eyes: [6.5, 9.5, 7],
  },
  owl: {
    name: "Owl",
    body: (
      <G>
        <Path {...BODY} d="M3.4 4.6l2 1.1q2.6-.9 5.2 0l2-1.1q.7 2.4.2 4.9-.6 4.3-4.8 4.3T3.2 9.5q-.5-2.5.2-4.9z" />
        <Circle {...LINE} cx="6.2" cy="8.3" r="1.55" />
        <Circle {...LINE} cx="9.8" cy="8.3" r="1.55" />
        <Path {...LINE} d="M7.4 10.4L8 11.2l.6-.8" />
      </G>
    ),
    parts: {
      eyes: (
        <G>
          <Circle {...INK} cx="6.2" cy="8.3" r=".7" />
          <Circle {...INK} cx="9.8" cy="8.3" r=".7" />
        </G>
      ),
    },
    rest: null,
    eyes: [6.2, 9.8, 8.3],
    crossSize: 0.55,
  },
  ghost: {
    name: "Ghost",
    body: <Path {...BODY} d="M3.2 13.6V7.4a4.8 4.8 0 0 1 9.6 0v6.2l-1.6-1.2-1.6 1.2L8 12.4l-1.6 1.2-1.6-1.2z" />,
    parts: {
      eyes: (
        <G>
          <Ellipse {...INK} cx="6.4" cy="7.6" rx=".85" ry="1.1" />
          <Ellipse {...INK} cx="9.6" cy="7.6" rx=".85" ry="1.1" />
        </G>
      ),
    },
    rest: null,
    eyes: [6.4, 9.6, 7.6],
  },
  pumpkin: {
    name: "Pumpkin",
    body: (
      <G>
        <Path {...BODY} d="M8 5.6C5.9 4.7 2.4 5.5 2.4 9.5 2.4 12.9 5.2 14 8 14s5.6-1.1 5.6-4.5c0-4-3.5-4.8-5.6-3.9z" />
        <Path {...LINE} d="M8 5.6V3.8q.5-1.1 1.8-1.3" />
      </G>
    ),
    still: <Path {...LINE} d="M6 11.2q2 1.3 4 0" />,
    parts: {
      eyes: <Path {...INK} d="M5.4 9.3l1-1.6 1 1.6zM8.6 9.3l1-1.6 1 1.6z" />,
    },
    rest: null,
    eyes: [6.4, 9.6, 8.8],
    doneExtra: <Path {...LINE} d="M6.4 11.2q1.6 1 3.2 0" />,
  },
  cat: {
    name: "Black cat",
    body: (
      <G>
        <Path {...BODY} d="M3.3 7.2L3.5 2.9l3 2.3q1.5-.4 3 0l3-2.3.2 4.3q.9 6.6-4.7 6.6T3.3 7.2z" />
        <Path {...LINE} d="M7.4 10.8L8 11.3l.6-.5" />
      </G>
    ),
    parts: {
      whiskers: catWhiskers,
      eyes: <Path {...INK} d="M6.3 7.6q.7 1.1 0 2.2-.7-1.1 0-2.2zM9.7 7.6q.7 1.1 0 2.2-.7-1.1 0-2.2z" />,
    },
    rest: catWhiskers,
    eyes: [6.3, 9.7, 8.7],
  },
  elf: {
    name: "Elf",
    body: (
      <G>
        <Path {...BODY} d="M4.4 7.6C3.9 11 5.6 14 8 14s4.1-3 3.6-6.4" />
        <Path {...LINE} d="M4.1 9.3L2.1 8.4l2.1 2.3M11.9 9.3l2-.9-2.1 2.3" />
      </G>
    ),
    parts: {
      hat: elfHat,
      eyes: (
        <G>
          <Ellipse {...INK} cx="6.6" cy="10.3" rx=".7" ry=".85" />
          <Ellipse {...INK} cx="9.4" cy="10.3" rx=".7" ry=".85" />
        </G>
      ),
    },
    rest: elfHat,
    eyes: [6.6, 9.4, 10.3],
    crossSize: 0.55,
  },
  santa: {
    name: "Santa",
    body: (
      <G>
        <Path {...BODY} d="M3.9 8q-.6 3.9 1.6 5.3 1.2.7 2.5-.1 1.3.8 2.5.1 2.2-1.4 1.6-5.3" />
        <Rect {...BODY} x="3" y="6.2" width="10" height="1.8" rx=".9" />
        <Path {...LINE} d="M6.2 11.3q.9-.8 1.8 0 .9-.8 1.8 0" />
      </G>
    ),
    parts: {
      hat: santaHat,
      eyes: (
        <G>
          <Ellipse {...INK} cx="6.6" cy="9.6" rx=".65" ry=".8" />
          <Ellipse {...INK} cx="9.4" cy="9.6" rx=".65" ry=".8" />
        </G>
      ),
    },
    rest: santaHat,
    eyes: [6.6, 9.4, 9.6],
    crossSize: 0.55,
  },
};

/** Closed, content eyes: ^ ^. */
export function doneEyes([left, right, y]: AgentCharacter["eyes"]): ReactElement {
  return <Path {...LINE} d={`M${left - 0.8} ${y + 0.35}q.8-1 1.6 0M${right - 0.8} ${y + 0.35}q.8-1 1.6 0`} />;
}

/** Crossed-out eyes: x x. */
export function failedEyes([left, right, y]: AgentCharacter["eyes"], size = 0.7): ReactElement {
  const cross = (x: number) =>
    `M${x - size} ${y - size}l${2 * size} ${2 * size}M${x + size} ${y - size}l${-2 * size} ${2 * size}`;
  return <Path {...LINE} d={cross(left) + cross(right)} />;
}

/** Level, switched-off eyes: - -. */
export function stoppedEyes([left, right, y]: AgentCharacter["eyes"]): ReactElement {
  return <Path {...LINE} d={`M${left - 0.7} ${y}h1.4M${right - 0.7} ${y}h1.4`} />;
}

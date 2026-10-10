import { useState } from 'react'
import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { getRendererHost, selectModuleEnabled } from '../modules'
import type { Workspace } from '../types/workspace'
import { PROJECT_MARK_CLASS, projectColorStyle, type ProjectColor } from '../utils/projectColor'

type IconProps = {
  className?: string
}

const iconStroke = 1.7

export function ChatGlyph({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 5.75h14a1.75 1.75 0 0 1 1.75 1.75v7a1.75 1.75 0 0 1-1.75 1.75H10l-3.75 3v-3H5A1.75 1.75 0 0 1 3.25 15.5v-8A1.75 1.75 0 0 1 5 5.75Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// "No project": the chats started without one (shared/projectless-chats.ts).
// A speech bubble, because what lives there is chats rather than a codebase,
// and dashed in the disabled ink for the reason the unfiled folder is: it
// is not a project, so it never wears a project's hue.
export function NoProjectGlyph({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`${className ?? ''} text-[color:var(--text-disabled)]`.trim()}
    >
      <path
        d="M3.25 3.5h9.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H7.5L4.75 13.5v-2H3.25C2.55 11.5 2 10.95 2 10.25v-5.5c0-.7.55-1.25 1.25-1.25Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeDasharray="2 1.6"
      />
    </svg>
  )
}

// Resolve a workspace mode to its registered type definition, but only when the
// owning module is enabled. Disabled or unknown modes (and shell-owned
// 'standard') resolve to undefined so callers degrade to the generic/standard
// presentation. The registry is read at render time — never during module init —
// so the components→modules reference here does not create an initialization
// cycle with the workspace-type modules that import these icon components.
export function resolveEnabledWorkspaceType(mode: Workspace['mode'], moduleOverrides: ModuleEnablementOverrides) {
  const definition = getRendererHost().getWorkspaceType(mode)
  if (!definition) return undefined
  return selectModuleEnabled(moduleOverrides, definition.moduleId) ? definition : undefined
}

// Workspace-type identity glyph, resolved through the registry. When
// `moduleOverrides` is supplied the lookup is enablement-gated, so a disabled
// module degrades to the generic standard glyph (the workspace tabs and sidebar
// rows pass it); without it the icon resolves ungated (an unknown/standard id
// still falls back to the generic glyph). This component deliberately takes the
// overrides as a prop rather than reading the workspace store, so this
// universally-imported leaf icon module never pulls the store (and flexlayout-react)
// into utility/test bundles.
//
// A project's own logo never lands here: it belongs to the FOLDER the chats sit
// under, not to each chat (owner, 2026-09-02) — see `FolderTypeIcon` below.
export function WorkspaceTypeIcon({
  mode,
  className,
  moduleOverrides,
}: IconProps & {
  mode: Workspace['mode']
  moduleOverrides?: ModuleEnablementOverrides
}) {
  const definition = moduleOverrides
    ? resolveEnabledWorkspaceType(mode, moduleOverrides)
    : getRendererHost().getWorkspaceType(mode)
  const Icon = definition?.icon ?? StandardWorkspaceTypeIcon
  return <Icon className={className} />
}

// A git branch, for the sidebar row's meta line (remote-sessions-ux /
// two-line-session-rows). 16-grid: it renders at glyph scale inside a row.
// Mirrored framework-neutral as design-system/glyphs/git-branch.svg.
export function GitBranchGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="4.5" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 5.7v4.6M11.5 7.2c0 2.4-3.2 2.3-7 2.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

// The Beam — the ONE mark for "another machine" in general (remote-sessions-ux
// decision 7; redrawn as the Beam, owner ruling 2026-10-04): a screen on its
// stand with two arcs of signal off its corner, a machine reached over the air.
// It marks anything that lives on another machine when the surface does not
// say WHICH machine — the paired-devices list, the "Other machines" group of
// the machine picker, the tailnet UI. A surface that names one machine wears
// that machine's own mark instead (`MachineGlyph`). Local is the unmarked
// default. 16-grid, stroke 1.4; mirrored framework-neutral as
// design-system/glyphs/remote-machine.svg.
export function RemoteMachineGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M1.8 6.6h7.4v5.2H1.8ZM5.5 11.8v1.8M3.6 13.6h3.8M10.6 3.2a2.2 2.2 0 0 1 2.2 2.2M10.6 1.4a4 4 0 0 1 4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A WSL distribution on this computer: a machine of its own that is reached as
// a shell, so its mark is a window with a title bar and a prompt in it. The
// title bar is what keeps it apart from the plain terminal's frame
// (`TerminalPromptGlyph`), which the composer's "Start as" choice draws beside
// it (redrawn 2026-10-04). 16-grid, stroke 1.4; also the `wsl` machine kind.
export function WslMachineGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="2.4" width="12" height="11.2" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2 5.4h12M4.8 7.8l1.8 1.6-1.8 1.6M8.4 11h2.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A local server an agent started: a port being served, drawn as a ring with
// signal going out on both sides — something on this machine is answering.
// Not the Beam (`RemoteMachineGlyph`), whose arcs leave one corner of a
// screen and mean another machine; here they leave the middle and nothing is
// attached, because what it names is a listener, not a device. A ring and not
// a disc, so it never reads as a status dot. 16-grid, stroke 1.4.
export function LocalServerGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 3.1a6.9 6.9 0 0 0 0 9.8M12.9 3.1a6.9 6.9 0 0 1 0 9.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

// A scheduled agent: a clock face and nothing else, because what it names is a
// time still to come. Not the history clock, whose rewind arrow means the
// past. 16-grid, stroke 1.4; mirrored as design-system/glyphs/schedule.svg.
export function ScheduleGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.9V8l2.1 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Device identity ───────────────────────────────────────────────────────
//
// Spec: design-system/components/glyphs/component.md → "Device identity".
//
// What KIND of machine a tailnet row is about. `RemoteMachineGlyph` above (the
// Beam) says "elsewhere"; these four say "elsewhere, and it is a Mac mini / a monitor / a
// laptop / a phone" — which is what the rebuilt Settings › Remote needs, because
// its list is one row per machine and merges this device, paired devices,
// outbound connections and the peer scan into a single set.
//
// Drawn to one discipline, since `RemoteMachineGlyph` is this family's
// fallback and the five have to read as one set: 16-grid, stroke 1.4,
// `fill="none"` line work in currentColor, rounded rects at rx 1.3-1.8, and a
// filled 0.75r dot where a unit needs a light. Framework-neutral copies live at
// design-system/glyphs/device-{mac,desktop,laptop,phone}.svg.
//
// Never pick one of these by hand at a call site — `deviceGlyphFor` in
// `ui/deviceGlyph` owns the rule, and the reason is in its own comment.

// The flat wide box with one small dot: a Mac mini seen head-on.
export function DeviceMacGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="5.2" width="12" height="5.6" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.7" cy="8" r="0.75" fill="currentColor" />
    </svg>
  )
}

// A monitor on a stand: screen, a short neck, a foot.
export function DeviceDesktopGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="2.6" width="12" height="8.4" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 11v2.4M5.4 13.4h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// An open lid over a base line. The GAP between them is the hinge, and it is
// what separates this from the monitor at 16px.
export function DeviceLaptopGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="3" y="2.8" width="10" height="7.4" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.8 12.2h12.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// A tall rounded rect with a short bottom mark.
export function DevicePhoneGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="4.7" y="1.7" width="6.6" height="12.6" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.9 12.1h2.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// ── Machine kinds ────────────────────────────────────────────────────────
//
// Spec: design-system/components/glyphs/component.md → "Machine kinds".
//
// What a machine IS, drawn as the device (owner ruling 2026-10-04): the kinds a
// person picks for a machine in Settings › Machines, beside the laptop and
// desktop above (which are the same drawings) and `WslMachineGlyph`. Never
// picked by hand at a call site: `MachineKindGlyph` in `ui/MachineMark` maps a
// kind to its drawing. 16-grid, stroke 1.4, line work in currentColor.

// A small box under a sloped lid, with a slot of light: a mini PC.
export function MachineMiniGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="7.4" width="12" height="4.6" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3.3 7.4 4.5 4.6h7l1.2 2.8M4.6 9.7h1.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A tall case with two drive bays.
export function MachineTowerGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="4.4" y="1.8" width="7.2" height="12.4" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.6 4.6h2.8M6.6 6.8h2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// Three units in one rack, each with its light.
export function MachineServerGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="2.2" width="12" height="11.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2 6.07h12M2 9.93h12M4.4 4.13h1.6M4.4 8h1.6M4.4 11.87h1.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

// A cloud: a virtual machine somewhere else.
export function MachineCloudGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.4 12.2A2.6 2.6 0 0 1 4.9 7.1A3.4 3.4 0 0 1 11.3 6.7A2.8 2.8 0 0 1 11.6 12.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A cube: a container.
export function MachineContainerGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8 1.9 13.4 5v6L8 14.1 2.6 11V5ZM2.6 5 8 8.1 13.4 5M8 8.1v6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A board with its chip and two pins: a single-board computer.
export function MachineBoardGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="4.2" y="5.6" width="4.6" height="4.8" rx="0.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.9 6.4h1.2M10.9 9.6h1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// The permission-preset vocabulary (remote-sessions-ux / selector-menus-premium),
// a set that reads at a glance and is drawn ONCE: a quiet dial for the CLI's
// own default, a closed lock for Manual, a spark for Auto, an open lock for
// Bypass. The chat composer's permission pill and the shared preset menu both
// draw from here, so one preset is one glyph everywhere rather than a 14-grid
// twin in one file and a 16-grid twin in another. 16-grid, `currentColor`,
// sized by the caller's `icon-*` step.
export function PresetDialGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 8l2.4-2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// A closed shackle: the agent stops to ask before it changes anything.
export function LockGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="3.5" y="7" width="9" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

// A spark: the agent carries on through what it can safely do, and asks for the rest.
export function SparkGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8 2.5l1.35 3.4 3.4 1.35-3.4 1.35L8 12l-1.35-3.4-3.4-1.35 3.4-1.35L8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M12.6 11.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" fill="currentColor" />
    </svg>
  )
}

// A shield: the agent never stops to ask, and is held to the rules it was
// given — whatever they do not allow, it refuses (Claude Code's Don't ask).
export function RuleShieldGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8 2.2l5 1.9v3.5c0 3-2.1 5-5 6.1-2.9-1.1-5-3.1-5-6.1V4.1l5-1.9Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// An open shackle, the twin of LockGlyph: the agent is NOT stopping to ask.
export function UnlockedGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="3.5" y="7" width="9" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 7V5.4a2.5 2.5 0 0 0-4.9-.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// The folder outline a sidebar row or header wears when its project has no logo
// of its own. Drawn on the 16px grid, unlike the 24px workspace-type glyphs
// above it, because the row slot is where it renders. One path, three states.
const FOLDER_GLYPH_PATH =
  'M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z'

// The folder glyph in its three states, and the ONE place the project colour is
// drawn (owner, 2026-09-09; principles.md → "Identity colour"):
//
//  * `color` — the project's identity hue, as ink on the outline. Nothing else
//    on the row is tinted; the hue names the project, it never grades it.
//  * `unfiled` — a chat with no folder. No folder is not a project, so it gets
//    the dashed outline in --text-disabled and no colour, rather than reading
//    as a project of its own. It outranks `color` because a row with no folder
//    has no project whose colour could apply.
//  * neither — currentColor, exactly the glyph every existing caller had.
//
// The hue is an angle on an inline custom property and everything else is the
// `project-mark` class, which resolves lightness and chroma per theme
// (assets/index.css), so one glyph reads on all eleven. It is an UNLAYERED rule
// and Tailwind's utilities are layered, which is what lets the project's hue
// survive a row that also sets its ink — the row's tint is a state, the
// project's colour is what the row IS. `data-project-hue` says which hue, for
// the suites and for anyone inspecting a row.
export function ProjectFolderGlyph({
  className,
  color,
  unfiled,
}: IconProps & { color?: ProjectColor | null; unfiled?: boolean }) {
  const hue = unfiled ? null : (color ?? null)
  const tone = unfiled ? 'text-[color:var(--text-disabled)]' : hue === null ? '' : PROJECT_MARK_CLASS
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`${className ?? ''} ${tone}`.trim()}
      style={projectColorStyle(hue)}
      data-project-hue={hue ?? undefined}
    >
      <path
        d={FOLDER_GLYPH_PATH}
        stroke="currentColor"
        strokeWidth="1.4"
        // The dash is the second half of "not a project": on a light theme the
        // disabled ink alone is a faint solid folder, which reads as a project
        // whose colour has not loaded yet rather than as one that has none.
        strokeDasharray={unfiled ? '2 1.6' : undefined}
      />
    </svg>
  )
}

// A folder's identity in an icon slot: `logoSrc` is the project's own
// logo, detected off the top level of the repo at that folder. When present it
// takes the slot the folder glyph would have had — same className, so the call
// site keeps its geometry — and every path back out of it lands on the plain
// folder glyph: no logo, an empty string, or an image that fails to decode. A
// broken data URI must never leave an empty box behind.
//
// The logo was briefly worn by every workspace row instead (a ruling since reversed);
// the owner reversed that on 2026-09-02 — one project, one mark, on the header
// that names the project — and the chat rows lost their icon slot with it.
//
// `color` and `unfiled` pass straight through to ProjectFolderGlyph, so a call
// site that has a project key can hand over the hue without choosing between
// the two components — and a project WITH a logo keeps showing its logo, which
// is why "No colour" exists in the picker at all: a detected logo already
// answers "which project is this", and a hue behind it would be a second answer
// to the same question. Both props are optional and default to the plain glyph,
// so every existing caller is unchanged.
export function FolderTypeIcon({
  className,
  logoSrc,
  color,
  unfiled,
}: IconProps & { logoSrc?: string | null; color?: ProjectColor | null; unfiled?: boolean }) {
  const [brokenLogoSrc, setBrokenLogoSrc] = useState<string | null>(null)

  if (logoSrc && logoSrc !== brokenLogoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        aria-hidden="true"
        draggable={false}
        // The image is shown as authored in both themes — no recolor, no
        // invert. The chip radius keeps a square favicon from reading as a
        // sticker, and object-contain keeps a wide wordmark from being
        // squashed into the square slot.
        className={`${className ?? ''} rounded-[var(--radius-xs)] object-contain`}
        onError={() => setBrokenLogoSrc(logoSrc)}
      />
    )
  }

  return <ProjectFolderGlyph className={className} color={color} unfiled={unfiled} />
}

function StandardWorkspaceTypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="13" rx="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="M7.25 10L10 12.5L7.25 15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.5 15H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
// Compose / "new chat" glyph — the pencil-in-square idiom shared by ChatGPT
// and Claude. Used for the sidebar New chat segment and the empty-workspace
// surface. We deliberately do not reuse the plus glyph here: New workspace
// already owns the plus, so a second plus would read as the same action.
export function NewChatIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4H6.5C5.4 4 4.5 4.9 4.5 6V17.5C4.5 18.6 5.4 19.5 6.5 19.5H18C19.1 19.5 20 18.6 20 17.5V12"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17.6 4a1.6 1.6 0 0 1 2.4 2.4l-7.3 7.3a2 2 0 0 1-.85.5l-2.4.66a.5.5 0 0 1-.62-.62l.66-2.4a2 2 0 0 1 .5-.85z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 9.5L12 15L18 9.5"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5L10 17L19 7.5"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The finding marker: a real glyph, so it takes currentColor and scales with
// --icon-size-* instead of being drawn as a `▲` character sized below the type
// floor.
export function WarningIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4.75L20.5 19.25H3.5L12 4.75Z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 10V14" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M12 16.75H12.01" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V5A2 2 0 0 1 5 3H13.5A1.5 1.5 0 0 1 15 4.5V5"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A document with ruled lines: the release notes behind a version row.
export function ReleaseNotesIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 4.5h8.5L19 9v10.5A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-14A1 1 0 0 1 6 4.5z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
      <path
        d="M14.5 4.5V9H19M8.5 13h7M8.5 16.5h7"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A folder with a plus: install from a folder on disk. Distinct from PlusIcon
// (create) — the thing being added already exists somewhere.
export function FolderPlusIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
      <path d="M12 10.5v5M9.5 13h5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

// An anticlockwise arrow: return to the default.
export function ResetIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12a8 8 0 1 0 8-8 8.7 8.7 0 0 0-6 2.5L4 8.5"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 4v4.5h4.5"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── Settings rail glyphs ──────────────────────────────────────────────────
// One line-weight glyph per Settings category, sharing the house stroke so the
// rail reads as a single set. Consumed by SettingsPanel's `settingsTabs`.

export function GeneralSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 8H7.4M11.6 8H20" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="9.5" cy="8" r="2.1" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M4 16H13.4M17.6 16H20" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="15.5" cy="16" r="2.1" stroke="currentColor" strokeWidth={iconStroke} />
    </svg>
  )
}

export function ProfileSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="M5.6 19c0-3.3 2.9-5.4 6.4-5.4s6.4 2.1 6.4 5.4"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function AppearanceSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
    </svg>
  )
}

export function ShortcutsSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="6.5" width="18" height="11" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="M7 10.5h.01M11 10.5h.01M15 10.5h.01M7.5 14h9"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function AgentsSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="8" width="14" height="11" rx="3" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M12 5v3" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="12" cy="4" r="1.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M9.5 13h.01M14.5 13h.01" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function ProvidersSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.5 3v3.5M15.5 3v3.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path
        d="M6.5 6.5h11V10a5.5 5.5 0 0 1-11 0Z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
      <path d="M12 15.5V21" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function GithubSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 4.5v9.6" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="7" cy="17.5" r="2.3" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="17" cy="6.5" r="2.3" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M17 8.8a8.7 8.7 0 0 1-8.6 8.7" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function TrackersSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6.5A1.5 1.5 0 0 1 5.5 5h9l4.5 4.5v8A1.5 1.5 0 0 1 17.5 19h-12A1.5 1.5 0 0 1 4 17.5z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
      <circle cx="9" cy="12" r="1.4" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M11.5 12h4" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function KnowledgeGraphSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="7" r="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="18" cy="7" r="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="12" cy="17" r="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="M8.2 7h7.6M7.6 8.7l3.1 6.6M16.4 8.7l-3.1 6.6"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function DesignSystemSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="7.2" cy="7.5" r="2.6" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="14" y="4.9" width="5.2" height="5.2" rx="1.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M12 13.6l3.6 5.9H8.4z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
    </svg>
  )
}

// Four tiles identify additions to the product beyond chat (the rail's
// Extensions door, an extension being made), drawn in the icon family's
// 16-box round-stroke idiom.
export function ExtensionsGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export function ModulesSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
    </svg>
  )
}

// A tray with a tick over it: the Settled chats tab holds the chats someone
// called done — the tick is the row's own Settle mark, the tray is where it
// went.
export function SettledChatsSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 13.5h4.2l1.3 2.5h5l1.3-2.5H20v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
      <path
        d="M8.5 7.5l2.5 2.5 4.5-5"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A branch forked off a trunk, three tips: the Worktrees tab lists every
// checkout the agents work in, each one a branch of the project beside it.
export function WorktreesSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="5.5" r="2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="6" cy="18.5" r="2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="18" cy="8.5" r="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="M6 7.5v9M18 10.5c0 3.5-4.5 3.5-10.4 6.6"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A screen with a prompt in it: the Machines tab is about the machines on THIS
// computer that run a workspace's shells (this PC, and its WSL distributions).
export function MachinesSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="m7 9 3 2.5L7 14M12.5 14H17M9 21h6"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Two machines joined by a link: the Remote tab is about this Studio and
// another one, not about a network in the abstract.
export function RemoteSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="13" y="13" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path
        d="M7 11v3.5a1.5 1.5 0 0 0 1.5 1.5H13"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
      />
    </svg>
  )
}

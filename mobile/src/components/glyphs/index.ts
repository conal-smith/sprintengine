// The app's icon vocabulary, ported from the desktop renderer. No icon font, no
// third-party icon set: every mark here is a react-native-svg component drawn on
// a 16 grid.
//
// Two vocabularies, two rules:
//   Lifecycle — state reads by shape; theme tone only reinforces it.
//   Chrome    — one house stroke; `textMuted` at rest, `accentPrimary` when active.
//
// Every glyph takes `size` (points) and `label`. Pass `label` only when the glyph
// stands alone; omit it when adjacent text already names the thing, and it hides
// from the screen reader instead of announcing twice.

export { iconSize, type GlyphProps, type GlyphSizeName } from "./Glyph";

export { LifecycleGlyph } from "./LifecycleGlyph";

export { StatusShape, type StatusShapeTone } from "./StatusShape";

// Agents a conversation sends off, drawn as characters from the season's pool.
// The pick is the desktop's, so an agent wears the same face on both screens.
export { AgentGlyph, type AgentGlyphState } from "./AgentGlyph";
export { AGENT_CHARACTERS, type AgentCharacter, type AgentCharacterId } from "./agentGlyph/characters";
export { stablePick } from "./agentGlyph/pick";
export { AGENT_SEASON_POOLS, pickAgentCharacter, seasonFor, type AgentSeason } from "./agentGlyph/seasons";

export {
  glyphSurfaces,
  lifecycleStates,
  LIFECYCLE_LABEL,
  LIFECYCLE_TONE,
  nonTextContrastFloor,
  type LifecycleState,
} from "./lifecycleTone";

// Coding CLI logos, the desktop's own artwork, so a runtime is recognisable at a glance.
export { CliLogo, resolveCliLogoKind, type CliLogoKind } from "./CliLogo";

// A machine's kind in its colour, and a pull request's state: the desktop's
// marks, read from what the desktop sends and never decided here.
export { MachineGlyph, PullRequestStateGlyph } from "./MachineGlyph";
export {
  MACHINE_COLOURS,
  MACHINE_KINDS,
  MACHINE_KIND_LABELS,
  type MachineColour,
  type MachineKind,
} from "./machineMarks";

export { BacklogTypeGlyph, BACKLOG_TYPE_LABEL, type BacklogType } from "./BacklogTypeGlyph";

// A file attached to a message, by kind: the desktop's office-kind marks.
export { FileTypeGlyph } from "./FileTypeGlyph";

export {
  CriticalityBars,
  DifficultyLabel,
  CRITICALITY_LABEL,
  DIFFICULTY_LABEL,
  DIFFICULTY_WORD,
  type BacklogCriticality,
  type BacklogDifficulty,
} from "./Triage";

export {
  AppearanceIcon,
  BellIcon,
  CheckIcon,
  CopyIcon,
  DiffIcon,
  FilesIcon,
  FolderGlyph,
  GitBranchGlyph,
  MoreIcon,
  PersonIcon,
  PlusIcon,
  PullRequestIcon,
  PushIcon,
  RefreshIcon,
  RemoteMachineGlyph,
  SignOutIcon,
  WorktreeGlyph,
} from "./AppGlyphs";

export {
  BacklogIcon,
  BoltIcon,
  ClaudeMark,
  ChevronIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  FilterIcon,
  GearIcon,
  HomeIcon,
  MenuIcon,
  SearchIcon,
  SettingsIcon,
  StarIcon,
  type ChevronDirection,
} from "./ChromeIcons";

// Shared UI primitives. Consumed by the Automations and Review panels, and by
// every module surface the SDK hands them to. Tokens live in
// src/renderer/src/assets/index.css; tone vocabulary lives in ./tokens.

export { PanelHeader } from './PanelHeader'
export { InboxRow } from './InboxRow'
export { InboxSearchInput } from './InboxSearchInput'
export { Section } from './Section'
export { DefinitionList } from './DefinitionList'
export type { DefinitionItem } from './DefinitionList'
export { StatusDot } from './StatusDot'
export { WorkingMark, WORKING_MARK_VARIANTS, type WorkingMarkVariant } from './WorkingMark'
export { AgentGlyph, type AgentGlyphState } from './AgentGlyph'
export { ContextRing, CONTEXT_RING_WARN_PERCENTAGE, contextRingTokensLabel } from './ContextRing'
export { DiffStatPill } from './DiffStatPill'
export { FrontTruncatedText, frontTruncate } from './FrontTruncatedText'
export { Spinner } from './Spinner'
export { WorkingEdge } from './WorkingEdge'
export { AgentEdge, AgentPill, AGENT_TAB_CLASS, AGENT_TAB_RING_CLASS } from './AgentPresence'
export { LifecycleGlyph, type LifecycleState } from './LifecycleGlyph'
export { PullRequestGlyph } from './PullRequestGlyph'
export {
  CaptionButton,
  CloseIconButton,
  FloatingButton,
  GhostButton,
  IconButton,
  MediaButton,
  OutlineButton,
  PrimaryButton,
  SendButton,
} from './Buttons'
export type { ButtonAlign, ButtonSize, ButtonTone, CaptionButtonTone, GhostTone, IconButtonSize } from './Buttons'
// The one copy affordance (design-system/components/button → The copy glyph):
// an IconButton that confirms in place instead of spelling "Copy".
export { COPY_CONFIRM_MS, CopyGlyphButton } from './CopyGlyphButton'
export type { CopyGlyphButtonProps } from './CopyGlyphButton'
// The five shapes the button family was missing (the raw-primitive
// sweep, 2026-09-08). Each is a species, not a restyle: a row, a value row, a
// popover trigger, a tile and a text link answer questions the three sized
// buttons above cannot, and each states why in its own header.
export { RowButton } from './RowButton'
export type { RowButtonDensity, RowButtonProps, RowButtonVariant } from './RowButton'
export { MenuOption } from './MenuOption'
export type { MenuOptionProps, MenuOptionRole } from './MenuOption'
export { TriggerButton } from './TriggerButton'
export type { TriggerButtonProps, TriggerSize, TriggerVariant } from './TriggerButton'
export { CardButton } from './CardButton'
export type { CardButtonProps, CardVariant } from './CardButton'
export { ChipButton } from './ChipButton'
export type { ChipButtonProps, ChipTone, ChipVariant } from './ChipButton'
export { LinkButton } from './LinkButton'
export type { LinkButtonProps, LinkInk, LinkLayout, LinkUnderline } from './LinkButton'
export { RefreshIcon } from './RefreshIcon'
export { FileTypeGlyph } from './FileTypeGlyph'
// The Commit window's and diff window's action vocabulary (git-commit-window
// T2). Fourteen concepts, mirrored in design-system/glyphs/ — import them,
// never paste a path into a toolbar. The changelist four follow in their own
// block below, for eighteen in all.
export {
  CollapseAllGlyph,
  ExpandAllGlyph,
  GearGlyph,
  GroupByGlyph,
  MoveToChangelistGlyph,
  NextDifferenceGlyph,
  OpenInEditorGlyph,
  PreviousDifferenceGlyph,
  RollbackGlyph,
  ShowDiffGlyph,
  SideBySideGlyph,
  StashGlyph,
  UnifiedGlyph,
  WriteCommitMessageGlyph,
} from './GitActionGlyphs'
// The changelist quartet (git-commit-window T6): new, delete, edit, and the
// patch a selection is written out as.
export { CreatePatchGlyph, DeleteChangelistGlyph, EditChangelistGlyph, NewChangelistGlyph } from './GitActionGlyphs'
// The diff tour's marks (design-system/components/tour-strip): the tour itself,
// Play and Pause, and the step list's toggle.
export { PauseGlyph, PlayGlyph, StepListGlyph, TourGlyph } from './TourGlyphs'
// "In a window of its own": the Diff tab's separate window, and the pane's pop-out.
export { OpenInWindowGlyph } from './OpenInWindowGlyph'
export { ToolKindGlyph } from './ToolKindGlyph'
// The diff tour's surfaces (design-system/components/tour-strip, tour-callout):
// the band, the callout a step is said in, the step list and the Start card.
export { TourProgress, TourStrip } from './TourStrip'
export type { TourProgressMark, TourStripProps } from './TourStrip'
export { TourCallout } from './TourCallout'
export type { TourCalloutAskState, TourCalloutProps } from './TourCallout'
export { TourReadyCard, TourStepList } from './TourStepList'
export type { TourStepListItem } from './TourStepList'
// The overflow mark, one drawing. Two surfaces drew it privately at two
// pitches until 2026-09-09 — `OverflowMenu`'s own trigger and the Git panel's
// group band — which is exactly the drift `design-system/glyphs/` exists to
// stop.
export { KebabGlyph } from './KebabGlyph'
// The one micro chip, for the "active" mark on a changelist's band
// (design-system/components/micro-chip).
export { MicroChip } from './DefaultChip'
export { ConfirmDialogProvider, useConfirmDialog } from './ConfirmDialog'
export { CliModelPickerButton, CliModelPopoverSurface } from './CliModelPicker'
export {
  cliPermissionModeLaunch,
  cliPermissionModePatch,
  resolveCliPermissionPreset,
  setCliPermissionPreset,
  storedCliPermissionMode,
  useCliPermissionMode,
  useCliPermissionPreset,
} from './cliPermissionPresets'
export { Popover } from './Popover'
export { FilterMenu } from './FilterMenu'
export type { FilterMenuGroup } from './FilterMenu'
export type { PopoverProps, PopoverPlacement } from './Popover'
export { UseSkillInAgentMenu } from './UseSkillInAgentMenu'
export type { UseSkillInAgentMenuProps } from './UseSkillInAgentMenu'
export { useWorkspaceSkills, InlineSkillPicker, SkillPickerPopover } from './SkillPickerPopover'
export type { InlineSkillPickerHandle } from './SkillPickerPopover'
export { OverflowMenu } from './OverflowMenu'
export type { OverflowMenuItem } from './OverflowMenu'
export {
  ContextMenu,
  MenuDivider,
  MenuFlyoutItem,
  MenuItem,
  DescribedMenuItem,
  MenuSwatchRow,
  ProjectColorSwatchRow,
  roveMenuFocus,
} from './ContextMenu'
// The menu canon itself, for a surface that must build a menu row the kit does
// not already own. Prefer the components above — a class string is the last
// resort, not the entry point.
export {
  MENU_DIVIDER_CLASS,
  MENU_GROUP_LABEL_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_STACKED_CLASS,
  MENU_LIST_CLASS,
  MENU_OPTION_CLASS,
  MENU_OPTION_STACKED_CLASS,
  MENU_ROW_CLASS,
  MENU_ROW_HOVER_CLASS,
} from './menuClasses'
export { ProviderRow, ProviderStateId } from './ProviderRow'
export type { ProviderRowProps } from './ProviderRow'
export { CliProviderStateLine } from './CliProviderStateLine'
export { resolveCliProviderState } from './cliProviderState'
export { SplitButton } from './SplitButton'
export type { SplitButtonItem } from './SplitButton'
export { PointerPopover } from './PointerPopover'
export { Tabs, TabPanel, TabsScroller } from './Tabs'
export type { TabItem } from './Tabs'
export { TaskCard } from './TaskCard'
export { Switch, SwitchGlyph } from './Switch'
export { Pager } from './Pager'
export { SegmentedControl } from './SegmentedControl'
// The ONE Field. `ui/Modal` used to export a second component under this name —
// a `text-micro` label with no `htmlFor` and no ARIA wiring at all — and both
// arrived through this barrel, so whoever imported "the" Field got a coin flip
// several panel dialogs got the inaccessible one.
export { Field } from './Field'
export { INLINE_TITLE_EDIT_CLASS, Input, Textarea } from './Input'
export type { InputSize, InputVariant } from './Input'
export { Select } from './Select'
export type { SelectItem } from './Select'
export { Checkbox } from './Checkbox'
// The Commit-window kit (2026-09-09): the rows, band and variants the Git
// panel and the diff window compose from, so T4/T5 build from the system
// rather than hand-rolling at 24px.
export { CheckRow } from './CheckRow'
export type { CheckRowCheckedState, CheckRowProps } from './CheckRow'
// The `--described` variant of the same row (design-system/components/check-row):
// box + title + optional mono scope name + one supporting line, in a list
// surface. A separate export rather than a prop because it takes the spec's
// STANDALONE box spelling — the kit checkbox whole, the row as its `<label>` —
// and a prop that silently swapped a real input for a drawing is the one
// difference a caller must not be able to make by accident.
export { DescribedCheckRow, DescribedCheckRowList } from './CheckRow'
export type { DescribedCheckRowProps } from './CheckRow'
// One setting and the card a run of them sits in
// (design-system/components/setting-row). Not an InboxRow: nothing here is
// picked, so the row carries no hover fill and no selection.
export { SettingCard, SettingRow } from './SettingRow'
export type { SettingRowProps } from './SettingRow'
// One machine-readable scope name in a pill (design-system/components/scope-pill).
// Not a Badge and not a MicroChip: those are UI-face labels, and this content is
// the identifier itself.
export { ScopePill, ScopePillSet } from './ScopePill'
export type { ScopePillProps } from './ScopePill'
// What an extension asks to reach, at three depths
// (design-system/components/access-summary): the row's warning glyphs, the
// details' care list, and the standard scopes as quiet pills.
export { AccessCareList, AccessChips, AccessGlyphs } from './AccessSummary'
export type { AccessItem } from './AccessSummary'
// The one implementation of "which device glyph does this machine get?"
// (design-system/components/glyphs → Device identity). A function, not a switch
// per call site: the `book` exclusion in the macOS-desktop rule is a trap that
// gets re-derived backwards.
export { deviceGlyphFor } from './deviceGlyph'
export type { DeviceGlyphComponent, DeviceGlyphInput } from './deviceGlyph'
// A machine's mark — its kind's drawing in its colour (owner ruling
// 2026-10-04; design-system/components/glyphs → Machine kinds).
export { MachineGlyph, MachineKindGlyph, MACHINE_COLOUR_FILL, MACHINE_COLOUR_INK } from './MachineMark'
// The system's file dialog behind a kit control (design-system/components/input → The file dialog).
export { HiddenFileInput } from './HiddenFileInput'
// The composer's own marks (design-system/components/glyphs → Composer).
export {
  AttachGlyph,
  ComposerPlusGlyph,
  ConversationGlyph,
  PluginsGlyph,
  QueueGlyph,
  SendGlyph,
  SteerGlyph,
  TerminalAgentGlyph,
  WorktreeGlyph,
} from './ComposerGlyphs'
export { GroupHeader, GroupHeaderAction } from './GroupHeader'
export type { GroupHeaderProps } from './GroupHeader'
export { Toolbar, ToolbarButton, ToolbarDivider, ToolbarSpacer } from './Toolbar'
export type { ToolbarButtonProps } from './Toolbar'
export { Badge } from './Badge'
export type { MarkBadge } from './Badge'
export { NewChip } from './NewChip'
export { EmptyState } from './EmptyState'
export { SidePane, SidePaneHeader } from './SidePane'
export { BoardLane } from './BoardLane'
export { ActionResultMessage, InlineNotice } from './InlineNotice'
export type { ActionResult } from './InlineNotice'
export { Skeleton } from './Skeleton'
export { ChangePulse } from './ChangePulse'
export { LoadingOverlay } from './LoadingOverlay'
export { HtmlPreviewCard } from './HtmlPreviewCard'
export { KbdChord } from './KbdChord'
export { StarGlyph } from './StarGlyph'
export { Tooltip } from './Tooltip'
export { TruncatedText } from './TruncatedText'
export type { Tone, StatusTone } from './tokens'
export {
  COMPOSER_MATERIAL_CLASS,
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_CLASS,
  FOCUS_RING_INSET_CLASS,
  FOCUS_RING_WITHIN_CHECKBOX_CLASS,
  FOCUS_RING_WITHIN_INPUT_CLASS,
  FOCUS_RING_WITHIN_EDITOR_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  TONE_COLOR_VAR,
  TONE_SOFT_VAR,
} from './tokens'

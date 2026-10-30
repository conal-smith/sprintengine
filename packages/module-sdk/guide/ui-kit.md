# UI: the host's kit, the door shell, theme tokens

Studio lends its own components to modules, so an extension looks like the
app instead of a shade off it. They are **host-provided**: the SDK ships their
types, and the real components arrive at runtime through an import map. Mark
them external (the template build already does) — bundling the SDK's copy in
fails loudly at load: "…is provided by the host at runtime; mark it external".

## `@sprintengine/module-sdk/ui`

| Component | Use |
| --- | --- |
| `PrimaryButton` | The one affirmative action on a surface (`busy` for pending) |
| `GhostButton` | Every other button (`tone`, `pressed`, `size`) |
| `OutlineButton` | A secondary action beside a primary one |
| `LinkButton` | Navigation that reads as a link |
| `RowButton` | A full-width list row (`selected`, `density`) |
| `Input`, `Textarea` | Text entry (`variant`, `size`, `fullWidth`; Textarea `resize`) |
| `Field` | Label + help + error around ONE input; pass `htmlFor` matching the input's `id`. Omit `htmlFor` for a composite control (a segmented control) and it renders the label as text |
| `Select` | A dropdown: `ariaLabel`, `items: [{ value, label }]`, `value`, `onChange`; `size` `xs` / `sm` (default) / `md` matches the buttons in its row |
| `DateTimeInput` | A date, time or both (`type` `datetime-local` (default) / `date` / `time`); values are the native local-time strings, never `Date`s |
| `Toggle` | A setting that applies the moment it is thrown (`checked`, `onChange`, `ariaLabel`) — the app's switch |
| `SegmentedControl` | A small exclusive choice |
| `Chip` | A static hairline chip stating one fact about the thing beside it ("Default"). Not a control, not a status |
| `ChipButton` | A content-height pill that toggles (`pressed`), picks one of a set (`selected`), or names something in an identity colour (`tint`) |
| `ContextMenu`, `MenuItem`, `MenuDivider` | A menu at a point (right-click, or an overflow button's corner): arrow keys, Escape and focus return built in. Mount it while open; call your `onClose` after an item runs |
| `TaskCard` | A task as a list row (`variant="row"`) or a board card (`variant="card"`); renders an `<li>` |
| `BoardLane` | One board column of `TaskCard`s: header and count, animated reorder (`flipKey`), optional drag-and-drop (`dnd`) |
| `SafeMarkdown` | Agent-written Markdown drawn like a chat reply, with no raw HTML, http(s)-only links (`links`: `open` / `copy` / `none`) and no fetched images |
| `SidebarNavButton` | Your sidebar door's row, drawn like the app's own; pass the `collapsed` and `badge` your entry receives |
| `PanelHeader` | A panel's title row (`subtitle` or `scope`, `primaryAction`, `count`) |
| `Section` | A titled group (`title`, `count`, `action`) |
| `EmptyState` | Nothing here yet (`title`, `body`, `action`; `density="list"` inside a list) |
| `Banner` | Panel-wide error/warn strip with retry |
| `InlineNotice` | An error/warning where it happened |
| `Spinner` | Loading (give it `label` to announce it) |
| `LifecycleGlyph` | A state shown as a shape (`state`, `live`) |
| `Drawer` / `Drawer.Body` | A side drawer |
| `TruncatedText` | Clamped text with a tooltip only when clipped |
| `KbdChord` | A keyboard shortcut, drawn per platform |
| `CliModelPickerButton` | The runtime + model picker the app uses. Feed it `host.listChatRuntimes()` directly |
| `FOCUS_RING_CLASS` | The focus-ring class for a focusable you draw yourself |

`StatusDot` exists for compatibility and draws shapes; do not add dots of
your own. State is a word, a lifecycle glyph, or a timer.

### Recipes

A menu on right-click (for an overflow button, open it at the button's
`getBoundingClientRect()` bottom-left instead):

```tsx
function TaskRow({ task }: { task: Task }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const close = () => setMenu(null)
  const openAt = (event: React.MouseEvent) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  return (
    <li onContextMenu={openAt}>
      {task.title}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} ariaLabel="Task actions" onClose={close}>
          <MenuItem onClick={() => (archive(task), close())}>Archive</MenuItem>
          <MenuDivider />
          <MenuItem variant="danger" onClick={() => (remove(task), close())}>
            Delete
          </MenuItem>
        </ContextMenu>
      ) : null}
    </li>
  )
}
```

A board:

```tsx
<div style={{ display: 'flex', gap: 12, height: '100%' }}>
  {lanes.map((lane) => (
    <BoardLane
      key={lane.id}
      label={lane.name}
      count={lane.tasks.length}
      flipKey={lane.tasks.map((t) => t.id).join(',')}
      surface
    >
      {lane.tasks.map((task) => (
        <TaskCard
          key={task.id}
          variant="card"
          tone="neutral"
          leading={null}
          identifier={task.key}
          title={task.title}
          selected={task.id === selectedId}
          onSelect={() => select(task.id)}
        />
      ))}
    </BoardLane>
  ))}
</div>
```

The agent picker, straight from the host:

```tsx
<CliModelPickerButton
  ariaLabel="Agent"
  options={host.listChatRuntimes()}
  cli={cli}
  effectiveModelFor={(id) => (id === cli ? model : undefined)}
  onSelectCli={setCli}
  onSelectModel={(id, next) => {
    setCli(id)
    setModel(next ?? undefined)
  }}
/>
```

Unavailable runtimes are left out of the list unless one is the current `cli`;
a runtime's `models` become its model list. Pass the chosen `cli` and `model`
to `openChat`.

Agent text: `<SafeMarkdown text={reply} links="open" />`. Never render agent
output through `dangerouslySetInnerHTML` or a Markdown library of your own.

The kit is deliberately small and frozen. A component that is not in it is
cheaper copied into your module than waited for.

## `@sprintengine/module-sdk/surface`

For a global surface (door) or a modal body:

```tsx
import { GlobalSurfaceShell, SurfaceCanvasState, useSurfaceBackNav } from '@sprintengine/module-sdk/surface'

function Door() {
  const { onBack, canGoBack } = useSurfaceBackNav()
  return (
    <GlobalSurfaceShell ariaLabel="Weather" bar={{ title: 'Weather', actions: <GhostButton>Refresh</GhostButton> }}
      rail={<MyList />} onBack={onBack} canGoBack={canGoBack}>
      <SurfaceCanvasState kind="empty" glyph={<CloudIcon />} title="Pick a city" />
    </GlobalSurfaceShell>
  )
}
```

`SurfaceRail` is the list column the app's own doors use (rows, groups,
search, filter, a "new" affordance); `SurfaceCanvasState` is the one
loading / empty / error canvas. What the rail does with its props:

- **A row is plain or rich.** Plain: `icon`, `title`, `stateLine` (and
  `tooltip`, `mark`, `actions`). Setting `context` or `detail` turns it into
  the sidebar's three-line rich row (context line, title, detail line) with
  `surface` and `emphasis`, and drops `icon`, `mark` and `tooltip`. Keep one
  shape per rail. `stateLine` is always required — it is the row's accessible
  summary even when `detail` replaces it on screen.
- **`newAffordance` is optional.** Leave it out on a door with nothing to
  create and no New row is drawn.
- **`search`, `filter` and `scope` are controlled.** The rail draws them and
  reports changes; you narrow `rows` yourself. `filter` and `scope` appear
  only beside a `search`.
- **`scope` is not a visible control.** It is folded into the filter glyph's
  menu as its first group, labelled "Project", with the first item as the
  "not narrowed" default. A project that must stay visible belongs in
  `intro`.
- `rows` must equal `groups`' rows flattened: ↑/↓ and j/k walk `rows`.

## `@monaco-editor/react`

Depend on it for types; the host provides the instance (one Monaco in the
process). Drive its theme from `host.watchColorScheme(scheme => …)`.

## Styling

- **Theme tokens only.** `var(--bg-surface)`, `var(--text-muted)`,
  `var(--border-subtle)`, `var(--accent-primary)`, `var(--tone-warn)`… The full
  list is `THEME_TOKENS` in the SDK. Never a hex value, never a value read from
  the DOM and cached.
- Tones are single values. For a soft fill:
  `color-mix(in srgb, var(--tone-good) 15%, transparent)`.
- **Charts** take `var(--chart-1)` … `var(--chart-8)` for categorical series,
  and `var(--chart-other)` (a neutral) for everything folded past the eighth.
  Series N always takes slot N — never cycle, never re-assign by rank, never a
  generated ninth hue — because the ORDER is what keeps neighbours apart under
  colour-vision deficiency. Each clears 3:1 against `--bg-surface` on every
  theme, so a mark needs no outline. They are never status: a series that
  means good or bad (pass/fail, an error rate) wears `--tone-good` /
  `--tone-warn` / `--tone-error`, and a status tone is never "series 4". Show
  a legend for two or more series, label values in text ink, and in a
  scatter or small multiples keep to three series.
- Motion: `transition: opacity var(--motion-normal) var(--motion-ease)`.
- **Tailwind classes you write produce no CSS** — Studio's stylesheet is built
  from Studio's source only. Either:
  - inline styles and plain CSS on tokens, injected once as a `<style>`
    element (the panel template's `styles.ts` + `styles.css`, imported as
    text with esbuild's `--loader:.css=text`), with every selector prefixed by
    the module id; or
  - your own utilities-only Tailwind build: an entry with
    `@import "tailwindcss/theme" theme(reference); @import "tailwindcss/utilities" layer(utilities) source(none); @source "./src";`,
    compiled with `@tailwindcss/cli` and injected the same way. Never ship
    Tailwind's preflight: it would restyle the whole app.
- Icons: 24×24 viewBox, `stroke="currentColor"`, sized by the `className`
  the shell passes.

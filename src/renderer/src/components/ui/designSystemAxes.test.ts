import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'vitest'

test('designSystemAxes', async () => {
  // The ratchet.
  //
  // Color hygiene in this renderer is near-perfect (a handful of non-test hex
  // literals, most of them theme-blind canvases and brand marks) and px font
  // sizes are effectively gone. Not because anyone is more careful about color:
  // because `designSystemConformance.test.tsx` and the token lint POLICE color,
  // and nothing polices the rest. The unpoliced axes are exactly where the
  // off-ramps live, and nothing stopped the count growing.
  //
  // So this file is deliberately not a "fix everything" gate. It is two kinds of
  // assertion, per the shape the conformance axis asks for:
  //
  //   HARD RULES — the kit (`components/ui/`) consumes the token, full stop.
  //     A primitive that spells a shadow, a stacking tier or a type step by hand
  //     is not a primitive; every host that copies it inherits the off-ramp.
  //     These are at zero and must stay there.
  //
  //   RATCHETS — the app tree carries a checked-in per-directory count.
  //     Going DOWN is a one-line edit to the baseline below. Going UP fails, and
  //     names the directory. This is how ~476 radius off-ramps drain without a
  //     big-bang sweep that would touch every file in the renderer at once.
  //
  // The counts are read from source text rather than from a rendered tree on
  // purpose: these are repo-wide questions ("how many places spell a radius by
  // hand"), and mounting every component to ask them is neither possible nor
  // useful. The rendered-class contracts stay in `designSystemConformance.test.tsx`.
  //
  // The epic's exit condition is every baseline at zero.

  const RENDERER = join(process.cwd(), 'src/renderer/src')
  const KIT = join(RENDERER, 'components/ui')

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full, out)
      } else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name) && !name.endsWith('.d.ts')) {
        // `.d.ts` is build output, not source. A stray `tsc` run beside the
        // sources re-declares every exported class constant as a string literal,
        // so the same off-ramp is counted twice and a directory nobody edited
        // "grows" one — which reads as a regression in whatever change happens to
        // be in flight. The ratchet asks a question about source text; declaration
        // files are not it.
        out.push(full)
      }
    }
    return out
  }

  /**
   * Comments are stripped before scanning. Without this, prose describing an
   * off-ramp counts as one — `Modal.tsx`'s own ladder comment scored four bare
   * `z-*` hits while the file used none — so documenting a rule would make the
   * rule look violated, and deleting the documentation would "fix" it.
   */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  }

  /**
   * The directory a count is attributed to: `components/<area>`, else top level.
   *
   * One level deep on purpose, so a subdirectory cannot be a hiding place. Every
   * file under `components/panels/git/` is counted against `components/panels`,
   * which is what keeps a ratchet honest when a panel is broken up: the Changes
   * view moved into six new files there in T5/T6 and stayed policed at its old
   * baseline without a line changing here. (The named-file rules in
   * `designSystemConformance.test.tsx` had to be widened by hand — that is the
   * cost of naming files rather than walking a tree, and why this one walks.)
   */
  function area(file: string): string {
    const parts = relative(RENDERER, file).split('/')
    if (parts[0] !== 'components') return parts[0]
    return parts.length > 1 ? `components/${parts[1]}` : 'components'
  }

  const AXES = {
    /**
     * The named steps `xs / sm / md / lg` are ON the ramp: `assets/index.css`
     * rebinds `--radius-xs/sm/md/lg` to `sem.radius.chip/control/overlay/shell`
     * (3/7/7/9px), so `rounded-sm` IS `radius.control` and is the spelling the
     * kit uses. What is still off the ramp is the bare `rounded` (Tailwind's 4px
     * default) and `xl`/`2xl`/`3xl` (12/16/24px). Re-ruled 2026-09-02; before
     * that this axis counted every named step, which made the on-ramp spelling
     * look like growth. The `rounded-[5px]` literal that used to be tolerated
     * here (it was the token's value) is exactly what did not move when the ramp
     * moved to 7px, so all 64 of them were swept onto `rounded-sm` on
     * 2026-09-02; the ramp names are the target for that reason. `rounded-full` and
     * `rounded-[…]` are excluded: a pill and an explicit value are decisions,
     * not defaults — and the conformance guard's `radius-off-ramp` rule polices
     * explicit values off the ramp.
     */
    radius: /(?:^|["'\s`])-?rounded(?:-(?:[tblr]|[tb][lr]))?(?:-(?:xl|2xl|3xl))?(?=["'\s`])/g,
    /**
     * A shadow spelled with a color literal rather than a token. `transparent`
     * and `var(--…)` are fine — the failure mode is a TUNED color, because the
     * one that shipped was the dark-mode drawer value hardcoded into five
     * light-and-dark overlays.
     */
    shadow: /shadow-\[[^\]]*(?:rgba?\(|#[0-9a-fA-F]{3,8})[^\]]*\]/g,
    /** A stacking tier as a bare number, utility or arbitrary. */
    z: /(?:^|["'\s`])z-(?:\d+|\[\d+\])(?=["'\s`])/g,
    /** Tailwind's own type scale, sidestepping micro/meta/body/heading/title. */
    type: /(?:^|["'\s`])text-(?:xs|sm|base|lg|xl|2xl|3xl)(?=["'\s`])/g,
    /** Square boxes that should be on the `icon-*` / `size-icon-*` ramp. */
    icon: /(?:^|["'\s`])(?:size-(?:3|3\.5|4|5|6)|h-(?:3|3\.5|4|5|6) w-(?:3|3\.5|4|5|6))(?=["'\s`])/g,
  } as const

  type Axis = keyof typeof AXES

  /**
   * Today's measured counts, 2026-08-05. ONLY EVER EDIT THESE DOWNWARD.
   *
   * A directory absent from an axis is asserted at zero, so a new off-ramp in a
   * clean directory fails too — otherwise the ratchet would only police the
   * directories that already had a problem.
   */
  const BASELINE: Record<Axis, Record<string, number>> = {
    // The 2026-08-05 radius drop — workspace 193 → 186, panels 171 → 150, ui
    // 13 → 12, plus panels' icon axis 31 → 29 — is the button consolidation.
    // Every hand-rolled button in the Git surfaces, the settings tabs,
    // the chat cards, the creation hub and the guided brief gave up its own
    // `rounded-md` (and, in the Git rows, its own `h-6 w-6`) for a kit primitive
    // that spells neither. `ModalButton` accounts for the kit's one: it is a name
    // for the footer's three roles now, not a fourth button with a radius.
    // The 2026-08-05 field drop — settings 36 → 30, workspace 186 → 184, panels
    // 150 → 148, learn 2 → 1, modules 2 → 1 — is the input consolidation.
    // Every hand-rolled field in the settings tabs, the connectors
    // form, the creation wizard's knowledge step, the Learn centre's search and
    // a module's settings section (voice dictation, since removed) gave up its
    // own `rounded-md` for `ui/Input`, which spells the control radius once.
    // The 2026-08-05 menu/header drop — radius workspace 183 → 174, panels
    // 146 → 145, backlog 20 → 19, ui 12 → 9; type panels 18 → 17; icon ui
    // 22 → 21 — is the long tail outside the guards' directory scope.
    // Every menu row that had hand-rolled its own `rounded` fill (both
    // menubar fallbacks, the account menu, the reasoning selector,
    // the skills and connector pickers) takes `MENU_ITEM_CLASS`, which spells no
    // radius at all; and four header bands that drew themselves at their own
    // height — the kit's `WorkspacePanel` and `FilePreviewPane`, the
    // knowledge-graph drawer, both HTML-artifact bands — gave up their local
    // buttons for `ui/PanelHeader` and the kit primitives inside it.
    // The 2026-08-06 radius drop — workspace 174 → 169 — was the spawn
    // consolidation: `AgentComposerPopover` was deleted outright and its
    // replacement hung off the model picker's own popover surface instead of
    // hand-rolling a second one, so five `rounded-*` spellings left the tree with
    // it. (That replacement, `agentComposer/SpawnPicker.tsx`, was itself deleted
    // on 2026-09-08 — nothing had mounted it since `NewAgentPanel` took over.) Locked in here rather than
    // left as headroom, which is what lets the next regression show up as one.
    radius: {
      // 42 → 40: the launch panel's MenuRow and MenuValueRow gave up their
      // inset `rounded` fills for the full-bleed menu item classes
      // (remote-sessions-ux / selector-menus-premium).
      // 40 → 37, re-measured 2026-09-06: NewAgentPanel dropped two bare
      // `rounded`s — the scope line's dropdown took `rounded-sm`, the ramp
      // spelling (7a5ee9ef8), and the Backlog hand-off chip went with the row it
      // replaced (7823de27a) — and `newWorkspace/KnowledgeStep.tsx` left the tree
      // with the retired New workspace hub (8535af0c9). Nothing was swept for
      // this axis; these are three deletions the ratchet is now banking, because
      // headroom left unspent is where the next regression hides.
      // 37 → 29, 2026-09-08: the Design Wizard was deleted. Eight of those are
      // the HTML artifact frame's, which survived it and moved to
      // `components/htmlArtifact` below — the same off-ramps at a new address,
      // not a win — and the wizard's own panes took the rest with them.
      // workspace 10 → 8, 2026-09-16: the unmounted AgentComposer panel was deleted.
      // 8 → 7: shared attachment chips now use the documented radius ramp.
      // 7 → 6, 2026-10-01: the worktree switch took the raised chip's shell,
      // and its bare `rounded` went with the box it drew by hand.
      'components/workspace': 6, // 2026-09-16: the in-tree Sprint Engine surfaces left the tree with their off-ramps
      // 35 → 34, 2026-09-06: the retired plan door's plan column was deleted
      // with its door (a70ba0931).
      // 34 → 26, 2026-09-08: SwitchboardBoardPanel, SwitchboardWorkspacePanel and
      // the eight WatchtowerPanel files left the tree with their feature. Banked
      // rather than left as headroom — that is where the next regression hides.
      'components/panels': 15, // 2026-09-16: the in-tree Sprint Engine surfaces left the tree with their off-ramps
      // 30 → 29 with ui 9 → 10: the extension icon chip MOVED into the kit as
      // `ui/ExtensionIcon` (it was `McpBrandIcon` here) so the Skills and MCPs
      // aside could draw the same mark as the Extensions door. Its one
      // `rounded-lg` changed address — the CommandPalette precedent below —
      // rather than a new off-ramp appearing anywhere.
      // 15 → 17 when CommandPalette MOVED into the kit carrying its own
      // two radii — nothing regressed, the debt changed address — then 17 → 14
      // when the menu unification dropped ContextMenu's surface `rounded-md` and
      // its two per-item `rounded` fills, and 14 → 13 when the overlay geometry
      // canon took the palette's `rounded-xl`. The four other drops
      // that item paid for are in workspace (197 → 193), panels (173 → 171),
      // backlog (21 → 20) and diagnostics (7 → 6): every dialog-scale shell in
      // the product now draws `OVERLAY_SHELL_CLASS` instead of its own radius.
      // 3 → 2, 2026-09-08: the dead `ActionFeedback` / `__preview__` primitives
      // went with the knip sweep; banked, not left as headroom.
      // 2 → 1, 2026-09-10: the palette's hand-rolled `rounded` shortcut chip
      // became the kit's `KbdChord` — the drift its own spec had recorded.
      'components/ui': 1,
      // New directory, 2026-09-08: a MOVE out of `components/workspace` when the
      // HTML artifact frame left the deleted Design Wizard's folder.
      'components/htmlArtifact': 8,
    },
    // `utils/highlight.ts` is 14 of the 17: per-language terminal highlight rings,
    // each a tuned inset glow in the language's own hue. They are content colour
    // rather than surface elevation, and they have no token because the system
    // does not ship a language palette — recorded here rather than allowlisted,
    // so they stay visible as a debt with a known reason.
    shadow: {
      utils: 14,
      // 3 → 2 when the agent composer's nested engine flyout gave up its
      // hardcoded `0 18px 50px rgba(0,0,0,0.55)` for the shared floating chrome.
      // The two that remained were inset hairlines, not elevation;
      // 2 → 1 when the title bar's spawn split-button was deleted with its
      // frame. Locked in rather than left as headroom.
    },
    // 18 → 16 and backlog 1 → 0 when the overlay shells took their layer from the
    // `--z-*` tokens: the overlay dialogs gave up `z-50`, and the
    // agent composer's nested engine flyout named the popover
    // tier it was already sitting on. What remains on this axis is in-flow depth
    // inside a pane, not overlay layering.
    z: {
      // 6 → 5, 2026-09-08: the annotate overlay's in-flow layer moved out with
      // the HTML artifact frame; the overlay itself was deleted 2026-09-16.
      // 5 → 4, 2026-10-08: New chat's drop overlay became the composers' shared
      // one, on the ladder.
      'components/workspace': 4,
      // 10 → 9: FileExplorer's in-flow error toast (and its z-10) moved to the
      // app's one toast region (remote-sessions-ux / toast-host-region).
      // 9 → 8, 2026-09-06: the retired plan door's backlog source was deleted
      // with its door (a70ba0931).
      // 6 → 5, 2026-09-28: the chat's Jump to latest moved onto the ladder
      // when the queued message began floating over the transcript.
      // 5 → 4, 2026-10-08: the composer's drop overlay moved onto the ladder.
      'components/panels': 4,
      'components/ui': 1,
      'components/memory': 1,
      'components/auxWindows': 1,
    },
    type: {
      // 10 → 9: the session composer's raw `text-sm` became the `text-body`
      // token step (remote-sessions-ux / composer-surface-premium).
      'components/panels': 0, // 2026-09-16: the in-tree Sprint Engine surfaces left the tree with their off-ramps
      utils: 6,
      'components/diagnostics': 2,
    },
    // icon workspace 43 → 38 was the same consolidation as the radius
    // drop above: the deleted composer popover spelled its own icon boxes, and
    // `SpawnPicker` took the ramp classes the picker surface already used.
    // `SpawnPicker` itself was deleted on 2026-09-08 (see the workspace note
    // below); `NewAgentPanel` is the surface that mounts the picker now.
    icon: {
      // 30 → 21, 2026-09-06. This one is a repair, not a sweep. The ratchet had
      // actually GROWN to 31: the remote-machine tab chip (8866d95e6,
      // 2026-09-05) was a sixth copy of the same `h-4 w-4` plate + `h-3.5 w-3.5`
      // glyph that WorkspaceLayout already spelled five times, and
      // `newWorkspace/CreationRail.tsx` leaving with the retired hub (8535af0c9)
      // masked one of its two. Nobody saw the growth because verify:app has been
      // halting at an earlier step for days. Rather than raise the number for a
      // copy, WorkspaceLayout now spells that chip once — TAB_CHIP_CLASS and
      // TAB_CHIP_GLYPH_CLASS — so all six roles share it: 12 hand-spelled boxes
      // become 2, rendered output byte-identical. The geometry is still off the
      // ramp (14px falls between icon-xs 13 and icon-sm 16) and still owed; it is
      // now owed in one place instead of six. FileExplorer's tree glyphs account
      // for panels 24 → 23 (2158cff0a).
      // 23 → 12, 2026-09-08: the Switchboard and Watchtower panels were deleted
      // with their feature; banked here rather than left as headroom.
      // ui 16 → 14, 2026-09-08: the dead `ActionFeedback` and `__preview__`
      // primitives went with the knip sweep; banked, not left as headroom.
      // workspace 21 → 20, 2026-09-08: the title-bar Attention Queue was retired
      // (the sidebar rows and the Home glyph already carry "who is waiting"), and
      // `AttentionQueuePopover`'s hand-spelled tray glyph went with it. Banked
      // here rather than left as headroom for the next off-ramp.
      // workspace 20 → 12, 2026-09-08: the Design Wizard was deleted. Six of the
      // eight are the HTML artifact frame's, which survived the wizard and moved
      // to `components/htmlArtifact` (see its entry below) — the same off-ramps
      // at a new address, not a win. The other two went with the wizard's own
      // panes. Banked either way, so the next regression shows up as one.
      // workspace 12 → 11, 2026-09-08: `agentComposer/SpawnPicker.tsx` left the
      // tree in the orphan sweep — the picker-as-spawner that nothing has
      // mounted since NewAgentPanel became the live surface, so its one
      // hand-spelled icon box goes with it. Banked, not left as headroom.
      // workspace 11 → 10, 2026-09-16: the empty-pack notice uses the kit
      // InlineNotice rather than a hand-spelled icon box. Banked, not left as
      // headroom for the next off-ramp.
      // workspace 9 → 7, 2026-09-16: the unmounted AgentComposer panel was deleted.
      'components/workspace': 7, // 2026-09-16: the in-tree Sprint Engine surfaces left the tree with their off-ramps
      'components/panels': 4, // 2026-09-16: the in-tree Sprint Engine surfaces left the tree with their off-ramps
      // ui 14 → 13, 2026-09-09: the "Project colour" swatch row landed beside the
      // highlight one in `ContextMenu`, and rather than adding a fifth copy of the
      // 20px disc the file now spells it once (`SWATCH_DOT_SIZE_CLASS`) for all
      // four swatches — the same repair the tab chip took above. The geometry is
      // still off the ramp (20px sits between icon-md 18 and icon-lg 22) and still
      // owed; it is owed in one place instead of four. Banked, not left as
      // headroom for the next off-ramp.
      'components/ui': 8, // 2026-09-16: the in-tree Sprint Engine surfaces left the tree with their off-ramps
      // New directory, 2026-09-08 — a MOVE, not a regression. The Design Wizard
      // was deleted; the generated-HTML artifact frame survived it (the Backlog
      // mockup surfaces are its real consumers) and moved out of the wizard's
      // folder to `components/htmlArtifact`. Its off-ramps changed address out of
      // `components/workspace`, which drops by the same amount below.
      'components/htmlArtifact': 3, // 2026-09-08: the second swap
      'components/backlog': 2, // 2026-09-08: the second swap
      'components/settings': 1,
    },
  }

  /**
   * Sanctioned exceptions, subtracted from a file's count before it is compared.
   *
   * A ratchet whose exit is "every baseline at zero" needs somewhere to put the
   * cases that are RULED rather than owed — otherwise the exit is unreachable and
   * the baseline quietly becomes a permanent floor nobody remembers the reason
   * for. Each entry is a decision on the record, exactly as the colour axis
   * already does for brand marks.
   *
   * Keep these rare. An exception that is really "we have not got to it yet"
   * belongs in BASELINE, where it stays visible as debt.
   */
  const ALLOWED: Partial<Record<Axis, Record<string, { count: number; why: string }>>> = {
    icon: {
      'components/workspace/globalSurface/design/DesignRail.tsx': {
        count: 1,
        why:
          "the Design door's identity chip is a ruled 12px square — deliberately " +
          'NOT the 6px status circle, and not an icon at all. The icon ramp starts at ' +
          '`xs` = 13px, so it cannot be expressed on the ramp; adding a 12px icon step for ' +
          'a non-icon would be the wrong fix.',
      },
    },
  }

  /**
   * Hard rules: axes the KIT must be at zero on, forever.
   *
   * Radius and icon size are deliberately absent. The kit still spells 15 radii
   * and 22 icon boxes by hand; those drain through the ratchet with everything
   * else rather than being declared a hard rule the code does not yet meet, which
   * would only mean a red suite or a fat allowlist.
   */
  const KIT_HARD_RULES: Axis[] = ['shadow', 'z', 'type']

  /**
   * Kit files exempt from the `z` hard rule, each with its reason on the record.
   *
   * The rule is about OVERLAY LAYERS — surfaces that stack against each other
   * across the app. In-flow depth WITHIN a pane has its own token steps since
   * 2026-09-02 — `--z-sticky` 10, `--z-pane` 20, `--z-float` 30 — which is what
   * `SkillPickerPopover`'s composer surface now consumes; their exemptions were spent when that became true. The one left
   * spells a bare `z-10` and drains when it next moves.
   */
  const Z_HARD_RULE_EXEMPT: Record<string, string> = {
    'TerminalReplaySkeleton.tsx': 'z-10: a skeleton over its own terminal, not a layer',
  }

  function countsFor(files: string[], axis: Axis): Map<string, number> {
    const byArea = new Map<string, number>()
    for (const file of files) {
      const found = code(file).match(AXES[axis])
      if (!found) continue
      const allowed = ALLOWED[axis]?.[relative(RENDERER, file)]?.count ?? 0
      // `max(0, …)` so a shrinking file cannot drive a directory negative and
      // read as a phantom improvement.
      const counted = Math.max(0, found.length - allowed)
      if (counted === 0) continue
      byArea.set(area(file), (byArea.get(area(file)) ?? 0) + counted)
    }
    return byArea
  }

  function offendersFor(files: string[], axis: Axis, targetArea: string): string[] {
    return files
      .filter((file) => area(file) === targetArea && AXES[axis].test(code(file)))
      .map((file) => relative(RENDERER, file))
  }

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const rendererFiles = walk(RENDERER)
  const kitFiles = walk(KIT)

  // ── hard rules ───────────────────────────────────────────────────────────────

  for (const axis of KIT_HARD_RULES) {
    run(`the kit spells no ${axis} by hand`, () => {
      const offenders: string[] = []
      for (const file of kitFiles) {
        const name = file.split('/').pop() ?? ''
        if (axis === 'z' && name in Z_HARD_RULE_EXEMPT) continue
        const found = code(file).match(AXES[axis])
        if (found) offenders.push(`${relative(RENDERER, file)} → ${found.join(', ')}`)
      }
      assert.deepEqual(
        offenders,
        [],
        `a primitive that spells its own ${axis} exports the off-ramp to every host that copies it`,
      )
    })
  }

  run('every overlay layer in the kit resolves to the one ladder', () => {
    // The ladder of record is the bundle's `--sem-z-*`, aliased as `--z-*`
    // (assets/index.css): drawer 40 < modal 70 < popover 80 < menu 90 < toast
    // 100 — transients deliberately ABOVE modal (2026-08-05), so a picker
    // opened inside a dialog paints over the scrim. Before this there were two
    // ladders: the tokens' and a private one in `Modal.tsx`. Asserted per
    // surface, because "no bare numbers" alone would pass a file that simply
    // stopped stacking.
    const OVERLAYS: Record<string, string> = {
      'Modal.tsx': '--z-modal',
      'Drawer.tsx': '--z-drawer',
      'Popover.tsx': '--z-popover',
      'Tooltip.tsx': '--z-popover',
      'CursorErrorPopover.tsx': '--z-popover',
      'ContextMenu.tsx': '--z-menu',
      'PointerPopover.tsx': '--z-menu',
    }
    for (const [file, token] of Object.entries(OVERLAYS)) {
      const source = code(join(KIT, file))
      assert.ok(source.includes(token), `${file} stacks on ${token}, not on a number that happens to match it`)
    }
  })

  run('the ladder the kit consumes is the one the bundle publishes', () => {
    // The `--z-*` aliases must actually resolve to `--sem-z-*`. Without this the
    // kit could consume a second ladder that merely looked like the first.
    const appCss = readFileSync(join(RENDERER, 'assets/index.css'), 'utf8')
    for (const tier of ['sticky', 'drawer', 'popover', 'menu', 'modal', 'toast']) {
      assert.match(
        appCss,
        new RegExp(`--z-${tier}:\\s*var\\(--sem-z-${tier}\\)`),
        `--z-${tier} aliases the bundle's tier rather than restating a number`,
      )
    }
  })

  run('overlay elevation comes from a shadow token, in both themes', () => {
    // Five kit overlays hardcoded `0 8px 24px -12px rgba(0,0,0,0.6)`, which is
    // literally the value `--sem-shadow-drawer` takes in DARK mode — so every
    // light-theme popover cast a shadow tuned for a dark one, and
    // `--sem-shadow-popover` went unconsumed entirely.
    //
    // `Popover` and `ContextMenu` now take the whole chrome from
    // OVERLAY_SURFACE_CLASS rather than spelling the shadow themselves,
    // so they are asserted through the constant they consume — the token still has
    // to be reachable from each of them, which is what this checks.
    assert.match(
      code(join(KIT, 'tokens.ts')),
      /OVERLAY_SURFACE_CLASS[\s\S]*shadow-\[var\(--shadow-popover\)\]/,
      'the shared overlay chrome takes its elevation from the popover token',
    )
    for (const file of ['Popover.tsx', 'ContextMenu.tsx']) {
      assert.match(
        code(join(KIT, file)),
        /OVERLAY_SURFACE_CLASS|MENU_SURFACE_CLASS/,
        `${file} draws the shared overlay chrome rather than a copy of it`,
      )
    }
    for (const file of ['PointerPopover.tsx', 'CursorErrorPopover.tsx']) {
      assert.match(
        code(join(KIT, file)),
        /shadow-\[var\(--shadow-popover\)\]/,
        `${file} takes its elevation from the popover token, which is defined per theme`,
      )
    }
    // The skill picker used to be on that list: its type-ahead mode drew its own
    // `absolute` shell. Since 2026-09-08 both of its modes ride `Popover`, so the
    // elevation reaches it through the shell and spelling the token here again
    // would be the drift the shell exists to end.
    assert.doesNotMatch(
      code(join(KIT, 'SkillPickerPopover.tsx')),
      /shadow-\[/,
      'SkillPickerPopover draws no shell of its own — both modes ride Popover',
    )
  })

  // ── ratchets ─────────────────────────────────────────────────────────────────

  for (const axis of Object.keys(AXES) as Axis[]) {
    run(`${axis}: no directory grows a new off-ramp`, () => {
      const actual = countsFor(rendererFiles, axis)
      const baseline = BASELINE[axis]
      const areas = new Set([...Object.keys(baseline), ...actual.keys()])
      const grew: string[] = []
      const shrank: string[] = []
      for (const dir of areas) {
        const now = actual.get(dir) ?? 0
        const then = baseline[dir] ?? 0
        if (now > then) {
          const named = offendersFor(rendererFiles, axis, dir).slice(0, 6)
          grew.push(`${dir}: ${then} → ${now}  (files: ${named.join(', ')})`)
        } else if (now < then) {
          shrank.push(`${dir}: ${then} → ${now}`)
        }
      }
      assert.deepEqual(
        grew,
        [],
        `new ${axis} off-ramps. Use the token ramp, or if this is deliberate, say why in BASELINE`,
      )
      // Going down is the point — but a stale baseline hides the next regression
      // under the slack it leaves, so it has to be spent rather than banked.
      assert.deepEqual(
        shrank,
        [],
        `${axis} off-ramps went DOWN — good. Lower these numbers in BASELINE to lock the win in`,
      )
    })
  }

  // ── the menu family agrees ───────────────────────────────────────────────────
  // The symptom that started the whole audit: a row could be right-clicked and
  // kebab-pressed into two menus that disagreed on radius, border, ground, item
  // type, hover shape and divider. Nothing was comparing them, because each was
  // internally consistent — the defect only existed BETWEEN components.
  //
  // Source of truth: `design-system/components/menu/component.md` — the
  // spec that fixes these values and names the anti-patterns; when it and the code
  // disagree, the spec is right. The menu sweep then made the
  // agreement structural: the values live in `menuClasses.ts`, every host
  // consumes them, and none of them can restate one. So these assertions moved
  // with the code — they check the canon once, then check that nothing spells it
  // twice, which is the only shape that stays true as hosts are added.

  const MENU_CANON = join(KIT, 'menuClasses.ts')
  // Every menu surface in the app. Select is here because its popup is the same
  // object at a different role: same chrome, same row geometry, same highlight —
  // its option keeps `text-body` to match the trigger it echoes, which is a
  // ruling (design-system/components/select), not a drift.
  const MENU_HOSTS = ['ContextMenu.tsx', 'OverflowMenu.tsx', 'FilterMenu.tsx', 'SplitButton.tsx', 'Select.tsx'] as const

  run('the menu canon is stated once, with the ruled values', () => {
    const canon = code(MENU_CANON)
    const chrome = code(join(KIT, 'tokens.ts'))
    for (const [pattern, why] of [
      ['rounded-\\[7px\\]', 'radius.overlay, like every other floating surface'],
      ['--border-strong', 'the popover border, not border-default'],
      ['--bg-surface-raised', 'the popover ground, not bg-surface'],
      ['--shadow-popover', 'the popover elevation token'],
    ] as const) {
      assert.match(chrome, new RegExp(pattern), `the shared overlay chrome must use ${why}`)
    }
    assert.match(canon, /OVERLAY_SURFACE_CLASS/, 'the menu surface is the overlay chrome plus a list')
    assert.match(canon, /text-meta/, 'menu items are chrome (12px), not body copy')
    assert.match(canon, /--border-subtle/, 'the divider separates siblings inside a bordered surface')
    assert.match(canon, /FOCUS_RING_INSET_CLASS/, 'a full-bleed row would clip an outset ring')
    assert.ok(!/\bp-1\b/.test(canon), 'vertical padding only — horizontal surface padding is what forces an inset fill')
    assert.ok(
      !/\brounded\b/.test(canon.replace(/rounded-\[7px\]/g, '')),
      'a menu item with its own radius is the inset-fill shape the spec rules out',
    )
  })

  run('no menu host restates a value the canon already carries', () => {
    for (const file of MENU_HOSTS) {
      const source = code(join(KIT, file))
      assert.match(
        source,
        /from '\.\/menuClasses'/,
        `${file} must take the menu canon from menuClasses, not from a copy of it`,
      )
      assert.ok(
        !/px-2\.5 py-1\.5/.test(source),
        `${file} spells the menu row's own geometry; that is how the five drifted apart`,
      )
      assert.ok(
        !/rounded-\[7px\]/.test(source),
        `${file} draws its own overlay chrome instead of taking the shared surface`,
      )
      assert.ok(
        !/bg-\[color:var\(--border-/.test(source),
        `${file} draws its own divider; MenuDivider / MENU_DIVIDER_CLASS is the one line`,
      )
      // Covers the nested case as well as the flat one: `OverflowMenu` used to
      // pass `text-meta` into MenuFlyoutItem's `surfaceClassName` to drag the
      // submenu down to its own size, with a comment calling ContextMenu "the 13px
      // right-click idiom". The size travels with the item now, so a host that
      // re-pins a flyout is rebuilding the divergence the spec retired — and a
      // submenu is exactly where it would go unnoticed longest.
      assert.ok(
        !/surfaceClassName=(?:\{`|")[^`"]*\btext-(?:meta|body|micro)\b/.test(source),
        `${file} pins a type size onto a menu surface — the per-host pin the class pair replaced`,
      )
    }
  })

  run('a group label never outweighs the rows it heads', () => {
    // The last hand-rolled treatment: FilterMenu's heading was `text-subtle` and
    // unweighted, MenuSwatchRow's caption `text-muted` and `font-medium`. The spec
    // rules the first — a label heavier than its own contents inverts the
    // hierarchy it exists to state.
    assert.match(
      code(MENU_CANON),
      /MENU_GROUP_LABEL_CLASS[\s\S]*text-micro[\s\S]*--text-subtle/,
      'the group label is micro at text-subtle, on the item inset',
    )
    assert.ok(
      !/font-medium text-\[color:var\(--text-muted\)\]/.test(code(MENU_CANON)),
      'and it carries no weight of its own',
    )
    for (const file of ['ContextMenu.tsx', 'FilterMenu.tsx']) {
      assert.match(code(join(KIT, file)), /MENU_GROUP_LABEL_CLASS/, `${file} takes its group heading from the canon`)
    }
  })

  run('destructive is ink, never a fill', () => {
    for (const file of MENU_HOSTS) {
      assert.ok(
        !/rgba\(255,\s*120,\s*124/.test(code(join(KIT, file))),
        `${file}'s danger row carried a raw rgba hover tint — a second signal saying what the ink already says`,
      )
    }
    assert.match(code(join(KIT, 'ContextMenu.tsx')), /--tone-error/, 'and it still says it in ink')
  })

  run('no sanctioned exception has gone stale', () => {
    // An allowlist entry that no longer matches anything is a decision still on
    // the record for code that has moved on — and the next person reads it as
    // describing the file in front of them. Same discipline as the ratchet: an
    // exception has to be spent when it stops being true.
    for (const [axis, entries] of Object.entries(ALLOWED) as Array<
      [Axis, Record<string, { count: number; why: string }>]
    >) {
      for (const [file, entry] of Object.entries(entries)) {
        const full = join(RENDERER, file)
        assert.ok(
          rendererFiles.includes(full),
          `${axis} allows ${entry.count} in ${file}, but that file no longer exists — drop the entry`,
        )
        const found = code(full).match(AXES[axis])?.length ?? 0
        assert.ok(
          found >= entry.count,
          `${axis} allows ${entry.count} in ${file} but only ${found} remain — lower or drop the entry (${entry.why})`,
        )
      }
    }
  })

  // ── notices and empty states come from the kit ─────────────────────
  //
  // Two rules, because the consolidation had two halves and each has a distinct
  // failure mode a ratchet would not catch.
  //
  // The LEFT TONE-BAR is on `foundations/principles.md`'s reject-on-sight list and
  // is re-stated in `components/inline-notice/component.md` and in
  // `InlineNotice.tsx`'s own header — and it was rebuilt by hand about twenty
  // times ANYWAY, four of them in Settings, one of them (`ChatNotice`) three
  // scrolls from an unused `InlineNotice` import. A rule that is written in three
  // places and enforced in none is not a rule. It is enforced here.
  //
  // The EMPTY STATE half is a different shape: nobody rebuilds it by copying a
  // banned pattern, they rebuild it by writing a centred div — so what is policed
  // is the NAME. A component that calls itself an empty state must be the kit's
  // one, wrapped; if the name is right and the kit is absent, it is a sixth
  // dialect starting.

  /**
   * A COLOURED left bar: a left-border utility carrying a tone/accent hue, in
   * either order within one class string, plus the two indirect spellings (an
   * inline `borderColor`, and a hex literal painted onto the left edge).
   *
   * A NEUTRAL left bar is deliberately not matched. `border-l-2
   * border-[color:var(--border-strong)]` is the quote/aside idiom — what
   * `utils/markdown.tsx` renders a blockquote as — and it carries no tone, so it
   * is not the thing the system rejects.
   */
  const LEFT_TONE_BAR =
    /border-l(?:-(?:2|4|\[\d+(?:\.\d+)?px\]))?[^"'`\n]{0,160}?border-(?:l-)?\[color:var\(--(?:tone|accent)-|border-(?:l-)?\[color:var\(--(?:tone|accent)-[^"'`\n]{0,160}?border-l(?:-(?:2|4|\[\d+(?:\.\d+)?px\]))?(?=[\s"'`])|border-l-\[#[0-9a-fA-F]{3,8}\]|border-l(?:-(?:2|4|\[\d+(?:\.\d+)?px\]))?[^"'`\n]{0,80}?borderColor/g

  /** Ruled exceptions to the left-bar rule. Each one is a decision on the record. */
  const LEFT_BAR_RULED: Record<string, { count: number; why: string }> = {
    'utils/highlight.ts': {
      count: 7,
      why:
        'RULED 2026-08-05 — the seven Backlog identity swatches. This bar is a row’s EPIC ' +
        'IDENTITY (a hue the user picked), never a notice: no tone vocabulary, no severity, ' +
        'nothing to recover from, and never the only carrier (the epic chip names it in words). ' +
        'The reasoning is in components/backlog/backlogRowPaint.ts, which this marker points at.',
    },
  }

  run('no tone-coloured left bar survives, outside its ruling', () => {
    const offenders: string[] = []
    for (const file of rendererFiles) {
      const found = code(file).match(LEFT_TONE_BAR)
      if (!found) continue
      const ruled = LEFT_BAR_RULED[relative(RENDERER, file)]?.count ?? 0
      if (found.length > ruled) {
        offenders.push(`${relative(RENDERER, file)} → ${found.slice(0, 3).join(', ')}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a tone-coloured left bar is the rejected-on-sight notice. Use `ui/InlineNotice` (scoped) or ' +
        '`ui/Banner` (panel-spanning); if the bar is genuinely not a notice, rule on it in LEFT_BAR_RULED',
    )
  })

  /** A component whose NAME claims the empty-state job. */
  const EMPTY_STATE_COMPONENT =
    /(?:function|const)\s+(?:[A-Z]\w*)?(?:Empty\w*|Centered(?:Message|State|Error)\w*)\s*[({=]/g

  /** Named like an empty state, ruled to be something else. */
  const EMPTY_STATE_RULED: Record<string, string> = {
    'components/workspace/globalSurface/design/NewDesignSystemScreen.tsx':
      'RULED 2026-08-05 — `EmptySystemStage` is a card’s dashed PREVIEW placeholder at a fixed ' +
      'preview height, inside a card that is not empty. Not a surface with nothing to show.',
  }

  run('an empty state is the kit’s, or it is ruled not to be one', () => {
    const offenders: string[] = []
    for (const file of rendererFiles) {
      const relativePath = relative(RENDERER, file)
      if (relativePath.startsWith('components/ui/')) continue
      const source = code(file)
      if (!EMPTY_STATE_COMPONENT.test(source)) continue
      EMPTY_STATE_COMPONENT.lastIndex = 0
      if (/\bEmptyState\b/.test(source)) continue
      if (relativePath in EMPTY_STATE_RULED) continue
      offenders.push(relativePath)
    }
    assert.deepEqual(
      offenders,
      [],
      'a component named for the empty-state job that does not consume `ui/EmptyState` is the ' +
        'next dialect. Wrap the primitive, or rule on it in EMPTY_STATE_RULED',
    )
  })

  run('no notice or empty-state ruling has gone stale', () => {
    for (const [file, entry] of Object.entries(LEFT_BAR_RULED)) {
      const full = join(RENDERER, file)
      assert.ok(rendererFiles.includes(full), `${file} is ruled on but no longer exists — drop the entry`)
      const found = code(full).match(LEFT_TONE_BAR)?.length ?? 0
      assert.equal(
        found,
        entry.count,
        `${file} is ruled for ${entry.count} left bars but has ${found} — re-count or re-rule`,
      )
    }
    for (const file of Object.keys(EMPTY_STATE_RULED)) {
      const full = join(RENDERER, file)
      assert.ok(rendererFiles.includes(full), `${file} is ruled on but no longer exists — drop the entry`)
      EMPTY_STATE_COMPONENT.lastIndex = 0
      assert.ok(
        EMPTY_STATE_COMPONENT.test(code(full)),
        `${file} is ruled as a non-empty-state but no longer declares one — drop the entry`,
      )
      EMPTY_STATE_COMPONENT.lastIndex = 0
    }
  })

  run('every policed axis has a baseline, and the exit is all of them at zero', () => {
    for (const axis of Object.keys(AXES) as Axis[]) {
      assert.ok(axis in BASELINE, `${axis} is scanned, so it must carry a baseline`)
    }
    const remaining = Object.entries(BASELINE).map(
      ([axis, dirs]) => `${axis} ${Object.values(dirs).reduce((a, b) => a + b, 0)}`,
    )
    console.log(`   remaining off-ramps — ${remaining.join(', ')}`)
  })

  if (failures > 0) {
    console.error(`\ndesignSystemAxes.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('design system axes: all checks passed')
})

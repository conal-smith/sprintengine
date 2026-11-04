import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('buttonSpecies', async () => {
  // The button family's five new species, and the variants the sweep
  // proved were missing (2026-09-08).
  //
  // 220 raw <button>/<input>/<textarea> in product code had no kit member that
  // reproduced them. These assertions are aimed at the reasons the hand-rolls
  // existed, not at the styling they happened to get right:
  //
  //   - a state that a caller CANNOT paint through `className`, because two
  //     utilities of equal specificity are resolved by stylesheet order (the
  //     failure every one of these primitives exists to make impossible),
  //   - the attributes a row has to pass through to be usable at all,
  //   - and the one-declaration-per-property rule, checked mechanically: a class
  //     list carrying two `hover:bg-…` or two `rounded-…` is a coin flip that
  //     reads as working.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver
  domWindow.api = { platform: 'darwin' }

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

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')

    const {
      CaptionButton,
      DangerButton,
      FloatingButton,
      GhostButton,
      IconButton,
      MediaButton,
      OutlineButton,
      PrimaryButton,
      SendButton,
    } = await import('./Buttons')
    const { ComposerActionButton } = await import('../panels/agentChat/composerControls')
    const { RowButton } = await import('./RowButton')
    const { MenuOption } = await import('./MenuOption')
    const { TriggerButton } = await import('./TriggerButton')
    const { CardButton } = await import('./CardButton')
    const { ChipButton } = await import('./ChipButton')
    const { LinkButton } = await import('./LinkButton')
    const { Input, Textarea } = await import('./Input')
    const { Checkbox } = await import('./Checkbox')
    const { MenuItem } = await import('./ContextMenu')

    const document = dom.window.document

    function mount(node: React.ReactNode): { container: HTMLElement; unmount: () => void } {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(node)
      })
      return {
        container: container as unknown as HTMLElement,
        unmount: () => {
          act(() => root.unmount())
          container.remove()
        },
      }
    }

    function classesOf(node: React.ReactNode, selector = 'button, input, textarea'): string {
      const view = mount(node)
      const el = view.container.querySelector(selector)
      const classes = el?.getAttribute('class') ?? ''
      view.unmount()
      return classes
    }

    function attrOf(node: React.ReactNode, attribute: string, selector = 'button, input, textarea'): string | null {
      const view = mount(node)
      const el = view.container.querySelector(selector)
      const value = el?.getAttribute(attribute) ?? null
      view.unmount()
      return value
    }

    /**
     * The mechanical form of "one declaration per property". Two utilities that
     * set the same CSS property under the same variant are resolved by STYLESHEET
     * ORDER, not by the order they appear in a class string — so a class list that
     * carries both is a coin flip, and it is a coin flip that renders correctly
     * about half the time, which is why every instance of it shipped.
     */
    function duplicateUtilities(classes: string): string[] {
      const seen = new Map<string, number>()
      for (const candidate of classes.split(/\s+/).filter(Boolean)) {
        const parts = /^((?:[\w-]+:)*)(.+)$/.exec(candidate)
        if (!parts) continue
        const [, variant, utility] = parts
        let property: string | null = null
        if (utility.startsWith('bg-')) property = 'background'
        else if (utility.startsWith('text-[color:')) property = 'color'
        else if (/^text-(?:micro|meta|body|heading|title|\[length:)/.test(utility)) property = 'font-size'
        else if (/^border(?:-\d+)?$/.test(utility)) property = 'border-width'
        else if (/^border-(?:solid|dashed|dotted|none)$/.test(utility)) property = 'border-style'
        else if (utility.startsWith('border-[color:')) property = 'border-color'
        else if (utility.startsWith('rounded')) property = 'border-radius'
        else if (utility.startsWith('justify-')) property = 'justify-content'
        else if (utility.startsWith('items-')) property = 'align-items'
        else if (utility.startsWith('h-')) property = 'height'
        else if (utility.startsWith('w-')) property = 'width'
        else if (utility.startsWith('cursor-')) property = 'cursor'
        else if (utility.startsWith('opacity-')) property = 'opacity'
        if (!property) continue
        const key = `${variant}${property}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
      return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key)
    }

    // ── The inline size ───────────────────────────────────────────────────────

    run('size="inline" spends no ramp height, and is not an unstyled escape hatch', () => {
      const classes = classesOf(<GhostButton size="inline">Undo</GhostButton>)
      assert.ok(!/h-control-/.test(classes), 'no ramp height — it rides the line it is set in')
      assert.match(classes, /rounded-xs/, 'radius.chip, not the 7px control radius')
      assert.match(classes, /focus-visible:focus-ring/, 'the kit focus ring still applies')
      assert.match(classes, /hover:bg-\[color:var\(--bg-hover\)\]/, 'and the kit hover treatment')
      assert.match(classes, /interactive/, 'and the press scale')
    })

    run('every button size carries exactly one radius and one alignment', () => {
      for (const size of ['inline', 'xs', 'sm', 'md'] as const) {
        for (const align of ['center', 'start', 'end'] as const) {
          const classes = classesOf(
            <GhostButton size={size} align={align}>
              Go
            </GhostButton>,
          )
          assert.deepEqual(
            duplicateUtilities(classes),
            [],
            `GhostButton size=${size} align=${align} declares a property twice`,
          )
        }
      }
    })

    // ── The round send (owner ruling 2026-10-04) ─────────────────────────────

    run('SendButton is the primary made round: the pill corner replaces the size step’s', () => {
      for (const size of ['inline', 'xs', 'sm', 'md'] as const) {
        const classes = classesOf(<SendButton size={size}>Schedule</SendButton>)
        assert.match(classes, /rounded-\[var\(--sem-radius-pill\)\]/, `size=${size} is round`)
        assert.ok(!/(?:^|\s)rounded-(?:xs|sm)(?:\s|$)/.test(classes), `size=${size} drops the step’s own radius`)
        assert.deepEqual(duplicateUtilities(classes), [], `SendButton size=${size} declares a property twice`)
        assert.match(classes, /bg-\[color:var\(--accent-primary\)\]/, 'the primary’s fill')
        // Nothing to send is a neutral disc, not a dimmed accent one (2026-11-04).
        assert.match(classes, /(?:^|\s)disabled:bg-\[color:var\(--bg-active\)\]/, 'its neutral disabled ground')
        assert.match(classes, /disabled:hover:bg-\[color:var\(--bg-active\)\]/, 'and its disabled hover guard')
        assert.ok(!/disabled:opacity-/.test(classes), 'and no dimming on top of it')
        assert.match(classes, /control-raised/, 'and its one lit edge (tier 1)')
      }
      assert.equal(attrOf(<SendButton busy>Save</SendButton>, 'aria-busy'), 'true')
      assert.equal(attrOf(<SendButton>Save</SendButton>, 'type'), 'button')
    })

    run('the open composer’s send is one disc: one width and one inline padding', () => {
      const classes = classesOf(
        <ComposerActionButton tone="accent" ariaLabel="Send" onClick={() => {}}>
          <svg />
        </ComposerActionButton>,
      )
      assert.match(classes, /rounded-\[var\(--sem-radius-pill\)\]/)
      assert.deepEqual(duplicateUtilities(classes), [])
      // `px-0` beside the size step's `px-2` is resolved by stylesheet order
      // (Tailwind emits `px-2` after `px-0`, so it is dead weight that reads as
      // a decision). The disc is squared by its width alone.
      const paddings = classes.split(/\s+/).filter((c) => c.startsWith('px-'))
      assert.ok(paddings.length <= 1, `two inline paddings on the send: ${paddings.join(' ')}`)
    })

    // ── Ghost tones ───────────────────────────────────────────────────────────

    run('the ghost ink vocabulary is a prop, and each tone is a distinct pair', () => {
      const inks = new Set<string>()
      for (const tone of ['neutral', 'danger', 'quiet', 'subtle', 'strong', 'accent', 'ink'] as const) {
        const classes = classesOf(<GhostButton tone={tone}>x</GhostButton>)
        assert.deepEqual(duplicateUtilities(classes), [], `tone=${tone} declares a property twice`)
        const rest = /(?:^|\s)text-\[color:var\((--[\w-]+)\)\]/.exec(classes)
        assert.ok(rest, `tone=${tone} states a resting ink`)
        inks.add(`${tone}:${rest?.[1]}`)
      }
      assert.equal(inks.size, 7, 'seven tones, seven ink pairs — none is a duplicate of another')
    })

    run('tone="accent" and tone="ink" take no ground at any state', () => {
      for (const tone of ['accent', 'ink'] as const) {
        const classes = classesOf(<GhostButton tone={tone}>x</GhostButton>)
        assert.ok(
          !/hover:bg-\[color:var\(--bg-hover\)\]/.test(classes),
          `tone=${tone} paints no hover ground — it lives inside something that already has one`,
        )
      }
    })

    // ── pressed / armed ───────────────────────────────────────────────────────

    run('a pressed ghost holds its fill under the pointer', () => {
      const classes = classesOf(<GhostButton pressed>Locked</GhostButton>)
      assert.match(classes, /hover:bg-\[color:var\(--bg-selected\)\]/, 'hover repaints the selection fill')
      assert.ok(
        !/hover:bg-\[color:var\(--bg-hover\)\]/.test(classes),
        'and the resting hover step is absent rather than overridden',
      )
      assert.deepEqual(duplicateUtilities(classes), [])
    })

    run('pressed is tri-state on every member that has it', () => {
      assert.equal(attrOf(<GhostButton>Go</GhostButton>, 'aria-pressed'), null, 'undefined emits nothing')
      assert.equal(attrOf(<GhostButton pressed={false}>Go</GhostButton>, 'aria-pressed'), 'false')
      assert.equal(attrOf(<GhostButton pressed>Go</GhostButton>, 'aria-pressed'), 'true')
      assert.equal(attrOf(<OutlineButton>Go</OutlineButton>, 'aria-pressed'), null)
      assert.equal(attrOf(<OutlineButton pressed={false}>Go</OutlineButton>, 'aria-pressed'), 'false')
      assert.equal(attrOf(<ChipButton>Go</ChipButton>, 'aria-pressed'), null)
      assert.equal(attrOf(<ChipButton pressed={false}>Go</ChipButton>, 'aria-pressed'), 'false')
    })

    run('armed is the accent as a TINT and outranks pressed', () => {
      const classes = classesOf(
        <GhostButton armed pressed>
          Recording
        </GhostButton>,
      )
      assert.match(classes, /bg-\[color:var\(--accent-primary-soft\)\]/, 'the soft tint, never the solid fill')
      assert.ok(!/bg-\[color:var\(--accent-primary\)\]/.test(classes), 'the view keeps its one solid accent')
      assert.ok(!/bg-\[color:var\(--bg-selected\)\]/.test(classes), 'listening outranks merely chosen')
      assert.deepEqual(duplicateUtilities(classes), [])
    })

    run('busy says wait, not no', () => {
      const busy = classesOf(<GhostButton busy>Opening</GhostButton>)
      assert.match(busy, /cursor-wait/)
      assert.ok(!/cursor-not-allowed/.test(busy), 'one cursor declaration, not two settled by stylesheet order')
      assert.equal(attrOf(<GhostButton busy>Opening</GhostButton>, 'aria-busy'), 'true')
      const idle = classesOf(<GhostButton>Open</GhostButton>)
      assert.match(idle, /disabled:cursor-not-allowed/)
      assert.ok(!/cursor-wait/.test(idle))
    })

    run('aria-disabled keeps the tab stop and still reads as off', () => {
      const view = mount(<GhostButton aria-disabled="true">Annotate</GhostButton>)
      const button = view.container.querySelector('button')
      assert.equal(button?.hasAttribute('disabled'), false, 'still focusable, so its tooltip is reachable')
      assert.match(button?.getAttribute('class') ?? '', /aria-disabled:opacity-45/, 'and still drawn as unavailable')
      view.unmount()
    })

    // ── IconButton below the ramp ─────────────────────────────────────────────

    run('every sub-24px icon step pads out to the hit-target floor', () => {
      for (const size of ['inline', '3xs', '2xs'] as const) {
        const classes = classesOf(<IconButton aria-label="Star" size={size} />)
        assert.match(
          classes,
          /before:size-\[var\(--hit-target-min\)\]/,
          `size=${size} keeps its drawn box small and its TARGET at the floor`,
        )
        assert.match(classes, /rounded-xs/, `size=${size} takes radius.chip, not the control radius`)
      }
      const xs = classesOf(<IconButton aria-label="Reload" size="xs" />)
      assert.match(xs, /size-\[var\(--hit-target-min\)\]/, 'xs IS the floor, so it needs no pad')
      assert.ok(!/before:size-/.test(xs))
    })

    run('shape="circle" is a hairline badge with no ground and one radius', () => {
      const classes = classesOf(<IconButton aria-label="Info" size="3xs" shape="circle" tone="ink" />)
      assert.match(classes, /rounded-full/)
      assert.ok(!/rounded-xs/.test(classes), 'the circle radius replaces the size step’s, it does not join it')
      assert.match(classes, /border-\[color:var\(--border-default\)\]/)
      assert.ok(
        !/hover:bg-\[color:var\(--bg-hover\)\]/.test(classes),
        'a badge never fills — the hover moves the border and the ink',
      )
      assert.deepEqual(duplicateUtilities(classes), [])
    })

    run('the caption button is the platform’s shape, and says so', () => {
      const neutral = classesOf(<CaptionButton aria-label="Minimize window" />)
      assert.match(neutral, /w-control-lg/, '40px, the platform cluster width')
      assert.match(neutral, /self-stretch/, 'it takes the title strip’s height rather than a ramp one')
      assert.ok(!/rounded/.test(neutral), 'no radius: a caption button fills its corner square')
      assert.match(neutral, /focus-visible:focus-ring-inset/, 'an outset ring at the window corner is clipped')
      assert.match(neutral, /focus:bg-/, 'the OS keyboard highlight shows on plain focus')
      const close = classesOf(<CaptionButton aria-label="Close window" tone="close" />)
      // design-tokens-allow: asserting the Windows-native close red reaches the class string is the point of the check; the value is the platform's, not a colour this system chooses
      assert.match(close, /hover:bg-\[#c42b1c\]/, 'the platform’s own close red, not one of ours')
    })

    run('the media button paints no ink and no ground', () => {
      const classes = classesOf(<MediaButton aria-label="Open screenshot" />)
      assert.match(classes, /overflow-hidden/, 'so the image takes the control’s radius')
      assert.ok(!/text-\[color:/.test(classes), 'its surface is a picture; an ink would land on it')
      assert.ok(!/hover:bg-/.test(classes), 'and so would a ground')
      assert.match(classes, /focus-visible:focus-ring/)
    })

    // ── RowButton ─────────────────────────────────────────────────────────────

    run('a row is full-width, left-aligned, and never centred on a ramp height', () => {
      const classes = classesOf(<RowButton>Workspace</RowButton>)
      assert.match(classes, /w-full/)
      assert.match(classes, /text-left/)
      assert.ok(!/justify-center/.test(classes))
      assert.ok(!/h-control-/.test(classes), 'content height: the children decide')
      assert.ok(!/interactive/.test(classes), 'a full-width row that shrank would detach from its neighbours')
    })

    run('a selected row drops the hover step rather than repainting over it', () => {
      const selected = classesOf(<RowButton selected>Workspace</RowButton>)
      assert.match(selected, /bg-\[color:var\(--bg-selected\)\]/)
      assert.match(selected, /ring-\[color:var\(--selection-edge\)\]/, 'the edge, read through the resting-tier alias')
      assert.ok(
        !/hover:bg-\[color:var\(--bg-hover\)\]/.test(selected),
        '--bg-hover sits BELOW --bg-selected, so hovering a selected row would dim it',
      )
      assert.deepEqual(duplicateUtilities(selected), [])
      assert.equal(attrOf(<RowButton selected>W</RowButton>, 'aria-current'), 'true')
      assert.equal(attrOf(<RowButton>W</RowButton>, 'aria-current'), null)
    })

    run('the full-bleed densities take the inset ring, the inset ones take the outset ring', () => {
      for (const density of ['bleed', 'flush'] as const) {
        const classes = classesOf(<RowButton density={density}>Row</RowButton>)
        assert.match(classes, /focus-visible:focus-ring-inset/, `${density} touches its container edge`)
        assert.ok(!/rounded-/.test(classes), `${density} draws no radius of its own`)
      }
      for (const density of ['row', 'nav'] as const) {
        const classes = classesOf(<RowButton density={density}>Row</RowButton>)
        assert.match(classes, /focus-visible:focus-ring(?!-inset)/)
        assert.match(classes, /rounded-md/)
      }
    })

    run('density="flush" draws no ground in any state', () => {
      const classes = classesOf(<RowButton density="flush">Half</RowButton>)
      assert.ok(!/bg-/.test(classes), 'the wrapping row owns the fill; a second one would be a box in a box')
    })

    run('the dashed variant is the "New …" affordance, and only it has a dashed edge', () => {
      const dashed = classesOf(<RowButton variant="dashed">New workspace</RowButton>)
      assert.match(dashed, /border-dashed/)
      const plain = classesOf(<RowButton>Workspace</RowButton>)
      assert.ok(!/border-dashed/.test(plain))
    })

    run('a row passes through what a rail actually needs', () => {
      const view = mount(
        <RowButton data-rail-row="rich" role="option" tabIndex={0} aria-expanded="false">
          Row
        </RowButton>,
      )
      const button = view.container.querySelector('button')
      assert.equal(button?.getAttribute('data-rail-row'), 'rich', 'the hook a roving-focus query selects on')
      assert.equal(button?.getAttribute('role'), 'option')
      assert.equal(button?.getAttribute('tabindex'), '0', 'the caller decides where the tab stop is')
      assert.equal(button?.getAttribute('aria-expanded'), 'false')
      view.unmount()
    })

    // ── MenuOption ────────────────────────────────────────────────────────────

    run('the option emits the state attribute its ROLE actually takes', () => {
      assert.equal(
        attrOf(
          <MenuOption role="option" selected>
            A
          </MenuOption>,
          'aria-selected',
        ),
        'true',
      )
      assert.equal(attrOf(<MenuOption role="option">A</MenuOption>, 'aria-selected'), 'false')
      assert.equal(
        attrOf(
          <MenuOption role="option" selected>
            A
          </MenuOption>,
          'aria-checked',
        ),
        null,
      )
      for (const role of ['radio', 'menuitemradio', 'menuitemcheckbox'] as const) {
        assert.equal(
          attrOf(
            <MenuOption role={role} selected>
              A
            </MenuOption>,
            'aria-checked',
          ),
          'true',
        )
        assert.equal(attrOf(<MenuOption role={role}>A</MenuOption>, 'aria-checked'), 'false')
        assert.equal(
          attrOf(
            <MenuOption role={role} selected>
              A
            </MenuOption>,
            'aria-selected',
          ),
          null,
        )
      }
    })

    run('a selected option suppresses hover instead of fighting it', () => {
      const selected = classesOf(
        <MenuOption role="option" selected>
          A
        </MenuOption>,
      )
      assert.match(selected, /bg-\[color:var\(--bg-selected\)\]/)
      assert.ok(
        !/(?:^|\s)hover:bg-/.test(selected),
        'the row would dim under the pointer otherwise (the `disabled:hover:` guard is a different variant)',
      )
      const resting = classesOf(<MenuOption role="option">A</MenuOption>)
      assert.match(resting, /hover:bg-\[color:var\(--bg-hover\)\]/)
      assert.deepEqual(duplicateUtilities(selected), [])
      assert.deepEqual(duplicateUtilities(resting), [])
    })

    run('the option is the same material as the menu item beside it', () => {
      const option = classesOf(<MenuOption role="option">A</MenuOption>)
      const item = classesOf(<MenuItem onClick={() => {}}>A</MenuItem>)
      for (const shared of ['px-2.5', 'py-1.5', 'gap-2', 'text-left', 'focus-visible:focus-ring-inset']) {
        assert.ok(option.includes(shared), `option carries ${shared}`)
        assert.ok(item.includes(shared), `item carries ${shared}`)
      }
    })

    run('the option passes through the tab stop and the data hooks', () => {
      const view = mount(
        <MenuOption role="radio" tabIndex={0} data-machine-option="local" selected>
          Local
        </MenuOption>,
      )
      const button = view.container.querySelector('button')
      assert.equal(button?.getAttribute('tabindex'), '0', 'the checked row is the group’s single tab stop')
      assert.equal(button?.getAttribute('data-machine-option'), 'local')
      view.unmount()
    })

    run('MenuItem hands its handler the event, and takes a caller tabIndex', () => {
      let seen: unknown = null
      const view = mount(
        <MenuItem onClick={(event) => (seen = event)} tabIndex={0} data-menu-item="true" expanded>
          Open
        </MenuItem>,
      )
      const button = view.container.querySelector('button')
      assert.equal(button?.getAttribute('tabindex'), '0')
      assert.equal(button?.getAttribute('aria-expanded'), 'true', 'a drill-in row says it opens something')
      act(() => {
        button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.ok(seen, 'the app menu positions its native popup from the clicked row’s rect')
      view.unmount()
    })

    // ── TriggerButton ─────────────────────────────────────────────────────────

    run('the trigger is a field, not a pressable control', () => {
      const classes = classesOf(<TriggerButton>Pick a role</TriggerButton>)
      assert.ok(!/control-raised|control-thumb|shadow/.test(classes), 'a field does not stand off the page')
      assert.match(classes, /justify-between/, 'value on one side, chevron on the other')
      assert.match(classes, /bg-\[color:var\(--bg-surface-raised\)\]/, 'the Select trigger’s ground')
      assert.match(classes, /h-control-sm/, 'and its height, so it matches the input beside it')
    })

    run('an open trigger holds its fill and never takes the accent', () => {
      const classes = classesOf(<TriggerButton open>Role</TriggerButton>)
      assert.match(classes, /bg-\[color:var\(--bg-selected\)\]/)
      assert.ok(!/accent-primary/.test(classes), 'an open popover is a state, not the view’s primary action')
      assert.deepEqual(duplicateUtilities(classes), [])
    })

    run('size="content" gives the height back for a two-line trigger', () => {
      const classes = classesOf(<TriggerButton size="content">Two lines</TriggerButton>)
      assert.ok(!/h-control-/.test(classes))
    })

    // ── CardButton ────────────────────────────────────────────────────────────

    run('a tile changes its GROUND on hover and nothing else', () => {
      for (const variant of ['plain', 'bordered'] as const) {
        const classes = classesOf(<CardButton variant={variant}>Tile</CardButton>)
        assert.match(classes, /hover:bg-\[color:var\(--bg-hover\)\]/)
        assert.ok(!/hover:shadow|shadow-/.test(classes), 'no elevation: a grid must not reflow')
        assert.ok(!/interactive/.test(classes), 'and no press scale, for the same reason')
        assert.ok(!/h-control-|justify-center/.test(classes), 'the composition sets the box')
        assert.match(classes, /flex-col/)
        assert.deepEqual(duplicateUtilities(classes), [])
      }
    })

    run('a bordered tile has its hairline at REST, so nothing appears on hover', () => {
      const classes = classesOf(<CardButton variant="bordered">Tile</CardButton>)
      assert.match(classes, /(?:^|\s)border(?:\s|$)/, 'the border width is present before the pointer arrives')
    })

    run('a chosen tile reads as pressed, where a chosen row reads as current', () => {
      assert.equal(attrOf(<CardButton selected>T</CardButton>, 'aria-pressed'), 'true')
      assert.equal(attrOf(<CardButton>T</CardButton>, 'aria-pressed'), null)
      const classes = classesOf(<CardButton selected>T</CardButton>)
      assert.ok(!/hover:bg-\[color:var\(--bg-hover\)\]/.test(classes))
    })

    run('a tile spells no padding, so the composition owns its inset', () => {
      const classes = classesOf(<CardButton>T</CardButton>)
      assert.ok(!/(?:^|\s)p[xytblr]?-/.test(classes))
    })

    // ── ChipButton ────────────────────────────────────────────────────────────

    run('a chip takes its height from its line box', () => {
      const classes = classesOf(<ChipButton>Grid</ChipButton>)
      assert.ok(!/h-control-/.test(classes), 'a chip rides the row it is in; it does not set it')
      assert.match(classes, /text-micro/)
      assert.ok(!/shadow-/.test(classes), 'a mark on a surface, not a control standing off one')
    })

    run('the tone tints keep their hue when thrown; the neutral tones go neutral', () => {
      assert.match(
        classesOf(
          <ChipButton tone="warn" pressed>
            Bypass
          </ChipButton>,
        ),
        /bg-\[color:var\(--tone-warn-soft\)\].*text-\[color:var\(--tone-warn-on-tint\)\]/,
      )
      assert.match(
        classesOf(
          <ChipButton tone="neutral" pressed>
            List
          </ChipButton>,
        ),
        /bg-\[color:var\(--bg-selected\)\]/,
      )
    })

    run('an outline chip keeps its edge through every state', () => {
      const resting = classesOf(<ChipButton variant="outline">Step</ChipButton>)
      const thrown = classesOf(
        <ChipButton variant="outline" pressed>
          Step
        </ChipButton>,
      )
      assert.match(resting, /border-\[color:var\(--border-default\)\]/)
      assert.match(thrown, /border-\[color:var\(--border-default\)\]/, 'a border that appeared would resize the row')
      assert.deepEqual(duplicateUtilities(thrown), [])
    })

    run('a tint paints ink and a mix, never a solid fill, and a state outranks it', () => {
      // design-tokens-allow: a caller-resolved identity hue standing in for an epic's colour — the value is data the test supplies, not chrome it paints
      const view = mount(<ChipButton tint="#7a5cff">MC-2118</ChipButton>)
      const style = view.container.querySelector('button')?.getAttribute('style') ?? ''
      assert.match(style, /color-mix/, 'an identity hue is a name, so it lands as a tint')
      // design-tokens-allow: the same caller-supplied hue, asserted as it reaches the element
      assert.match(style, /(?:^|;)\s*color: ?(?:#7a5cff|rgb\(122, 92, 255\))/, 'and the ink is the identity hue itself')
      view.unmount()
      // design-tokens-allow: the same caller-supplied hue, now outranked by the thrown state
      const thrownView = mount(
        <ChipButton tint="#7a5cff" selected>
          MC-2118
        </ChipButton>,
      )
      const thrownStyle = thrownView.container.querySelector('button')?.getAttribute('style') ?? ''
      assert.ok(!/color-mix/.test(thrownStyle), 'a state outranks an identity')
      thrownView.unmount()
    })

    run('the overlay chip is the floating form and takes the overlay radius', () => {
      assert.match(classesOf(<ChipButton variant="overlay">100%</ChipButton>), /rounded-md/)
      assert.match(classesOf(<ChipButton>100%</ChipButton>), /rounded-xs/)
    })

    // ── LinkButton ────────────────────────────────────────────────────────────

    run('a link has no box at all', () => {
      const classes = classesOf(<LinkButton>Reconnect</LinkButton>)
      assert.ok(!/h-control-|inline-flex|px-/.test(classes), 'it sits in the sentence, not beside it')
      assert.ok(!/interactive/.test(classes), 'a control that shrank mid-sentence would move the words after it')
      assert.match(classes, /focus-visible:focus-ring/)
    })

    run('accent underlines on hover; quiet underlines always', () => {
      assert.match(classesOf(<LinkButton>Go</LinkButton>), /hover:underline/)
      const quiet = classesOf(<LinkButton ink="quiet">More</LinkButton>)
      assert.match(quiet, /(?:^|\s)underline(?:\s|$)/, 'with no colour and no box, it needs a standing rule')
      assert.match(quiet, /decoration-\[color:var\(--border-strong\)\]/)
    })

    run('accent is INK on a link, never a fill', () => {
      const classes = classesOf(<LinkButton>Go</LinkButton>)
      assert.match(classes, /text-\[color:var\(--accent-primary\)\]/)
      assert.ok(!/bg-\[color:var\(--accent/.test(classes))
    })

    run('name reads as a title at rest and underlines on hover, never in the accent', () => {
      const classes = classesOf(<LinkButton ink="name">Weather Deck</LinkButton>)
      assert.match(classes, /text-\[color:var\(--text-strong\)\]/)
      assert.match(classes, /hover:underline/)
      assert.ok(!/accent/.test(classes), 'a list of titles in the accent is a list of accents')
    })

    run('size="inherit" states no size of its own', () => {
      const classes = classesOf(<LinkButton size="inherit">src/main.ts</LinkButton>)
      assert.ok(!/text-meta/.test(classes), 'one word of a sentence must not be a different size from the rest')
    })

    // ── Input / Textarea variants ─────────────────────────────────────────────

    run('quiet is a hairline on no ground, with no hover lift', () => {
      const classes = classesOf(<Input variant="quiet" />)
      assert.match(classes, /border-\[color:var\(--border-subtle\)\]/)
      assert.match(classes, /bg-transparent/)
      assert.ok(
        !/hover:border-\[color:var\(--border-strong\)\]/.test(classes),
        'a second edge moving inside a surface reads as the surface changing',
      )
      assert.deepEqual(duplicateUtilities(classes), [])
    })

    run('seamless and composer draw no box, and take no height whatever the caller asks', () => {
      for (const variant of ['seamless', 'composer'] as const) {
        const classes = classesOf(<Textarea variant={variant} size="md" />)
        assert.ok(!/rounded-|border/.test(classes), `${variant}: the wrapper owns the box`)
        assert.ok(!/focus-visible:focus-ring/.test(classes), `${variant}: the wrapper owns the ring`)
        assert.ok(!/h-control-|px-3/.test(classes), `${variant}: and the inset`)
        assert.match(
          classes,
          /outline-none/,
          'the UA outline is replaced in every focus state, not just the keyboard one',
        )
      }
      assert.match(classesOf(<Textarea variant="composer" />), /field-sizing-content/)
      assert.ok(
        !/field-sizing/.test(classesOf(<Textarea variant="seamless" />)),
        'a single-line field must not grow sideways',
      )
    })

    run('the in-place title edit is reachable as a variant, and is the same string', async () => {
      const { INLINE_TITLE_EDIT_CLASS } = await import('./Input')
      const classes = classesOf(<Input variant="inline" />)
      for (const candidate of INLINE_TITLE_EDIT_CLASS.split(' ')) {
        assert.ok(classes.includes(candidate), `variant="inline" carries ${candidate}`)
      }
    })

    run('the xs step is on the ramp, and is meta type', () => {
      const classes = classesOf(<Input size="xs" />)
      assert.match(classes, /h-control-xs/, 'a ramp step being used, not a height being invented')
      assert.match(classes, /text-meta/)
    })

    run('every input variant declares one ground, one edge and one ink', () => {
      for (const variant of ['default', 'well', 'quiet', 'seamless', 'composer', 'inline'] as const) {
        assert.deepEqual(
          duplicateUtilities(classesOf(<Input variant={variant} />)),
          [],
          `variant=${variant} declares a property twice`,
        )
      }
    })

    // ── Checkbox marker mode ──────────────────────────────────────────────────

    run('a marker is not a label, not a handler, and not disabled', () => {
      const view = mount(<Checkbox checked readOnly />)
      assert.equal(view.container.querySelector('label'), null, 'no label wrapping prose the renderer owns')
      const input = view.container.querySelector('input')
      assert.equal(input?.hasAttribute('disabled'), false, 'disabled reads as "unavailable"; this is neither')
      assert.equal(input?.getAttribute('readonly'), '', 'React needs it on a controlled input with no handler')
      assert.equal(input?.getAttribute('aria-readonly'), 'true', 'the state is real, and not yours to change here')
      view.unmount()
    })

    run('the marker draws the kit box, not a fifth checkbox', () => {
      const marker = mount(<Checkbox checked readOnly />)
      const control = mount(<Checkbox checked onChange={() => undefined} />)
      const box = (view: { container: HTMLElement }): string =>
        view.container.querySelector('span[aria-hidden="true"]')?.getAttribute('class') ?? ''
      assert.equal(box(marker), box(control))
      marker.unmount()
      control.unmount()
    })

    // ── Control tiers (owner ruling 2026-10-04) ─────────────────────────────
    //
    // Tier 1, the primary action, carries the one faint highlight. Tier 2, a
    // standalone secondary, is flat on a hairline. Tier 3, a control inside a
    // surface, is ghost. Every tier presses by the shared `.interactive` scale,
    // except the grid tile, which presses by its ground.

    const depthOf = (classes: string): string[] =>
      classes.split(/\s+/).filter((c) => /^control-|shadow/.test(c) && !c.startsWith('focus'))

    run('tier 1: the primary and its destructive stand-in carry the highlight, and nothing else does', () => {
      for (const node of [<PrimaryButton key="p">Create</PrimaryButton>, <DangerButton key="d">Delete</DangerButton>]) {
        const classes = classesOf(node)
        assert.deepEqual(depthOf(classes), ['control-raised'], 'the faint lit edge, through one class')
        assert.match(classes, /(?:^|\s)interactive(?:\s|$)/, 'and the shared press scale, not a bevel swap')
      }
      for (const node of [
        <OutlineButton key="o">Cancel</OutlineButton>,
        <GhostButton key="g">Stash</GhostButton>,
        <IconButton key="i" aria-label="Refresh">
          R
        </IconButton>,
        <ChipButton key="c" variant="raised">
          Group
        </ChipButton>,
        <TriggerButton key="t">Role</TriggerButton>,
        <TriggerButton key="tg" variant="ghost">
          main
        </TriggerButton>,
        <CardButton key="k" variant="raised">
          Terminal
        </CardButton>,
      ]) {
        assert.deepEqual(depthOf(classesOf(node)), [], 'below tier 1 a control carries no depth at all')
      }
    })

    run('tier 2: the outline is flat on the strong hairline, and steps its ground under the press', () => {
      const classes = classesOf(<OutlineButton>Cancel</OutlineButton>)
      assert.match(classes, /(?:^|\s)border-\[color:var\(--border-strong\)\]/, 'the strong hairline, at rest')
      assert.match(classes, /(?:^|\s)bg-transparent(?:\s|$)/, 'over a transparent ground')
      assert.ok(!/hover:border-/.test(classes), 'the hairline holds; only the ground and the ink move')
      assert.match(classes, /hover:bg-\[color:var\(--bg-hover\)\]/)
      assert.match(classes, /enabled:active:bg-\[color:var\(--bg-active\)\]/)
      assert.match(classes, /(?:^|\s)interactive(?:\s|$)/, 'and the shared press scale')
      assert.deepEqual(duplicateUtilities(classes), [])
      const thrown = classesOf(<OutlineButton pressed>Mark read</OutlineButton>)
      assert.match(thrown, /(?:^|\s)bg-\[color:var\(--bg-selected\)\]/, 'a thrown toggle keeps the selection fill')
      assert.deepEqual(duplicateUtilities(thrown), [])
    })

    run('the floating pill is solid at rest: the composer’s ground, never a see-through one', () => {
      for (const size of ['inline', 'xs', 'sm', 'md'] as const) {
        const classes = classesOf(<FloatingButton size={size}>Jump to latest</FloatingButton>)
        assert.match(classes, /(?:^|\s)bg-\[color:var\(--composer-surface\)\]/, `size=${size} rests on the ground`)
        assert.ok(!/(?:^|\s)bg-transparent(?:\s|$)/.test(classes), 'no transparent ground for text to show through')
        assert.match(classes, /hover:bg-\[color:var\(--composer-surface-hover\)\]/, 'a hover a rung further out')
        assert.match(classes, /disabled:hover:bg-\[color:var\(--composer-surface\)\]/, 'and its disabled guard')
        assert.match(classes, /(?:^|\s)border-\[color:var\(--border-strong\)\]/, 'the outline’s hairline')
        assert.match(classes, /shadow-\[var\(--shadow-control-raised\)\]/, 'the composer’s lit edge, as a token')
        assert.match(classes, /(?:^|\s)interactive(?:\s|$)/, 'and the shared press scale')
        assert.deepEqual(duplicateUtilities(classes), [], `FloatingButton size=${size} declares a property twice`)
      }
      assert.equal(attrOf(<FloatingButton>Go</FloatingButton>, 'type'), 'button')
    })

    run('tier 2: the launcher tile keeps its hairline and ground, and presses by its ground', () => {
      const classes = classesOf(<CardButton variant="raised">Terminal</CardButton>)
      assert.match(classes, /(?:^|\s)border-\[color:var\(--border-default\)\]/)
      assert.match(classes, /(?:^|\s)bg-\[color:var\(--bg-surface-raised\)\]/)
      assert.match(classes, /enabled:active:bg-\[color:var\(--bg-active\)\]/)
      assert.ok(!/(?:^|\s)interactive(?:\s|$)/.test(classes), 'no scale: a grid tile that shrank would leave its row')
      assert.deepEqual(duplicateUtilities(classes), [])
    })

    run('tier 3: the toolbar chip is ghost, at the toolbar’s height, with the ghost button’s ink', () => {
      const classes = classesOf(<ChipButton variant="raised">Group: folder</ChipButton>)
      assert.ok(!/(?:^|\s)border(?:\s|$)|border-\[/.test(classes), 'no edge at any state')
      assert.match(classes, /(?:^|\s)bg-transparent(?:\s|$)/)
      assert.match(classes, /hover:bg-\[color:var\(--bg-hover\)\]/)
      assert.match(classes, /enabled:active:bg-\[color:var\(--bg-active\)\]/)
      assert.match(classes, /h-control-xs/, 'still a control in a toolbar row, not a line-box chip')
      assert.match(
        classes,
        /(?:^|\s)text-\[color:var\(--text-muted\)\].*hover:text-\[color:var\(--text-strong\)\]/,
        'muted lifting to strong, as the ghost glyphs beside it',
      )
      assert.match(classes, /(?:^|\s)interactive(?:\s|$)/, 'and the shared press scale')
      assert.deepEqual(duplicateUtilities(classes), [])
      const warn = classesOf(
        <ChipButton variant="raised" tone="warn">
          Bypass
        </ChipButton>,
      )
      assert.match(warn, /text-\[color:var\(--tone-warn\)\]/, 'a tone keeps its own ink on the toolbar chip')
    })

    run('tier 3: a trigger in a toolbar is ghost, and open takes the fill without an edge', () => {
      const resting = classesOf(<TriggerButton variant="ghost">main</TriggerButton>)
      assert.ok(!/(?:^|\s)border(?:\s|$)|border-\[/.test(resting), 'no edge at rest')
      assert.match(resting, /(?:^|\s)bg-transparent(?:\s|$)/)
      assert.match(resting, /hover:bg-\[color:var\(--bg-hover\)\]/)
      assert.match(resting, /(?:^|\s)text-meta(?:\s|$)/, 'the toolbar’s type, not the form’s')
      assert.deepEqual(duplicateUtilities(resting), [])
      const open = classesOf(
        <TriggerButton variant="ghost" open>
          main
        </TriggerButton>,
      )
      assert.match(open, /(?:^|\s)bg-\[color:var\(--bg-selected\)\]/)
      assert.ok(
        !/(?:^|\s)border(?:\s|$)|border-\[/.test(open),
        'an edge that appeared on open would be a border appearing',
      )
      assert.deepEqual(duplicateUtilities(open), [])
    })

    run('the app stylesheet: one press for every control, one highlight, no bevel', () => {
      const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/index.css'), 'utf8')
      const block = (selector: string): string => {
        const at = css.indexOf(`${selector} {`)
        assert.ok(at !== -1, `index.css declares ${selector}`)
        return css.slice(at, css.indexOf('}', at))
      }
      assert.match(
        css,
        /\.interactive:active:not\(:disabled\):not\(\[aria-disabled="true"\]\) \{\s*transform: scale\(0\.97\);/,
        'the press scale excludes nothing but a disabled control',
      )
      // The only rule that sets the press back to `none` lives in the
      // reduced-motion block; the test does not try to parse the nesting.
      assert.match(
        css,
        /prefers-reduced-motion: reduce[\s\S]*\.interactive:active:not\(:disabled\):not\(\[aria-disabled="true"\]\) \{\s*transform: none;/,
        'and stands still under reduced motion',
      )
      assert.equal(block('.control-raised').trim(), '.control-raised {\n  box-shadow: var(--shadow-control-raised);')
      assert.match(block('.control-thumb'), /box-shadow: var\(--shadow-control-thumb\);/)
      for (const retired of ['control-edge', 'control-track', 'control-pressed', 'control-sheen', 'raised-sheen']) {
        assert.ok(!css.includes(retired), `the retired ${retired} is gone from the app stylesheet`)
      }
    })

    if (failures > 0) {
      console.error(`\nbuttonSpecies.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('button species: all checks passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})

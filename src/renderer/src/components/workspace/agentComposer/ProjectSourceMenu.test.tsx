import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('ProjectSourceMenu', async () => {
  // The project selector's sources (remote-sessions-ux /
  // project-selector-sources). The Git step's repo machinery is the shipped
  // The clone code is pinned by its own tests; what this file pins is
  // the selector's own anatomy, and the stepped Git view's behaviour: step swap,
  // back with state preserved, inline clone error, a failed clone leaving the
  // selection untouched, and Escape from the Git step.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0)
  anyGlobal.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  let repoAnswer: () => Promise<Record<string, unknown>> = async () => ({ ok: false, reason: 'no_token' })
  type ProgressListener = (progress: Record<string, unknown>) => void
  const progressListeners = new Set<ProgressListener>()
  const cancelled: string[] = []
  ;(dom.window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'darwin',
    listGitHubRepos: () => repoAnswer(),
    onRepositoryCloneProgress: (cb: ProgressListener) => {
      progressListeners.add(cb)
      return () => progressListeners.delete(cb)
    },
    cancelRepositoryClone: async (cloneId: string) => {
      cancelled.push(cloneId)
    },
  }

  async function main(): Promise<void> {
    const React = (await import('react')).default
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { ProjectSourceMenu } = await import('./ProjectSourceMenu')
    type ProjectCloneResult = import('./ProjectSourceMenu').ProjectCloneResult
    const { Popover } = await import('../../ui/Popover')

    let failures = 0
    const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
      try {
        await fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    }

    const noClone = async () => ({ ok: false as const, message: 'unused' })
    const markup = renderToStaticMarkup(
      <ProjectSourceMenu
        options={[
          { path: '/w/sprintengine', label: 'sprintengine' },
          { path: '/w/toolbox', label: 'toolbox' },
          { path: '/w/old-repo', label: 'old-repo' },
        ]}
        selectedPath="/w/sprintengine"
        defaultParent="/w"
        onSelect={() => {}}
        onBrowse={() => {}}
        onClone={noClone}
        onClose={() => {}}
      />,
    )

    await check('the selector opens on a search field over the project rows', () => {
      assert.match(markup, /aria-label="Search projects"/)
      const search = markup.indexOf('Search projects')
      const firstRow = markup.indexOf('sprintengine')
      assert.ok(search !== -1 && firstRow !== -1 && search < firstRow, 'search leads the list')
    })

    await check('project rows are stacked menu items: name over mono path, selection by bg.selected', () => {
      assert.match(markup, /role="menuitemradio" aria-checked="true"/)
      assert.match(markup, /font-mono/, 'the path reads in the mono voice')
      assert.match(markup, /--bg-selected/, 'the choice wears the neutral selection wash')
    })

    await check('the body is the list layer, not a second menu: the hosting popover surface carries the role', () => {
      assert.doesNotMatch(markup, /role="menu"/, 'no nested role="menu"')
    })

    await check('every project is one list in the order given, with no Recent section below it', () => {
      assert.doesNotMatch(markup, /aria-label="Recent"/)
      assert.doesNotMatch(markup, />Recent</)
      const order = ['sprintengine', 'toolbox', 'old-repo'].map((name) => markup.indexOf(`/w/${name}`))
      assert.ok(
        order.every((at, index) => at !== -1 && (index === 0 || at > order[index - 1])),
        'in the host order',
      )
    })

    await check('the sources lead: Browse… and Import from Git sit between the search field and the projects', () => {
      assert.match(markup, /role="separator"/)
      assert.match(markup, /Browse…/)
      assert.match(markup, /Import from Git/)
      const search = markup.indexOf('Search projects')
      const browse = markup.indexOf('Browse…')
      const importGit = markup.indexOf('Import from Git')
      const separator = markup.indexOf('role="separator"')
      const firstProject = markup.indexOf('sprintengine')
      assert.ok(search < browse && browse < importGit, 'Browse… then Import, directly under the search field')
      assert.ok(
        importGit < separator && separator < firstProject,
        'the separator parts the sources from the projects, which grow below it',
      )
    })

    await check('a host without a folder dialog gets no Browse… row, and Import stays', () => {
      const noBrowse = renderToStaticMarkup(
        <ProjectSourceMenu
          options={[]}
          selectedPath={null}
          defaultParent={null}
          onSelect={() => {}}
          onClone={noClone}
          onClose={() => {}}
        />,
      )
      assert.doesNotMatch(noBrowse, /Browse…/)
      assert.match(noBrowse, /Import from Git/)
      assert.match(noBrowse, /No projects yet\./, 'with nothing typed, nothing failed to match')
      assert.doesNotMatch(noBrowse, /No matching projects/)
    })

    // ── The stepped Git view, rendered for real inside the hosting Popover ──

    type Mounted = {
      unmount: () => void
      selections: string[]
      closes: () => number
      clones: Array<Record<string, unknown>>
    }
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    const click = (el: Element | null | undefined) => {
      assert.ok(el, 'element to click exists')
      return act(async () => {
        el!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    const type = (input: HTMLInputElement, value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    const buttonWithText = (root: ParentNode, text: string) =>
      [...root.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().startsWith(text))
    const surface = () => dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')

    const mount = async (
      cloneResult: () => Promise<
        { ok: true; path: string } | { ok: false; message: string; reason?: string; existingPath?: string }
      >,
    ): Promise<Mounted> => {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      const selections: string[] = []
      const clones: Array<Record<string, unknown>> = []
      let closes = 0
      function Host() {
        const [open, setOpen] = React.useState(true)
        return (
          <Popover
            open={open}
            onOpenChange={setOpen}
            ariaLabel="Project this agent runs in"
            popupRole="menu"
            renderTrigger={({ ref, triggerProps, togglePopover }) => (
              <button ref={ref} type="button" onClick={togglePopover} {...triggerProps}>
                proj
              </button>
            )}
          >
            <ProjectSourceMenu
              options={[{ path: '/w/sprintengine', label: 'sprintengine' }]}
              selectedPath="/w/sprintengine"
              defaultParent="/w"
              onSelect={(path) => selections.push(path)}
              onBrowse={() => {}}
              onClone={(request) => {
                clones.push(request)
                return cloneResult() as Promise<ProjectCloneResult>
              }}
              onClose={() => {
                closes += 1
                setOpen(false)
              }}
            />
          </Popover>
        )
      }
      await act(async () => {
        root.render(<Host />)
      })
      await settle()
      return {
        unmount: () => {
          act(() => root.unmount())
          container.remove()
        },
        selections,
        closes: () => closes,
        clones,
      }
    }

    await check('opening the list puts the focus in its search field, once the surface shows', async () => {
      const { focusProjectSearch } = await import('./ProjectSourceMenu')
      const surface = dom.window.document.createElement('div')
      surface.innerHTML = '<input aria-label="Search projects"><button>sprintengine</button>'
      dom.window.document.body.appendChild(surface)
      const field = surface.querySelector('input')!
      // Still hidden while the popover measures it: the first focus lands nowhere.
      const realFocus = field.focus.bind(field)
      let tries = 0
      field.focus = () => {
        tries += 1
        if (tries > 1) realFocus()
      }
      focusProjectSearch(surface)
      assert.notEqual(dom.window.document.activeElement, field)
      await settle()
      assert.equal(dom.window.document.activeElement, field, 'the next frame puts it there')
      surface.remove()
    })

    await check('a search that finds nothing says so', async () => {
      const view = await mount(async () => ({ ok: false, message: 'unused' }))
      try {
        const search = surface()!.querySelector<HTMLInputElement>('[aria-label="Search projects"]')!
        await type(search, 'nothing-like-it')
        assert.match(surface()!.textContent ?? '', /No matching projects\./)
      } finally {
        view.unmount()
      }
    })

    await check('Import from Git swaps the same surface to the repo step, and back preserves the search', async () => {
      repoAnswer = async () => ({ ok: false, reason: 'no_token' })
      const view = await mount(async () => ({ ok: false, message: 'unused' }))
      try {
        const search = surface()!.querySelector<HTMLInputElement>('[aria-label="Search projects"]')!
        await type(search, 'multi')
        await click(buttonWithText(surface()!, 'Import from Git'))
        await settle()
        assert.ok(surface(), 'still the one popover surface — no second dialog')
        assert.ok(surface()!.querySelector('[aria-label="Repository URL"]'), 'the Git step shows the URL lane')
        assert.equal(surface()!.querySelector('[aria-label="Search projects"]'), null, 'the project step is gone')
        assert.ok(
          /Settings → Version control/.test(surface()!.textContent ?? ''),
          'no token → the inline pointer, not an error',
        )
        const url = surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!
        await type(url, 'https://github.com/acme/repo')
        await click(buttonWithText(surface()!, '←'))
        await settle()
        const searchAgain = surface()!.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
        assert.ok(searchAgain, 'back returns to the projects step')
        assert.equal(searchAgain!.value, 'multi', 'with the search preserved')
        await click(buttonWithText(surface()!, 'Import from Git'))
        await settle()
        assert.equal(
          surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!.value,
          'https://github.com/acme/repo',
          'and the Git step keeps its URL draft too',
        )
        assert.equal(view.closes(), 0, 'stepping never closes the selector')
      } finally {
        view.unmount()
      }
    })

    await check('a failed clone surfaces git’s error inline and leaves the selection untouched', async () => {
      repoAnswer = async () => ({ ok: false, reason: 'no_token' })
      const view = await mount(async () => ({ ok: false, message: 'fatal: repository not found' }))
      try {
        await click(buttonWithText(surface()!, 'Import from Git'))
        await settle()
        const url = surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!
        await type(url, 'https://github.com/acme/missing')
        assert.ok(buttonWithText(surface()!, 'w/'), 'the target parent is named on its Change… button')
        assert.equal(
          surface()!.querySelector<HTMLInputElement>('input[id$="-folder"]')!.value,
          'missing',
          'the folder name follows the repository',
        )
        await click(buttonWithText(surface()!, 'Clone'))
        await settle()
        assert.equal(view.clones.length, 1, 'the host was asked to clone')
        assert.equal(view.clones[0]?.branch, null, 'no branch asked for: the remote default')
        assert.equal(view.clones[0]?.parentDir, '/w')
        assert.equal(view.clones[0]?.folderName, 'missing')
        const alert = surface()!.querySelector('[role="alert"]')
        assert.equal(alert?.textContent, 'fatal: repository not found', 'git’s message, inline')
        assert.deepEqual(view.selections, [], 'nothing was selected')
        assert.equal(view.closes(), 0, 'and the selector stays open on the Git step')
      } finally {
        view.unmount()
      }
    })

    await check(
      'a clone that succeeds closes the selector; adoption is the host’s, so a closed selector loses nothing',
      async () => {
        repoAnswer = async () => ({ ok: false, reason: 'no_token' })
        let resolveClone: (value: { ok: true; path: string }) => void = () => {}
        const view = await mount(
          () =>
            new Promise((resolve) => {
              resolveClone = resolve
            }),
        )
        try {
          await click(buttonWithText(surface()!, 'Import from Git'))
          await settle()
          await type(
            surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!,
            'https://github.com/acme/repo',
          )
          await click(buttonWithText(surface()!, 'Clone'))
          assert.ok(buttonWithText(surface()!, 'Cloning…'), 'progress reads on the button')
          // The selector closes before the clone lands (Escape).
          await act(async () => {
            dom.window.document.dispatchEvent(
              new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            )
          })
          await settle()
          assert.equal(surface(), null, 'Escape closes the selector from the Git step')
          await act(async () => {
            resolveClone({ ok: true, path: '/w/repo' })
          })
          await settle()
          assert.deepEqual(view.selections, [], 'the menu does not select into a closed panel — the host adopted it')
          assert.equal(view.clones.length, 1)
        } finally {
          view.unmount()
        }
      },
    )

    const openGitStep = async () => {
      await click(buttonWithText(surface()!, 'Import from Git'))
      await settle()
      return surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!
    }

    await check(
      'a pasted page URL previews its host and fills the branch and folder; edits ride the request',
      async () => {
        repoAnswer = async () => ({ ok: false, reason: 'no_token' })
        const view = await mount(async () => ({ ok: false, message: 'unused' }))
        try {
          const url = await openGitStep()
          await type(url, 'https://gitlab.acme.dev/platform/backend/api/-/tree/develop')
          const text = surface()!.textContent ?? ''
          assert.match(text, /GitLab/, 'the provider is named')
          assert.match(text, /gitlab\.acme\.dev\/platform\/backend\/api/, 'with where the repository lives')
          const branch = surface()!.querySelector<HTMLInputElement>('input[id$="-branch"]')!
          const folder = surface()!.querySelector<HTMLInputElement>('input[id$="-folder"]')!
          assert.equal(branch.value, 'develop', 'the branch the page was on')
          assert.equal(folder.value, 'api')
          await type(folder, 'api-develop')
          await click(buttonWithText(surface()!, 'Clone'))
          await settle()
          assert.equal(view.clones[0]?.url, 'https://gitlab.acme.dev/platform/backend/api')
          assert.equal(view.clones[0]?.branch, 'develop')
          assert.equal(view.clones[0]?.folderName, 'api-develop', 'a typed folder name wins over the derived one')
        } finally {
          view.unmount()
        }
      },
    )

    await check('a URL that does not parse says why under the field, and Clone stays off', async () => {
      repoAnswer = async () => ({ ok: false, reason: 'no_token' })
      const view = await mount(async () => ({ ok: false, message: 'unused' }))
      try {
        const url = await openGitStep()
        await type(url, 'ftp://example.com/repo')
        assert.equal(url.getAttribute('aria-invalid'), 'true')
        assert.ok(buttonWithText(surface()!, 'Clone')!.disabled, 'nothing to clone')
      } finally {
        view.unmount()
      }
    })

    await check('a running clone says its progress in words and can be cancelled quietly', async () => {
      repoAnswer = async () => ({ ok: false, reason: 'no_token' })
      let finish: (value: { ok: false; message: string; reason: string }) => void = () => {}
      const view = await mount(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      try {
        await type(await openGitStep(), 'acme/widget')
        await click(buttonWithText(surface()!, 'Clone'))
        const cloneId = view.clones[0]?.cloneId as string
        assert.ok(cloneId, 'the request is named for its progress and its cancel')
        await act(async () => {
          for (const listener of progressListeners) {
            listener({ cloneId: 'someone-else', stage: 'checkout', percent: 99, detail: null })
            listener({ cloneId, stage: 'receiving', percent: 45, detail: '12.30 MiB | 5.00 MiB/s' })
          }
        })
        assert.match(
          surface()!.textContent ?? '',
          /Receiving objects · 45% · 12\.30 MiB \| 5\.00 MiB\/s/,
          'its own progress, not another clone’s',
        )
        await click(buttonWithText(surface()!, 'Cancel'))
        assert.deepEqual(cancelled, [cloneId], 'cancel names the clone')
        await act(async () => {
          finish({ ok: false, message: 'Clone cancelled.', reason: 'cancelled' })
        })
        await settle()
        assert.equal(surface()!.querySelector('[role="alert"]'), null, 'a cancel is not an error')
        assert.ok(!buttonWithText(surface()!, 'Clone')!.disabled, 'and Clone is offered again')
        assert.equal(view.closes(), 0)
      } finally {
        view.unmount()
      }
    })

    await check('a folder that is already this clone offers to open it instead', async () => {
      repoAnswer = async () => ({ ok: false, reason: 'no_token' })
      const view = await mount(async () => ({
        ok: false,
        reason: 'exists',
        existingPath: '/w/widget',
        message: 'widget is already a clone of acme/widget.',
      }))
      try {
        await type(await openGitStep(), 'acme/widget')
        await click(buttonWithText(surface()!, 'Clone'))
        await settle()
        await click(buttonWithText(surface()!, 'Open it'))
        await settle()
        assert.deepEqual(view.selections, ['/w/widget'], 'the existing clone is the project')
        assert.equal(view.closes(), 1)
      } finally {
        view.unmount()
      }
    })

    await check(
      'picking one of the account’s repositories fills the URL field, and picking it again clears it',
      async () => {
        repoAnswer = async () => ({
          ok: true,
          repos: [
            {
              fullName: 'acme/widget',
              name: 'widget',
              owner: 'acme',
              isPrivate: true,
              description: null,
              cloneUrl: 'https://github.com/acme/widget.git',
              defaultBranch: 'main',
              pushedAt: null,
            },
          ],
        })
        const view = await mount(async () => ({ ok: false, message: 'unused' }))
        try {
          const url = await openGitStep()
          await settle()
          const row = () => surface()!.querySelector('[role="option"]')!
          await click(row())
          assert.equal(url.value, 'https://github.com/acme/widget.git')
          assert.equal(row().getAttribute('aria-selected'), 'true', 'the row the field names reads as picked')
          await click(row())
          assert.equal(url.value, '')
        } finally {
          view.unmount()
        }
      },
    )

    await check(
      'a cold start with no parent to clone beside says what to do rather than "open a project first"',
      async () => {
        const cold = renderToStaticMarkup(
          <ProjectSourceMenu
            options={[]}
            selectedPath={null}
            defaultParent={null}
            onSelect={() => {}}
            onClone={noClone}
            onClose={() => {}}
          />,
        )
        assert.doesNotMatch(cold, /Open a project first/)
      },
    )

    if (failures > 0) {
      console.error(`ProjectSourceMenu.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('ProjectSourceMenu.test.tsx: ok')
  }

  const suiteRun = main()

  await suiteRun
})

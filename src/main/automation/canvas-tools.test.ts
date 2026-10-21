import assert from 'node:assert/strict'

import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { DEFAULT_CANVAS_BOARD_PATH } from '../../shared/canvas/paths'
import type {
  CanvasActionEntry,
  CanvasBoardState,
  CanvasBoardSummary,
  CanvasEditResult,
  CanvasElement,
  CanvasImage,
} from '../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../shared/canvas/types'
import type { CanvasActor, CanvasService } from '../canvas/canvas-service-types'
import { CANVAS_MUTATION_TOOL_NAMES, createCanvasTools } from './canvas-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { createClientToolLoop, type ClientToolLoop } from './client-tool-loop.test-helper'
import { test } from 'vitest'

// Every case runs twice: the handler called directly, and the same call as an
// agent's tools/call to the gateway, routed to the desktop shell's client over
// a port and handled by the same fake service, the worker included (the
// client-tools spec's parity test 6). The answers, errors included, must be
// the same.
for (const through of ['direct', 'the shell'] as const)
  test(`canvas-tools, called ${through === 'direct' ? 'directly' : 'through the shell'}`, async () => {
    const loops: Array<Promise<ClientToolLoop>> = []
    let looped = 0
    /** The tools as an agent reaches them in this run. */
    function reached(registrations: McpToolRegistration[]): Map<string, McpToolRegistration> {
      if (through === 'direct') return new Map(registrations.map((tool) => [tool.name, tool]))
      const loop = createClientToolLoop({ toolsets: [{ name: 'canvas', registrations }] })
      loops.push(loop)
      return new Map(
        registrations.map((tool) => [
          tool.name,
          {
            ...tool,
            handler: async (args: Record<string, unknown>, context?: McpConnectionContext) => {
              looped++
              return (await loop).call(tool.name, args, context ?? { metadata: { kind: 'external-local' } })
            },
          },
        ]),
      )
    }

    function run(name: string, body: () => Promise<void> | void): Promise<void> {
      return Promise.resolve()
        .then(body)
        .then(() => console.log(`ok - ${name}`))
        .catch((error) => {
          console.error(`not ok - ${name}`)
          throw error
        })
    }

    const TOOL_NAMES = [
      'canvas.list',
      'canvas.open',
      'canvas.describe',
      'canvas.find',
      'canvas.edit',
      'canvas.layout',
      'canvas.import',
      'canvas.screenshot',
    ]

    /** A board path whose subtree is a document we do not own, so it stays open. */
    const FREEFORM_SCHEMA_PATHS = new Set(['canvas.import.scene'])

    let seed = 0

    function element(overrides: Partial<CanvasElement> & { id: string; type: string }): CanvasElement {
      seed += 1
      return { version: 1, versionNonce: seed, x: 0, y: 0, width: 200, height: 80, ...overrides }
    }

    function boardState(path: string, elements: CanvasElement[] = [], revision = 1): CanvasBoardState {
      return { path, revision, elements, appState: {}, files: {} }
    }

    function summary(path: string, modifiedAt: number, elementCount = 0): CanvasBoardSummary {
      return {
        path,
        name: path.slice(path.lastIndexOf('/') + 1).replace(/\.excalidraw$/, ''),
        elementCount,
        modifiedAt,
      }
    }

    function editResultOf(overrides: Partial<CanvasEditResult> = {}): CanvasEditResult {
      return { created: [], updated: [], deleted: [], tempIds: {}, warnings: [], ...overrides }
    }

    type Harness = {
      tools: Map<string, McpToolRegistration>
      boards: Map<string, CanvasBoardState>
      summaries: CanvasBoardSummary[]
      calls: string[]
      actors: CanvasActor[]
      readerKeys: string[]
      actions: CanvasActionEntry[]
      changes: string[]
      image: CanvasImage
      revealed: boolean
      /** Set to a code+message and the next service call of that kind fails with it. */
      fail: { where: string; code: Parameters<typeof canvasFail>[0]; message: string } | null
      enabled: boolean
      editResult: CanvasEditResult
      /** What the service says `canvas.layout` could not arrange. */
      layoutWarnings: string[]
    }

    function harness(seedBoards: Array<[string, CanvasBoardState]> = []): Harness {
      const state: Harness = {
        tools: new Map(),
        boards: new Map(seedBoards),
        summaries: [],
        calls: [],
        actors: [],
        readerKeys: [],
        actions: [],
        changes: [],
        image: { data: 'UE5H', mimeType: 'image/png', width: 800, height: 600 },
        revealed: true,
        fail: null,
        enabled: true,
        editResult: editResultOf(),
        layoutWarnings: [],
      }

      const failed = <T>(where: string) => {
        if (state.fail?.where !== where) return null
        return canvasFail<T>(state.fail.code, state.fail.message)
      }

      const service: CanvasService = {
        listBoards: async (workspaceId) => {
          state.calls.push(`listBoards:${workspaceId}`)
          return failed<CanvasBoardSummary[]>('listBoards') ?? canvasOk(state.summaries)
        },
        readBoard: async (ref, opts) => {
          state.calls.push(`readBoard:${ref.path}:${opts?.create ? 'create' : 'read'}`)
          const known = failed<CanvasBoardState>('readBoard')
          if (known) return known
          const existing = state.boards.get(ref.path)
          if (existing) return canvasOk(existing)
          if (opts?.create) {
            const created = boardState(ref.path)
            state.boards.set(ref.path, created)
            return canvasOk(created)
          }
          return canvasFail('not_found', `Nothing at ${ref.path}.`)
        },
        boardExists: async (ref) => {
          state.calls.push(`boardExists:${ref.path}`)
          return failed<boolean>('boardExists') ?? canvasOk(state.boards.has(ref.path))
        },
        edit: async (ref, edit, actor) => {
          state.calls.push(`edit:${ref.path}:${JSON.stringify(edit)}`)
          state.actors.push(actor)
          const known = failed<{ state: CanvasBoardState; result: CanvasEditResult }>('edit')
          if (known) return known
          const board = state.boards.get(ref.path) ?? boardState(ref.path)
          return canvasOk({ state: board, result: state.editResult })
        },
        layout: async (ref, request, actor) => {
          state.calls.push(`layout:${ref.path}:${request.op}:${request.elementIds.join(',')}:${request.gap ?? '-'}`)
          state.actors.push(actor)
          const known = failed<{ state: CanvasBoardState; warnings: string[] }>('layout')
          if (known) return known
          return canvasOk({
            state: state.boards.get(ref.path) ?? boardState(ref.path),
            warnings: state.layoutWarnings,
          })
        },
        importContent: async (ref, request, actor) => {
          state.calls.push(`import:${ref.path}:${request.mode}:${request.mermaid ? 'mermaid' : 'scene'}`)
          state.actors.push(actor)
          const known = failed<{ state: CanvasBoardState; result: CanvasEditResult }>('import')
          if (known) return known
          return canvasOk({ state: state.boards.get(ref.path) ?? boardState(ref.path), result: state.editResult })
        },
        screenshot: async (ref, opts) => {
          state.calls.push(
            `screenshot:${ref.path}:${opts.elementIds?.join(',') ?? 'all'}:${opts.maxEdge ?? '-'}:${opts.dark ?? '-'}`,
          )
          return failed<CanvasImage>('screenshot') ?? canvasOk(state.image)
        },
        requestOpen: async (ref) => {
          state.calls.push(`requestOpen:${ref.path}`)
          return failed<{ revealed: boolean }>('requestOpen') ?? canvasOk({ revealed: state.revealed })
        },
        changesSinceLastRead: (ref, key) => {
          state.calls.push(`changes:${ref.path}`)
          state.readerKeys.push(key)
          return state.changes
        },
        actions: (ref) => {
          state.calls.push(`actions:${ref.path}`)
          return state.actions
        },
        dispose: async () => {},
      }

      const registrations = createCanvasTools({
        service,
        hasWorkspace: (workspaceId) => workspaceId === 'ws-1' || workspaceId === 'ws-2',
        isCanvasEnabled: () => state.enabled,
      })
      state.tools = reached(registrations)
      return state
    }

    const bound: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1' } }
    const named: McpConnectionContext = {
      metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-a', agentName: 'Draughtsman' },
    }
    const unbound: McpConnectionContext = { metadata: { kind: 'external-local' } }

    function structured(result: McpToolResult): Record<string, unknown> {
      return result.structuredContent ?? {}
    }

    function errorOf(result: McpToolResult): { code: string; message: string } {
      return structured(result).error as { code: string; message: string }
    }

    function isPlainObject(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * Walks a hand-written schema the way a model reads it: every property has to
     * say what it is for, and every object level has to refuse what it does not
     * declare, or a typo in a field name is silently dropped instead of reported.
     */
    function schemaProblems(node: unknown, path: string, problems: string[]): void {
      if (!isPlainObject(node)) return
      if (node.type === 'object') {
        if (node.additionalProperties !== false && !FREEFORM_SCHEMA_PATHS.has(path)) {
          problems.push(`${path}: additionalProperties must be false`)
        }
        const properties = node.properties
        if (isPlainObject(properties)) {
          for (const [key, child] of Object.entries(properties)) {
            const where = `${path}.${key}`
            const description = isPlainObject(child) ? child.description : null
            if (typeof description !== 'string' || description.trim() === '') {
              problems.push(`${where}: every property needs a description`)
            }
            schemaProblems(child, where, problems)
          }
        }
      }
      if (node.items !== undefined) schemaProblems(node.items, `${path}[]`, problems)
    }

    async function main(): Promise<void> {
      await run('the family registers eight tools, and only the four writes are classified as mutations', () => {
        const h = harness()
        assert.deepEqual([...h.tools.keys()], TOOL_NAMES)
        assert.deepEqual(
          [...CANVAS_MUTATION_TOOL_NAMES],
          ['canvas.open', 'canvas.edit', 'canvas.layout', 'canvas.import'],
        )
        for (const name of TOOL_NAMES) {
          const mutation = CANVAS_MUTATION_TOOL_NAMES.includes(name)
          assert.equal(isStudioGatewayMutation(name), mutation, `${name} gateway classification`)
        }
      })

      await run('every tool carries a description and a schema a model can read', () => {
        const h = harness()
        const problems: string[] = []
        for (const tool of h.tools.values()) {
          assert.equal(tool.description.length > 80, true, `${tool.name}: the description is the documentation`)
          schemaProblems(tool.inputSchema, tool.name, problems)
        }
        assert.deepEqual(problems, [])
        // The skeleton is the format an agent authors in, so the three traps are named.
        const create = (
          (h.tools.get('canvas.edit')!.inputSchema as Record<string, never>).properties as Record<string, never>
        ).create as Record<string, never>
        const skeleton = (create.items as Record<string, never>).properties as Record<string, { description: string }>
        assert.match(skeleton.startElementId.description, /ONLY way to attach/)
        assert.match(skeleton.y.description, /downward/i)
        assert.match(skeleton.text.description, /CENTRED/)
      })

      await run('workspace binding copies the browser family: bound, explicit, mismatched, unknown', async () => {
        const h = harness()
        const list = h.tools.get('canvas.list')!
        assert.equal((await list.handler({}, bound)).isError, undefined)
        assert.equal(errorOf(await list.handler({}, unbound)).code, 'no_workspace')
        assert.equal((await list.handler({ workspaceId: 'ws-2' }, unbound)).isError, undefined)
        assert.equal(errorOf(await list.handler({ workspaceId: 'ws-2' }, bound)).code, 'forbidden')
        assert.equal(errorOf(await list.handler({ workspaceId: 'ws-9' }, unbound)).code, 'unknown_workspace')
      })

      await run('an unnamed board is the most recently changed one, else the default path', async () => {
        const h = harness()
        h.summaries = [summary('diagrams/old.excalidraw', 1_000), summary('diagrams/recent.excalidraw', 9_000)]
        h.boards.set('diagrams/recent.excalidraw', boardState('diagrams/recent.excalidraw'))
        await h.tools.get('canvas.describe')!.handler({}, bound)
        assert.ok(h.calls.includes('readBoard:diagrams/recent.excalidraw:read'), h.calls.join(' '))

        const empty = harness()
        await empty.tools.get('canvas.open')!.handler({}, bound)
        assert.ok(empty.calls.includes(`readBoard:${DEFAULT_CANVAS_BOARD_PATH}:create`), empty.calls.join(' '))

        // A named board is normalized: a bare name lands in the default folder.
        const explicit = harness()
        await explicit.tools.get('canvas.open')!.handler({ board: 'architecture' }, bound)
        assert.ok(explicit.calls.includes('readBoard:architecture.excalidraw:create'), explicit.calls.join(' '))
        assert.equal(
          explicit.calls.some((call) => call.startsWith('listBoards')),
          false,
          'a named board asks for no listing',
        )
        const refused = await explicit.tools.get('canvas.open')!.handler({ board: '../escape.excalidraw' }, bound)
        assert.equal(errorOf(refused).code, 'invalid_path')
      })

      await run('a bare name finds a board already in the legacy folder when the store has none', async () => {
        const legacy = 'diagrams/architecture.excalidraw'
        const stored = 'architecture.excalidraw'

        const h = harness([[legacy, boardState(legacy)]])
        await h.tools.get('canvas.describe')!.handler({ board: 'architecture' }, bound)
        assert.ok(h.calls.includes(`readBoard:${legacy}:read`), h.calls.join(' '))

        // The store wins when it has the name: that is where the board lives now.
        const both = harness([
          [legacy, boardState(legacy)],
          [stored, boardState(stored)],
        ])
        await both.tools.get('canvas.describe')!.handler({ board: 'architecture' }, bound)
        assert.ok(both.calls.includes(`readBoard:${stored}:read`), both.calls.join(' '))
        assert.equal(both.calls.includes(`boardExists:${legacy}`), false, 'the legacy folder is not asked about')

        // A named folder means that folder, and is never re-pointed.
        const named = harness([[legacy, boardState(legacy)]])
        await named.tools.get('canvas.open')!.handler({ board: 'docs/architecture' }, bound)
        assert.ok(named.calls.includes('readBoard:docs/architecture.excalidraw:create'), named.calls.join(' '))
        assert.equal(
          named.calls.some((call) => call.startsWith('boardExists')),
          false,
        )
      })

      await run('with the module disabled every tool answers the gateway’s words and touches nothing', async () => {
        const h = harness()
        h.enabled = false
        const given: Record<string, unknown> = { op: 'align', elementIds: ['a'], create: [] }
        for (const [name, tool] of h.tools) {
          // Each tool is given only the arguments it takes: one it does not take is refused by name first.
          const declared = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>)
          const args = Object.fromEntries(Object.entries(given).filter(([key]) => declared.includes(key)))
          const result = await tool.handler(args, bound)
          assert.equal(result.isError, true, name)
          assert.equal(errorOf(result).code, 'canvas_module_disabled', name)
          assert.equal(
            errorOf(result).message,
            'The Canvas module is disabled. Enable it in Settings → Modules to use canvas tools.',
            name,
          )
        }
        assert.equal(h.calls.length, 0, 'a disabled module runs no service call at all')
      })

      await run('canvas.list reports boards newest first with a readable time', async () => {
        const h = harness()
        h.summaries = [summary('diagrams/a.excalidraw', 1_000, 3), summary('diagrams/b.excalidraw', 5_000, 9)]
        const result = await h.tools.get('canvas.list')!.handler({}, bound)
        const boards = structured(result).boards as Array<Record<string, unknown>>
        assert.deepEqual(
          boards.map((board) => board.path),
          ['diagrams/b.excalidraw', 'diagrams/a.excalidraw'],
        )
        assert.equal(boards[0].elementCount, 9)
        assert.equal(boards[0].modifiedAt, new Date(5_000).toISOString())
      })

      await run('canvas.open creates the board, reveals the tab, and says so plainly when no window can', async () => {
        const h = harness()
        const revealed = await h.tools.get('canvas.open')!.handler({ board: 'plan' }, bound)
        assert.equal(structured(revealed).revealed, true)
        assert.equal(structured(revealed).note, undefined)
        assert.deepEqual((structured(revealed).board as Record<string, unknown>).name, 'plan')

        const hidden = harness()
        hidden.revealed = false
        const result = await hidden.tools.get('canvas.open')!.handler({ board: 'plan' }, bound)
        assert.equal(result.isError, undefined, 'a hidden workspace is not a failure')
        assert.equal(structured(result).revealed, false)
        assert.match(String(structured(result).note), /every other canvas tool works on it/)
      })

      await run('canvas.describe appends the lint, the person’s changes and the recent actions', async () => {
        const h = harness([
          [
            DEFAULT_CANVAS_BOARD_PATH,
            boardState(DEFAULT_CANVAS_BOARD_PATH, [element({ id: 'r1', type: 'rectangle', x: 0, y: 0 })]),
          ],
        ])
        h.changes = ['Moved "Gateway".']
        h.actions = [
          {
            id: 'a1',
            action: 'canvas.edit',
            summary: 'created 3',
            status: 'succeeded',
            actor: 'agent',
            agentName: 'Draughtsman',
            startedAt: 1_000,
          },
        ]
        const result = await h.tools.get('canvas.describe')!.handler({}, named)
        const body = structured(result)
        assert.equal(body.detail, 'outline')
        assert.match(String(body.description), /Changed since you last looked:/)
        assert.match(String(body.description), /Lint: \d+\/100/)
        assert.match(String(body.description), /canvas\.edit by Draughtsman/)
        assert.deepEqual(body.changesSinceLastRead, ['Moved "Gateway".'])
        assert.equal((body.lint as { score: number }).score >= 0, true)
        assert.equal(body.elements, undefined, 'the skeleton rides on detail: full only')
        // The reader is the agent, not the connection: two agents each see their own changes.
        assert.deepEqual(h.readerKeys, ['ws-1\u0000agent-a'])
        const anonymous = await h.tools.get('canvas.describe')!.handler({}, bound)
        assert.equal(anonymous.isError, undefined)
        assert.equal(h.readerKeys[1], 'ws-1\u0000anonymous')
      })

      await run(
        'canvas.describe full returns the skeleton, and swaps it for the outline when it is too big',
        async () => {
          const small = harness([
            [
              DEFAULT_CANVAS_BOARD_PATH,
              boardState(DEFAULT_CANVAS_BOARD_PATH, [element({ id: 'r1', type: 'rectangle' })]),
            ],
          ])
          const full = structured(await small.tools.get('canvas.describe')!.handler({ detail: 'full' }, bound))
          assert.equal(full.detail, 'full')
          assert.deepEqual(
            (full.elements as Array<{ id: string }>).map((entry) => entry.id),
            ['r1'],
          )

          const huge = harness([
            [
              DEFAULT_CANVAS_BOARD_PATH,
              boardState(
                DEFAULT_CANVAS_BOARD_PATH,
                Array.from({ length: 1200 }, (_, i) =>
                  element({ id: `r${i}`, type: 'rectangle', x: i * 10, y: i * 5, text: 'x'.repeat(120) }),
                ),
              ),
            ],
          ])
          const bounded = structured(await huge.tools.get('canvas.describe')!.handler({ detail: 'full' }, bound))
          assert.equal(bounded.detail, 'outline', 'a truncated skeleton would be edited as if it were the whole board')
          assert.equal(bounded.elements, undefined)
          assert.equal(bounded.elementsOmitted, true)
          assert.match(String(bounded.description), /canvas\.find/)
          const line = JSON.stringify({ result: bounded }).length * 2
          assert.equal(line < 1024 * 1024, true, 'the result fits one socket line even serialised twice')
        },
      )

      await run('canvas.find needs a filter, returns skeletons, and caps what it hands back', async () => {
        const h = harness([
          [
            DEFAULT_CANVAS_BOARD_PATH,
            boardState(
              DEFAULT_CANVAS_BOARD_PATH,
              Array.from({ length: 250 }, (_, i) => element({ id: `r${i}`, type: 'rectangle', x: i, y: i })),
            ),
          ],
        ])
        const noFilter = await h.tools.get('canvas.find')!.handler({}, bound)
        assert.equal(errorOf(noFilter).code, 'invalid')
        assert.match(errorOf(noFilter).message, /canvas\.describe/)

        const capped = structured(await h.tools.get('canvas.find')!.handler({ type: 'rectangle' }, bound))
        assert.equal(capped.matched, 250)
        assert.equal((capped.elements as unknown[]).length, 200)
        assert.equal(capped.omitted, 50)

        const byId = structured(await h.tools.get('canvas.find')!.handler({ ids: ['r7'] }, bound))
        assert.deepEqual(
          (byId.elements as Array<{ id: string }>).map((entry) => entry.id),
          ['r7'],
        )

        const badBox = await h.tools.get('canvas.find')!.handler({ bbox: { x: 0, y: 0, width: 10 } }, bound)
        assert.equal(errorOf(badBox).code, 'invalid')
      })

      await run(
        'canvas.edit passes the request through, creates the board, and reports ids, warnings and lint',
        async () => {
          const h = harness()
          h.editResult = editResultOf({
            created: ['id-1'],
            tempIds: { api: 'id-1' },
            warnings: ['Repaired a binding.'],
          })
          const empty = await h.tools.get('canvas.edit')!.handler({}, named)
          assert.equal(errorOf(empty).code, 'invalid_edit')
          assert.equal(h.calls.length, 0, 'an empty edit never reaches the service')

          const result = await h.tools
            .get('canvas.edit')!
            .handler({ create: [{ tempId: 'api', type: 'rectangle', x: 0, y: 0 }], delete: ['gone'] }, named)
          const body = structured(result)
          assert.deepEqual(body.tempIds, { api: 'id-1' })
          assert.deepEqual(body.created, ['id-1'])
          assert.deepEqual(body.warnings, ['Repaired a binding.'])
          assert.equal(typeof (body.lint as { score: number }).score, 'number')
          assert.ok(
            h.calls.includes(`readBoard:${DEFAULT_CANVAS_BOARD_PATH}:create`),
            'a mutation creates the board on demand',
          )
          const sent = h.calls.find((call) => call.startsWith('edit:'))!
          assert.match(sent, /"delete":\["gone"\]/)
          assert.match(sent, /"tempId":"api"/)
          // The actor is built from the connection, so the action log can name the agent.
          assert.deepEqual(h.actors[0], {
            kind: 'agent',
            workspaceId: 'ws-1',
            agentId: 'agent-a',
            agentName: 'Draughtsman',
          })
        },
      )

      await run('canvas.layout forwards one arrange operation and refuses one it cannot name', async () => {
        const h = harness()
        const ok = await h.tools.get('canvas.layout')!.handler({ op: 'stack', elementIds: ['a', 'b'], gap: 100 }, bound)
        assert.equal(ok.isError, undefined)
        assert.ok(h.calls.includes(`layout:${DEFAULT_CANVAS_BOARD_PATH}:stack:a,b:100`), h.calls.join(' '))
        assert.deepEqual(structured(ok).elementIds, ['a', 'b'])
        assert.equal(
          errorOf(await h.tools.get('canvas.layout')!.handler({ op: 'shuffle', elementIds: ['a'] }, bound)).code,
          'invalid',
        )
        assert.equal(
          errorOf(await h.tools.get('canvas.layout')!.handler({ op: 'align', elementIds: 'a' }, bound)).code,
          'invalid',
        )
      })

      await run('canvas.layout reports what it could not arrange rather than answering "done"', async () => {
        const h = harness()
        h.layoutWarnings = [
          'stroke-1 is a freedraw, which this format cannot re-describe; its geometry was left alone.',
        ]
        const answer = await h.tools
          .get('canvas.layout')!
          .handler({ op: 'align', elementIds: ['stroke-1'], to: 'left' }, bound)
        assert.equal(answer.isError, undefined)
        assert.deepEqual(structured(answer).warnings, h.layoutWarnings, 'the agent is told the align moved nothing')
      })

      await run('canvas.import takes exactly one source and defaults to merging', async () => {
        const h = harness()
        assert.equal(errorOf(await h.tools.get('canvas.import')!.handler({}, bound)).code, 'invalid')
        assert.equal(
          errorOf(
            await h.tools.get('canvas.import')!.handler({ mermaid: 'flowchart TD', scene: { elements: [] } }, bound),
          ).code,
          'invalid',
        )
        assert.equal(h.calls.length, 0, 'neither refusal reached the service')

        const merged = await h.tools.get('canvas.import')!.handler({ mermaid: 'flowchart TD\nA-->B' }, bound)
        assert.equal(structured(merged).mode, 'merge')
        assert.equal(structured(merged).source, 'mermaid')
        assert.ok(h.calls.includes(`import:${DEFAULT_CANVAS_BOARD_PATH}:merge:mermaid`))
        const replaced = await h.tools
          .get('canvas.import')!
          .handler({ scene: { elements: [] }, mode: 'replace' }, bound)
        assert.equal(structured(replaced).mode, 'replace')
        assert.ok(h.calls.includes(`import:${DEFAULT_CANVAS_BOARD_PATH}:replace:scene`))
      })

      await run(
        'canvas.screenshot answers with an image block and keeps the pixels out of the structured result',
        async () => {
          const h = harness([
            [
              DEFAULT_CANVAS_BOARD_PATH,
              boardState(DEFAULT_CANVAS_BOARD_PATH, [
                element({ id: 'r1', type: 'rectangle' }),
                element({ id: 'r2', type: 'rectangle' }),
                element({ id: 'gone', type: 'rectangle', isDeleted: true }),
              ]),
            ],
          ])
          const result = await h.tools.get('canvas.screenshot')!.handler({ maxEdge: 900, dark: true }, bound)
          assert.equal(result.content.length, 2)
          assert.equal(result.content[0].type, 'text')
          assert.deepEqual(result.content[1], { type: 'image', data: 'UE5H', mimeType: 'image/png' })
          const body = structured(result)
          assert.equal(body.caption, 'canvas: 800x600 image/png, 2 element(s).')
          assert.equal(JSON.stringify(body).includes('UE5H'), false, 'the base64 rides in the content block only')
          assert.ok(h.calls.includes(`screenshot:${DEFAULT_CANVAS_BOARD_PATH}:all:900:true`))

          const subset = await h.tools.get('canvas.screenshot')!.handler({ elementIds: ['r1'] }, bound)
          assert.equal(structured(subset).capturedElements, 1)
          assert.ok(h.calls.includes(`screenshot:${DEFAULT_CANVAS_BOARD_PATH}:r1:-:-`))
        },
      )

      await run('a canvas error answers in its own words, and a missing board says how to make one', async () => {
        const h = harness()
        const missing = await h.tools.get('canvas.describe')!.handler({ board: 'nothing-here' }, bound)
        assert.equal(errorOf(missing).code, 'not_found')
        assert.match(errorOf(missing).message, /canvas\.open creates it/)
        assert.match(errorOf(missing).message, /canvas\.edit/)

        h.fail = { where: 'edit', code: 'interrupted', message: 'The person started drawing; your edit was abandoned.' }
        const interrupted = await h.tools.get('canvas.edit')!.handler({ create: [] }, bound)
        assert.equal(interrupted.isError, true)
        assert.deepEqual(errorOf(interrupted), {
          code: 'interrupted',
          message: 'The person started drawing; your edit was abandoned.',
        })

        h.fail = { where: 'screenshot', code: 'too_large', message: 'The rendered board was 3 MB.' }
        h.boards.set(DEFAULT_CANVAS_BOARD_PATH, boardState(DEFAULT_CANVAS_BOARD_PATH))
        const tooLarge = await h.tools.get('canvas.screenshot')!.handler({}, bound)
        assert.equal(errorOf(tooLarge).code, 'too_large')

        h.fail = { where: 'listBoards', code: 'unknown_workspace', message: 'Workspace "ws-1" has no folder.' }
        assert.equal(errorOf(await h.tools.get('canvas.list')!.handler({}, bound)).code, 'unknown_workspace')
      })
    }

    try {
      await main()
      if (through === 'the shell') assert.ok(looped > 20, `only ${looped} calls went through the shell`)
    } finally {
      for (const loop of loops) await (await loop).close()
    }
  })

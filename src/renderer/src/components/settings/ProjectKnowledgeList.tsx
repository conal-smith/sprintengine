import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Checkbox, EmptyState, GhostButton, InlineNotice, Input, MicroChip, StatusDot } from '../ui'
import type { Tone } from '../ui'
import { SettingCard, SettingsSectionTitle } from './SettingsAtoms'
import { listOpenProjectKnowledge, relativePathBetween, type ProjectKnowledgeEntry } from '../../utils/projectKnowledge'
import { isAbsolutePath } from '../../store/slices/memorySlice'
import { isImeKey } from '../../utils/imeKey'

type RowStatus = MemoryRootStatus | null

function dotTone(status: RowStatus, checking: boolean): Tone {
  if (checking || !status) return 'neutral'
  return status.ok ? 'good' : 'warn'
}

function dotLabel(entry: ProjectKnowledgeEntry, status: RowStatus, checking: boolean): string {
  if (checking) return `${entry.name}: checking knowledge folder`
  if (!entry.relativeRoot && !status) return `${entry.name}: no knowledge folder`
  if (!status) return `${entry.name}: knowledge folder set`
  return status.ok ? `${entry.name}: knowledge folder ready` : `${entry.name}: knowledge folder unavailable`
}

type ProjectKnowledgeListProps = {
  /** Resolved project root of the active workspace, marked as "current". */
  activeProjectRoot: string | null
}

/**
 * Knowledge Graph settings list. One row per open project (deduped across its
 * workspaces); each row sets that project's knowledge folder. Multi-select + "Point at shared folder…" assigns one real folder to
 * several projects, storing each project's own relative path to it.
 */
export function ProjectKnowledgeList({ activeProjectRoot }: ProjectKnowledgeListProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots)
  const setProjectKnowledgeRoot = useWorkspaceStore((s) => s.setProjectKnowledgeRoot)

  const projects = useMemo(
    () => listOpenProjectKnowledge(workspaces, projectKnowledgeRoots),
    [workspaces, projectKnowledgeRoots],
  )

  const activeKey = activeProjectRoot ? activeProjectRoot.toLowerCase() : null

  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [bulkMessage, setBulkMessage] = useState<{ tone: 'accent' | 'warn'; text: string } | null>(null)
  const validatedRef = useRef<Set<string>>(new Set())

  const validate = useCallback(async (key: string, projectRoot: string, value: string) => {
    const relativeRoot = value.trim()
    if (!relativeRoot) {
      setStatuses((s) => ({ ...s, [key]: null }))
      return
    }
    if (isAbsolutePath(relativeRoot)) {
      setStatuses((s) => ({
        ...s,
        [key]: {
          ok: false,
          status: 'invalid-relative-path',
          relativeRoot: null,
          message: 'Knowledge path must be relative to the project folder.',
        },
      }))
      return
    }
    setChecking((c) => ({ ...c, [key]: true }))
    try {
      const status = await window.api.memoryResolveRoot({ workspaceRoot: projectRoot, relativeRoot })
      setStatuses((s) => ({ ...s, [key]: status }))
    } catch (error) {
      setStatuses((s) => ({
        ...s,
        [key]: {
          ok: false,
          status: 'inaccessible',
          relativeRoot,
          message: error instanceof Error ? error.message : 'Unable to check knowledge path.',
        },
      }))
    } finally {
      setChecking((c) => ({ ...c, [key]: false }))
    }
  }, [])

  // Seed drafts for newly-appeared projects and validate already-configured ones
  // once, so each row's status dot reflects the real folder on open.
  useEffect(() => {
    setDrafts((prev) => {
      let changed = false
      const next = { ...prev }
      for (const project of projects) {
        if (!(project.key in next)) {
          next[project.key] = project.relativeRoot ?? ''
          changed = true
        }
      }
      return changed ? next : prev
    })
    for (const project of projects) {
      if (project.relativeRoot && !validatedRef.current.has(project.key)) {
        validatedRef.current.add(project.key)
        void validate(project.key, project.projectRoot, project.relativeRoot)
      }
    }
  }, [projects, validate])

  const commit = useCallback(
    (entry: ProjectKnowledgeEntry, value: string) => {
      const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
      setDrafts((d) => ({ ...d, [entry.key]: trimmed }))
      setProjectKnowledgeRoot(entry.projectRoot, trimmed || null)
      if (trimmed) void validate(entry.key, entry.projectRoot, trimmed)
      else setStatuses((s) => ({ ...s, [entry.key]: null }))
    },
    [setProjectKnowledgeRoot, validate],
  )

  const chooseFolder = useCallback(
    async (entry: ProjectKnowledgeEntry) => {
      const dir = await window.api.openDir()
      if (!dir) return
      const relative = relativePathBetween(entry.projectRoot, dir)
      if (!relative || relative === '.') {
        setStatuses((s) => ({
          ...s,
          [entry.key]: {
            ok: false,
            status: 'invalid-relative-path',
            relativeRoot: null,
            message: 'Choose a folder that can be expressed relative to the project folder.',
          },
        }))
        return
      }
      setDrafts((d) => ({ ...d, [entry.key]: relative }))
      setProjectKnowledgeRoot(entry.projectRoot, relative)
      void validate(entry.key, entry.projectRoot, relative)
    },
    [setProjectKnowledgeRoot, validate],
  )

  const selectedEntries = useMemo(() => projects.filter((project) => selected[project.key]), [projects, selected])
  const allSelected = projects.length > 0 && projects.every((project) => selected[project.key])
  const someSelected = selectedEntries.length > 0

  const toggleAll = useCallback(() => {
    setSelected(() => {
      if (allSelected) return {}
      const next: Record<string, boolean> = {}
      for (const project of projects) next[project.key] = true
      return next
    })
  }, [allSelected, projects])

  const chooseSharedFolder = useCallback(async () => {
    if (!selectedEntries.length) return
    const dir = await window.api.openDir()
    if (!dir) return
    let failed = 0
    for (const entry of selectedEntries) {
      const relative = relativePathBetween(entry.projectRoot, dir)
      if (!relative || relative === '.') {
        failed += 1
        setStatuses((s) => ({
          ...s,
          [entry.key]: {
            ok: false,
            status: 'invalid-relative-path',
            relativeRoot: null,
            message: `Cannot express ${dir} relative to this project folder.`,
          },
        }))
        continue
      }
      setDrafts((d) => ({ ...d, [entry.key]: relative }))
      setProjectKnowledgeRoot(entry.projectRoot, relative)
      void validate(entry.key, entry.projectRoot, relative)
    }
    const ok = selectedEntries.length - failed
    setBulkMessage(
      failed
        ? {
            tone: 'warn',
            text: `Pointed ${ok} of ${selectedEntries.length} project${selectedEntries.length === 1 ? '' : 's'} at ${dir}. ${failed} could not be made relative to its project folder.`,
          }
        : {
            tone: 'accent',
            text: `Pointed ${ok} project${ok === 1 ? '' : 's'} at ${dir}.`,
          },
    )
  }, [selectedEntries, setProjectKnowledgeRoot, validate])

  if (projects.length === 0) {
    return <EmptyState density="list" title="Open a workspace first." />
  }

  // The list card (setting-row → The list card, 2026-09-15): the band above
  // names the group and carries the count and the controls that act on the
  // whole list; the card is the group's one edge; the rows sit full-bleed
  // inside it. This list used to draw its own idiom — rows bled 8px past the
  // page edge with a rounded selection fill on the current project — which
  // made it the one settings list that looked like neither the others nor the
  // Remote tab's machines.
  return (
    <section className="space-y-2">
      <SettingsSectionTitle
        count={projects.length}
        action={
          projects.length > 1 ? (
            // One slot, holding what acts on the whole list: the tri-state box,
            // and the bulk actions once something is ticked. The count of ticked
            // rows sits beside them so the verb says how many it will touch.
            <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
              {someSelected ? (
                <>
                  <span className="tabular-nums">{selectedEntries.length} selected</span>
                  <GhostButton size="sm" onClick={() => void chooseSharedFolder()}>
                    Point at shared folder…
                  </GhostButton>
                  <GhostButton size="sm" onClick={() => setSelected({})}>
                    Clear
                  </GhostButton>
                </>
              ) : null}
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                onChange={toggleAll}
                label="Select all"
                size="body"
                className="w-fit"
              />
            </div>
          ) : undefined
        }
      >
        Projects
      </SettingsSectionTitle>

      <SettingCard as="ul" ariaLabel="Projects">
        {projects.map((entry) => {
          const status = statuses[entry.key] ?? null
          const isChecking = Boolean(checking[entry.key])
          const isActive = activeKey === entry.key
          const isSelected = Boolean(selected[entry.key])
          const error = status && !status.ok ? status.message : null
          return (
            <li key={entry.key} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={isSelected}
                  ariaLabel={`Select ${entry.name}`}
                  onChange={() => setSelected((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))}
                  className="shrink-0"
                />
                <StatusDot tone={dotTone(status, isChecking)} label={dotLabel(entry, status, isChecking)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{entry.name}</span>
                    {/* The project the open workspace belongs to. A chip, as the
                        Remote tab marks "This device" — not a selection fill,
                        which would say "picked" about a row nobody picked. */}
                    {isActive ? <MicroChip>Current</MicroChip> : null}
                    {entry.workspaceCount > 1 ? (
                      <span className="shrink-0 tabular-nums text-meta text-[color:var(--text-muted)]">
                        {entry.workspaceCount} workspaces
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-meta text-[color:var(--text-subtle)]">
                    {entry.projectRoot}
                  </div>
                </div>
                <div className="flex w-[320px] shrink-0 items-center gap-2">
                  {/* A path is an identifier, so the field is mono. Its chrome is
                      the kit's: this module used to declare a SECOND, different
                      `ROW_INPUT_CLASS` — same name as SettingsPanel's, different
                      ground and width — so "the" row input was a coin flip.
                     */}
                  <Input
                    value={drafts[entry.key] ?? ''}
                    aria-label={`Knowledge folder for ${entry.name}`}
                    onChange={(event) => setDrafts((d) => ({ ...d, [entry.key]: event.target.value }))}
                    onBlur={(event) => commit(entry, event.target.value)}
                    onKeyDown={(event) => {
                      if (isImeKey(event)) return
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    placeholder="../ecosystem-knowledge"
                    size="md"
                    fullWidth={false}
                    className="min-w-0 flex-1 font-mono"
                  />
                  <GhostButton
                    size="md"
                    onClick={() => void chooseFolder(entry)}
                    className="h-control-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                  >
                    Choose
                  </GhostButton>
                </div>
              </div>
              {error ? (
                // Under the name, on its left edge: the checkbox, the dot and
                // their two gaps.
                // design-tokens-allow: alignment — the error's left edge is the name's (16px box + 6px dot + two 12px gaps), structure not rhythm
                <p className="mt-1 pl-[3.25rem] text-meta text-[color:var(--tone-warn)]">{error}</p>
              ) : null}
            </li>
          )
        })}
      </SettingCard>

      {bulkMessage ? (
        bulkMessage.tone === 'warn' ? (
          <InlineNotice tone="warn">{bulkMessage.text}</InlineNotice>
        ) : (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">{bulkMessage.text}</p>
        )
      ) : null}
    </section>
  )
}

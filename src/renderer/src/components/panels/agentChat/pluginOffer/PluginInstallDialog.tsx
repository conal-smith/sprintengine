import { useEffect, useId, useState, type JSX } from 'react'

import { describeUnreadPlugin, type ScannedPlugin, type SkillSource } from '../../../../../../shared/skills'
import { showToast } from '../../../../store/toastStore'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { DescribedCheckRow, DescribedCheckRowList, GhostButton, InlineNotice, Spinner } from '../../../ui'
import { ExtensionIcon } from '../../../ui/ExtensionIcon'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../../ui/Modal'
import { extensionIconProps, pluginArtwork } from '../../../workspace/globalSurface/extensions/catalogue/pluginArtwork'
import { summarizePluginInstall } from '../../../workspace/globalSurface/extensions/plugins/pluginsSurfaceModel'
import { describeServer, initialSelection, PRESELECT_SKILLS_UP_TO, pluginReadWhole } from './pluginOfferModel'

// The one step between an agent's offer and anything landing on disk: what
// the plugin is, where it comes from, and the servers and skills it would
// add, each with its own box. Only what is ticked is installed, so a plugin's
// hooks never come with it from here (a chosen install copies the chosen
// skills and servers alone), and a plugin of fifty skills does not drop fifty
// into every agent's folder.

const ICON_SIZE = 40
/** Skills listed before "Show all": enough to see what kind of plugin it is. */
const SKILLS_SHOWN = 5

function toggled(set: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

export function PluginInstallDialog({
  source,
  plugin: offered,
  workspaceRoot,
  onClose,
  onInstalled,
}: {
  source: SkillSource
  plugin: ScannedPlugin
  workspaceRoot: string
  onClose: () => void
  onInstalled: () => void
}): JSX.Element {
  const titleId = useId()
  const rowId = useId()
  const upsertMcpServer = useWorkspaceStore((state) => state.upsertMcpServer)
  // A plugin the catalogue only listed is read whole before its parts are
  // shown: what is ticked here has to be what is installed.
  const [plugin, setPlugin] = useState<ScannedPlugin | null>(pluginReadWhole(offered) ? offered : null)
  const [readError, setReadError] = useState<string | null>(null)
  const [selection, setSelection] = useState(() => (plugin ? initialSelection(plugin) : null))
  const [allSkills, setAllSkills] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (plugin) return
    let cancelled = false
    window.api
      .skillsScanLinkedPlugin({ sourceId: source.id, pluginId: offered.id })
      .then((read) => {
        if (cancelled) return
        if (!read.ok) {
          setReadError(read.message)
          return
        }
        // A read that still left it partly unseen: listing what was seen would
        // offer an install the service then refuses.
        if (!read.plugin.componentsKnown) {
          setReadError(describeUnreadPlugin(read.plugin))
          return
        }
        setPlugin(read.plugin)
        setSelection(initialSelection(read.plugin))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setReadError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [offered.id, plugin, source.id])

  const install = async (): Promise<void> => {
    if (!plugin || !selection || busy) return
    setBusy(true)
    setError(null)
    try {
      // Both lists, always, even empty: a chosen install is the one that never
      // brings a plugin's hooks along.
      const result = await window.api.skillsInstallPlugin({
        sourceId: source.id,
        pluginId: plugin.id,
        workspaceRoot,
        skillIds: plugin.components.skills.filter((skill) => selection.skillIds.has(skill.id)).map((s) => s.id),
        mcpServerIds: plugin.components.mcpServers
          .filter((server) => selection.serverIds.has(server.id))
          .map((server) => server.id),
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      // The servers go into Studio's MCP settings, as the Extensions door's
      // install puts them, and from there into this workspace's config.
      for (const server of result.mcpServers) upsertMcpServer(server)
      const settings = useWorkspaceStore.getState().appSettings.mcp
      if (result.mcpServers.length > 0 && settings?.syncEnabled && typeof window.api.mcpSync === 'function') {
        await window.api.mcpSync({ workspaceRoot, settings }).catch(() => {})
      }
      // What was copied, and what did not stop the install but will matter
      // (a skill that failed to copy, a server whose runtime is missing).
      showToast({
        tone: result.warnings.length > 0 ? 'warn' : 'good',
        title: `${plugin.name} installed`,
        description: summarizePluginInstall(result),
      })
      onInstalled()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const skills = plugin?.components.skills ?? []
  const servers = plugin?.components.mcpServers ?? []
  // Every skill is listed when they start ticked: one ticked out of sight
  // would install without having been seen.
  const collapsible = skills.length > PRESELECT_SKILLS_UP_TO
  const shownSkills = allSkills || !collapsible ? skills : skills.slice(0, SKILLS_SHOWN)
  const chosen = selection ? selection.skillIds.size + selection.serverIds.size : 0
  const allSkillsTicked = selection !== null && skills.length > 0 && selection.skillIds.size === skills.length

  return (
    <Modal open onClose={onClose} labelledBy={titleId}>
      <ModalHeader
        title={`Install ${offered.name}?`}
        subtitle={`From ${source.name}`}
        titleId={titleId}
        onClose={onClose}
        leading={
          <ExtensionIcon
            name={offered.name}
            size={ICON_SIZE}
            {...extensionIconProps(pluginArtwork(offered, source, ICON_SIZE))}
          />
        }
      />
      <ModalBody className="flex flex-col gap-4">
        {offered.description ? (
          <p className="text-body leading-relaxed text-[color:var(--text-default)]">{offered.description}</p>
        ) : null}
        {readError ? (
          <InlineNotice tone="error" title={`${offered.name} could not be read.`} detail={readError} />
        ) : !plugin || !selection ? (
          <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
            <Spinner size={14} />
            Reading {offered.name}…
          </div>
        ) : (
          <>
            {servers.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-meta font-semibold text-[color:var(--text-muted)]">Connects to</h3>
                <DescribedCheckRowList ariaLabel="Servers">
                  {servers.map((server) => {
                    const shown = describeServer(server)
                    return (
                      <DescribedCheckRow
                        key={server.id}
                        id={`${rowId}-server-${server.id}`}
                        title={server.name || server.id}
                        code={shown.code}
                        description={shown.description}
                        checked={selection.serverIds.has(server.id)}
                        onChange={(on) =>
                          setSelection({ ...selection, serverIds: toggled(selection.serverIds, server.id, on) })
                        }
                        disabled={busy}
                      />
                    )
                  })}
                </DescribedCheckRowList>
              </section>
            ) : null}
            {skills.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-meta font-semibold text-[color:var(--text-muted)]">
                    {skills.length === 1 ? 'Skill' : `Skills · ${selection.skillIds.size} of ${skills.length}`}
                  </h3>
                  {skills.length > 1 ? (
                    <GhostButton
                      size="inline"
                      tone="accent"
                      disabled={busy}
                      onClick={() =>
                        setSelection({
                          ...selection,
                          skillIds: new Set(allSkillsTicked ? [] : skills.map((skill) => skill.id)),
                        })
                      }
                    >
                      {allSkillsTicked ? 'Select none' : 'Select all'}
                    </GhostButton>
                  ) : null}
                </div>
                <DescribedCheckRowList ariaLabel="Skills">
                  {shownSkills.map((skill) => (
                    <DescribedCheckRow
                      key={skill.id}
                      id={`${rowId}-skill-${skill.id}`}
                      title={skill.name}
                      description={skill.description}
                      checked={selection.skillIds.has(skill.id)}
                      onChange={(on) =>
                        setSelection({ ...selection, skillIds: toggled(selection.skillIds, skill.id, on) })
                      }
                      disabled={busy}
                    />
                  ))}
                </DescribedCheckRowList>
                {collapsible ? (
                  <GhostButton size="inline" tone="subtle" onClick={() => setAllSkills(!allSkills)}>
                    {allSkills ? 'Show fewer' : `Show all ${skills.length}`}
                  </GhostButton>
                ) : null}
              </section>
            ) : null}
            {servers.length === 0 && skills.length === 0 ? (
              <p className="text-body text-[color:var(--text-muted)]">
                {offered.name} has no skills or servers to install from here. Open it in Extensions to see what it
                holds.
              </p>
            ) : null}
          </>
        )}
        {error ? <InlineNotice tone="error" title="It was not installed." detail={error} /> : null}
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={onClose}>Cancel</ModalButton>
        <ModalButton variant="primary" disabled={!plugin || chosen === 0 || busy} onClick={() => void install()}>
          {busy ? 'Installing…' : 'Trust & install'}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}

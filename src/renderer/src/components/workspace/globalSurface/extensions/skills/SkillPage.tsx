// One skill, opened: what it is, what it may run, and what it would install.
//
// A skill is instructions an agent will follow and, often, scripts it will run,
// so everything the scan knows about it is disclosed before Install: the
// frontmatter description an agent matches on, the declared `allowed-tools`,
// whether it ships executables, and every file that would be written into the
// workspace — each of which opens in the reader, so nothing here is offered on
// trust alone.
//
// It opens as a dialog over the list, at the kit's workbench width. It used to
// be a 420px pane docked beside the rows, where the reader's document wrapped
// at thirty characters and the person read a skill through a letterbox
// (extensions review, 2026-09-08). Opening it stops the page: reading a skill
// is one thing done at a time, and Install is the one accent on screen.

import React, { useState, type JSX } from 'react'

import { skillDirName, skillNameWarning, type ScannedSkill, type SkillSource } from '../../../../../../../shared/skills'
import { INSTALL_SKILL_LABEL } from '../../../../../../../shared/skills'
import {
  Badge,
  DefinitionList,
  LinkButton,
  OutlineButton,
  PrimaryButton,
  StatusDot,
  type DefinitionItem,
} from '../../../../ui'
import { Modal, ModalFooter, ModalHeader } from '../../../../ui/Modal'
import { ExtensionIcon } from '../../../../ui/ExtensionIcon'
import { extensionIconProps, skillArtwork } from '../catalogue/pluginArtwork'
import { SkillReader } from './SkillReader'
import { UseSkillInAgentAction } from '../UseSkillInAgentAction'
import { sourceDisplayName, skillPluginFolder, type SkillInstallAvailability } from './skillsSurfaceModel'

const TITLE_ID = 'skill-detail-title'

/** The header's icon slot, in one place: the artwork ladder asks for its size. */
const HEADER_ICON_SIZE = 40

export function SkillPage({
  source,
  skill,
  installed,
  installing,
  availability,
  workspaceRoot = null,
  onInstall,
  onInstallInWorkspace,
  onInstallForUse,
  onRemove,
  onClose,
}: {
  source: SkillSource
  skill: ScannedSkill
  installed: boolean
  installing: boolean
  availability: SkillInstallAvailability
  /** The workspace the skill would be used in. Null when no folder is open. */
  workspaceRoot?: string | null
  /** Install for every agent in every chat and project — the default. */
  onInstall: () => void
  /** Install into the open folder only. Offered only when a folder is open. */
  onInstallInWorkspace?: () => void
  /**
   * Install and say whether it landed, for the one action that does both. The
   * page offers "Install and use" only when a host supplies this — a button
   * that promised an install it could not perform would be a lie.
   */
  onInstallForUse?: () => Promise<boolean>
  /** Take the installed copy back out of every agent CLI's skills directory. */
  onRemove?: () => void
  onClose: () => void
}): JSX.Element {
  const fileCount = skill.files.length
  const plugin = skillPluginFolder(skill.id)
  // Where it comes from, in one line: the source, the plugin inside it when
  // there is one, and how much it is. The rows said the same three things.
  const subtitle = [sourceDisplayName(source), plugin, `${fileCount} file${fileCount === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' · ')

  return (
    <Modal open onClose={onClose} labelledBy={TITLE_ID} size="workbench" layout="panel">
      <ModalHeader
        title={skill.name}
        subtitle={subtitle}
        titleId={TITLE_ID}
        onClose={onClose}
        leading={
          <ExtensionIcon
            name={skill.name}
            size={HEADER_ICON_SIZE}
            {...extensionIconProps(skillArtwork(skill, source, HEADER_ICON_SIZE))}
          />
        }
      />
      <div className="mt-4 min-h-0 flex-1 border-t border-[color:var(--border-subtle)]">
        <SkillReader
          key={`${source.id}::${skill.id}`}
          source={source}
          skill={skill}
          rail={<SkillFacts skill={skill} availability={availability} />}
        />
      </div>
      <div className="border-t border-[color:var(--border-subtle)]">
        <ModalFooter>
          <p className="mr-auto min-w-0 text-meta leading-5 text-[color:var(--text-subtle)]">
            Installing copies this skill&apos;s files into your home folder, where every agent CLI on this machine reads
            it — in every chat and project, with or without a folder.
          </p>
          {installed ? (
            <span className="text-meta font-medium text-[color:var(--accent-primary)]">Installed</span>
          ) : null}
          {installed && onRemove ? (
            <OutlineButton size="md" onClick={onRemove} disabled={installing}>
              {installing ? 'Removing…' : 'Remove'}
            </OutlineButton>
          ) : null}
          {/* Installing is no longer the end of the page. Once the skill is in
              the workspace the accent moves to what a person came here to do
              with it, and Install steps back to the outline it now is: a
              refresh of something they already have. */}
          {/* The narrower install, for a skill that belongs to one project. Quiet,
              because the default is what almost everyone wants. */}
          {!installed && onInstallInWorkspace ? (
            <LinkButton onClick={onInstallInWorkspace} disabled={!availability.enabled || installing}>
              This project only
            </LinkButton>
          ) : null}
          {installed ? (
            <OutlineButton size="md" onClick={onInstall} disabled={!availability.enabled || installing}>
              {installing ? 'Installing…' : 'Reinstall'}
            </OutlineButton>
          ) : (
            <PrimaryButton size="md" onClick={onInstall} disabled={!availability.enabled || installing}>
              {installing ? 'Installing…' : INSTALL_SKILL_LABEL}
            </PrimaryButton>
          )}
          {installed || onInstallForUse ? (
            <UseSkillInAgentAction
              skillId={skillDirName(skill.id)}
              skillName={skill.name}
              workspaceRoot={workspaceRoot}
              size="md"
              emphasis={installed ? 'primary' : 'outline'}
              disabled={installing || (!installed && !availability.enabled)}
              onInstallFirst={installed ? null : (onInstallForUse ?? null)}
            />
          ) : null}
        </ModalFooter>
      </div>
    </Modal>
  )
}

/**
 * What the skill says about itself, for the reader's rail: the description an
 * agent matches on, the optional Agent Skills fields it declares, and what it
 * may run. Shown only where declared — a "License —" row on every skill that
 * has no licence is noise (https://agentskills.io/specification, fetched
 * 2026-09-06).
 */
function SkillFacts({
  skill,
  availability,
}: {
  skill: ScannedSkill
  availability: SkillInstallAvailability
}): JSX.Element {
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const longDescription = skill.description.length > 200
  const declared: DefinitionItem[] = [
    ...(skill.license ? [{ term: 'License', description: skill.license }] : []),
    ...(skill.compatibility ? [{ term: 'Compatibility', description: skill.compatibility }] : []),
    ...Object.entries(skill.metadata ?? {}).map(([key, value]) => ({
      term: key,
      description: value,
    })),
  ]
  const nameWarning = skillNameWarning(skill.name, skillDirName(skill.id))

  return (
    <div className="flex flex-col gap-4 px-2">
      {skill.description ? (
        <div>
          <p
            className={`text-body leading-5 text-[color:var(--text-default)] ${
              longDescription && !descriptionOpen ? 'line-clamp-4' : ''
            }`}
          >
            {skill.description}
          </p>
          {longDescription ? (
            <div className="mt-1">
              <LinkButton ink="quiet" onClick={() => setDescriptionOpen((open) => !open)}>
                {descriptionOpen ? 'Less' : 'More'}
              </LinkButton>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-body text-[color:var(--text-subtle)]">
          This skill&apos;s entry document declares no description.
        </p>
      )}

      {/* A name the specification would reject is a fact about the skill, not
          a reason to withhold it — so it is stated here and Install stays live. */}
      {nameWarning ? (
        <p className="flex items-start gap-1.5 text-meta leading-5 text-[color:var(--text-subtle)]">
          <StatusDot tone="warn" className="mt-1" />
          {nameWarning}
        </p>
      ) : null}

      {availability.reason ? (
        <p className="text-meta leading-5 text-[color:var(--text-subtle)]">{availability.reason}</p>
      ) : null}

      {declared.length > 0 ? <DefinitionList items={declared} layout="stack" /> : null}

      <section>
        <h4 className="text-meta font-medium text-[color:var(--text-muted)]">What it may run</h4>
        {skill.allowedTools.length > 0 ? (
          <ul role="list" className="mt-1.5 flex flex-wrap gap-1">
            {skill.allowedTools.map((tool) => (
              <li key={tool}>
                <Badge tone="neutral" className="font-mono">
                  {tool}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-1.5 text-meta leading-5 text-[color:var(--text-subtle)]">
          {skill.allowedTools.length > 0
            ? "Declared by the skill's own allowed-tools. "
            : 'This skill declares no allowed-tools. '}
          {skill.hasExecutables
            ? 'It ships executable files, which an agent may run once installed.'
            : 'It ships no executable files.'}
        </p>
      </section>
    </div>
  )
}

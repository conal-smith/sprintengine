// The built-in plugin's area skills, and the one decision a person makes about
// each: whether agents get it.
//
// Renderer-safe (no node imports): main installs from this list, the Settings
// section lists it, and each surface's suggestion reads its own entry from it.
//
// Opt-in, machine-wide (owner ruling 2026-09-28). They used to be installed
// with the bridge and the agent-state hook into every workspace the app opened,
// and an agent building an ordinary UI picked up `studio-design-system` and
// followed it. A skill is a standing instruction to every agent that can see it,
// so it has to be one the person chose: each surface offers its own the first
// time it is opened, and a yes installs it into every workspace, now and later.
// The bridge and the hook stay built in — agents need them to reach the app at
// all, and neither tells an agent what to do.
//
// One skill is on until the person turns it off: `studio-ship` (2026-10-11).
// It steers nothing in ordinary work; it is read only when the person says
// "ship it", and then it is the difference between an agent that pushes and
// sleeps in a loop and one that has Studio watch the pull request and wake it.
// Every chat can watch a pull request (the gateway's `pull_request.watch`),
// so every chat gets the steps by default. Off is still a switch in Settings,
// and turning it off is remembered like any other answer.

export type StudioAreaSkillId =
  | 'studio-backlog'
  | 'studio-design-system'
  | 'studio-canvas'
  | 'studio-scheduled-agents'
  | 'studio-diff-tours'
  | 'studio-workspaces'
  | 'studio-ship'

/**
 * Where the skill is offered. `settings` is the one with no surface of its own:
 * the workspaces skill is about the app as a whole, so it is only a switch.
 */
type StudioAreaSkillSurface = 'backlog' | 'design' | 'canvas' | 'scheduled-agents' | 'diff' | 'settings'

export type StudioAreaSkill = {
  id: StudioAreaSkillId
  /** The surface's own name, as the rail and the Settings row say it. */
  name: string
  /** What an agent gets, in a sentence — the suggestion's and the Settings row's help. */
  gives: string
  surface: StudioAreaSkillSurface
  /** On for a person who never answered, until they turn it off (see the header). */
  onByDefault?: true
}

/** In the order Settings lists them: the surfaces first, then the app-wide one. */
export const STUDIO_AREA_SKILLS: readonly StudioAreaSkill[] = [
  {
    id: 'studio-backlog',
    name: 'Backlog',
    gives: 'Teaches agents to read, triage and update backlog items and epics.',
    surface: 'backlog',
  },
  {
    id: 'studio-design-system',
    name: 'Design system',
    gives: "Teaches agents to follow and maintain a project's design system when they change UI.",
    surface: 'design',
  },
  {
    id: 'studio-canvas',
    name: 'Canvas',
    gives: 'Teaches agents to draw, read and revise diagrams on Canvas boards.',
    surface: 'canvas',
  },
  {
    id: 'studio-scheduled-agents',
    name: 'Scheduled agents',
    gives: 'Teaches agents to schedule an agent with a prompt, and to list, run and remove scheduled agents.',
    surface: 'scheduled-agents',
  },
  {
    id: 'studio-diff-tours',
    name: 'Diff tours',
    gives: 'Teaches agents to walk you through their changes as a tour in the Diff viewer.',
    surface: 'diff',
  },
  {
    id: 'studio-workspaces',
    name: 'Workspaces',
    gives: 'Teaches agents to drive workspaces, terminals, the editor and the in-app browser.',
    surface: 'settings',
  },
  {
    id: 'studio-ship',
    name: 'Ship it',
    gives:
      'When you say “ship it”, agents push, open the pull request, set it to merge, and have Studio watch it until it lands.',
    surface: 'settings',
    onByDefault: true,
  },
]

const IDS = new Set<string>(STUDIO_AREA_SKILLS.map((skill) => skill.id))

export function isStudioAreaSkillId(value: unknown): value is StudioAreaSkillId {
  return typeof value === 'string' && IDS.has(value)
}

export function studioAreaSkill(id: StudioAreaSkillId): StudioAreaSkill {
  // The list is closed over the union, so this always finds one.
  return STUDIO_AREA_SKILLS.find((skill) => skill.id === id) as StudioAreaSkill
}

/** What the person has decided, per skill. Absent from both lists: never asked. */
export type StudioAreaSkillChoices = {
  enabled: StudioAreaSkillId[]
  /** Suggestions the person turned down; a dismissed skill is still a switch in Settings. */
  dismissed: StudioAreaSkillId[]
}

/**
 * Read a choices record from anywhere it may have come from — a file on disk,
 * an IPC reply — keeping only known ids, once each, in list order. Anything
 * else reads as "never asked", which installs only the skills that are on by
 * default; one of those the person turned off is in `dismissed`, and stays off.
 */
export function normaliseStudioAreaSkillChoices(value: unknown): StudioAreaSkillChoices {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const pick = (list: unknown, defaults: StudioAreaSkillId[] = []): StudioAreaSkillId[] => {
    const wanted = new Set([...(Array.isArray(list) ? list.filter(isStudioAreaSkillId) : []), ...defaults])
    return STUDIO_AREA_SKILLS.map((skill) => skill.id).filter((id) => wanted.has(id))
  }
  const dismissed = pick(record.dismissed)
  const onByDefault = STUDIO_AREA_SKILLS.filter((skill) => skill.onByDefault && !dismissed.includes(skill.id)).map(
    (skill) => skill.id,
  )
  return { enabled: pick(record.enabled, onByDefault), dismissed }
}

/** Whether a surface should offer its skill: not installed, and not turned down. */
export function shouldSuggestStudioAreaSkill(choices: StudioAreaSkillChoices, id: StudioAreaSkillId): boolean {
  return !choices.enabled.includes(id) && !choices.dismissed.includes(id)
}

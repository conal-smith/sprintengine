import { stablePick } from "./pick";

// Which characters are about depends on the time of year. The robot is in every
// pool, so an agent is never a stranger, and every pool holds at least three so
// agents running side by side usually differ.
//
// The ids live here rather than beside the drawings so the pick can be tested
// on bare Node without loading react-native-svg.
export const AGENT_CHARACTER_IDS = [
  "robot",
  "blob",
  "octopus",
  "owl",
  "ghost",
  "pumpkin",
  "cat",
  "elf",
  "santa",
] as const;

export type AgentCharacterId = (typeof AGENT_CHARACTER_IDS)[number];

export type AgentSeason = "everyday" | "halloween" | "christmas";

export const AGENT_SEASON_POOLS: Record<AgentSeason, readonly AgentCharacterId[]> = {
  everyday: ["robot", "blob", "octopus", "owl"],
  halloween: ["robot", "pumpkin", "ghost", "cat"],
  christmas: ["robot", "elf", "santa"],
};

/** The season a local date falls in: October is Halloween, 1–26 December Christmas. */
export function seasonFor(date: Date): AgentSeason {
  const month = date.getMonth() + 1;
  if (month === 10) return "halloween";
  if (month === 12 && date.getDate() <= 26) return "christmas";
  return "everyday";
}

/** The character an agent appears as: stable for the agent within a season. */
export function pickAgentCharacter(agentId: string, date: Date = new Date()): AgentCharacterId {
  return stablePick(agentId, AGENT_SEASON_POOLS[seasonFor(date)]);
}

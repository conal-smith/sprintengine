/**
 * One item of `items`, chosen by `seed` and the same every time for that seed:
 * an agent keeps its character and a chat keeps its working mark across
 * renders, reloads and machines, while different seeds spread across the list.
 *
 * The desktop's pick, byte for byte (agentGlyph/pick.ts there), so the phone
 * draws the same creature and the same mark the desktop does for the same id.
 */
export function stablePick<T>(seed: string, items: readonly T[]): T {
  // FNV-1a: cheap, and spreads short ids that differ in one character.
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return items[(hash >>> 0) % items.length]!;
}

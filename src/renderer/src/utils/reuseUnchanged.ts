/**
 * `next`, with every part that reads the same as `previous` given back as
 * `previous`'s own object, and `previous` itself when nothing differs at all.
 *
 * For a store field main hands back whole on every read: a background
 * re-read that found nothing new would otherwise replace every entry with an
 * equal copy, and each component that reads one re-renders for nothing. Plain
 * JSON-shaped data only (objects, arrays, primitives); anything else is
 * compared by identity.
 */
export function reuseUnchanged<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length
    const merged = next.map((entry, index) => {
      const reused = index < previous.length ? reuseUnchanged(previous[index], entry) : entry
      if (reused !== previous[index]) same = false
      return reused
    })
    return (same ? previous : merged) as T
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousKeys = Object.keys(previous)
    const nextKeys = Object.keys(next)
    let same = previousKeys.length === nextKeys.length
    const merged: Record<string, unknown> = {}
    for (const key of nextKeys) {
      const reused = Object.hasOwn(previous, key) ? reuseUnchanged(previous[key], next[key]) : next[key]
      if (!Object.hasOwn(previous, key) || reused !== previous[key]) same = false
      merged[key] = reused
    }
    return (same ? previous : merged) as T
  }
  return next
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A list built afresh from the wire, keeping each item that reads as it did
 * as the object the screen already holds, and within a changed item each
 * part that did not change (a lane's earlier steps, a fold's settled tools).
 * Projections and list reads build everything new, so a memoised row saw new
 * props and drew again for every change anywhere in its list; what is kept
 * as it was is skipped. When nothing moved, the previous list itself comes
 * back. Items are matched by id, their parts by key and position.
 */
export function keepUnchanged<T>(previous: readonly T[], next: T[], idOf: (item: T) => string): T[] {
  if (!previous.length) return next;
  const byId = new Map(previous.map((item) => [idOf(item), item]));
  let unchanged = previous.length === next.length;
  const kept = next.map((item, index) => {
    const old = byId.get(idOf(item));
    const shown = old === undefined ? item : share(old, item);
    if (shown !== previous[index]) unchanged = false;
    return shown;
  });
  return unchanged ? (previous as T[]) : kept;
}

/** `next`, with every part that reads as the same place in `previous` did kept as the object it was. */
export function share<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (typeof previous !== "object" || typeof next !== "object" || previous === null || next === null) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    // Built only from the first part that differs: an unchanged list costs
    // the comparison and nothing else.
    let items: unknown[] | null = previous.length === next.length ? null : [];
    for (let index = 0; index < next.length; index++) {
      const kept = share(previous[index], next[index]);
      if (!items && kept !== previous[index]) items = previous.slice(0, index);
      items?.push(kept);
    }
    return (items ?? previous) as T;
  }
  // Plain data only: a map, a date or a class instance is taken as it comes.
  if (!isPlainObject(previous) || !isPlainObject(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let parts: Record<string, unknown> | null = keys.length === Object.keys(before).length ? null : {};
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const kept = share(before[key], after[key]);
    if (!parts && (kept !== before[key] || !Object.prototype.hasOwnProperty.call(before, key))) {
      parts = {};
      for (const earlier of keys.slice(0, index)) parts[earlier] = before[earlier];
    }
    if (parts) parts[key] = kept;
  }
  return (parts ?? previous) as T;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

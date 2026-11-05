// Told when a runtime's API key is saved or removed in Settings, so a launch
// surface that stayed mounted behind Settings reads the keys again.
const listeners = new Set<() => void>()

export function noteCliKeyChanged(): void {
  for (const listener of listeners) listener()
}

export function subscribeCliKeyChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

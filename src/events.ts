// Tiny pub/sub: the writer announces "events up to id N exist"; each SSE
// client then reads the new rows itself from the read-only handle.
type Listener = (id: number) => void;
const listeners = new Set<Listener>();

export function onNewEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function announce(id: number): void {
  for (const fn of listeners) fn(id);
}

export function listenerCount(): number {
  return listeners.size;
}

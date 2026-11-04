// In-memory sliding window. Resets on restart, which is fine: it only has to
// stop a runaway agent filling the volume (ADR-0008).
const hits = new Map<string, { windowMs: number; times: number[] }>();

export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const entry = hits.get(key) ?? { windowMs, times: [] };
  entry.windowMs = windowMs;
  entry.times = entry.times.filter((t) => now - t < windowMs);
  hits.set(key, entry);
  if (entry.times.length >= limit) return false;
  entry.times.push(now);
  return true;
}

/** Drop keys whose every hit is outside their own window, so the map cannot grow without bound (ADR-0099). */
export function sweep(now = Date.now()): number {
  let dropped = 0;
  for (const [key, { windowMs, times }] of hits) {
    if (times.every((t) => now - t >= windowMs)) {
      hits.delete(key);
      dropped++;
    }
  }
  return dropped;
}

/** How many keys are held: for the spec and the health line. */
export const trackedKeys = (): number => hits.size;

setInterval(() => sweep(), 60_000).unref();

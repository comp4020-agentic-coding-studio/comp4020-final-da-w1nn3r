// In-memory sliding window. Resets on restart, which is fine: it only has to
// stop a runaway agent filling the volume (ADR-0008).
const hits = new Map<string, number[]>();

export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

// Keep the map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) {
    if (times.every((t) => now - t > 3_600_000)) hits.delete(key);
  }
}, 600_000).unref();

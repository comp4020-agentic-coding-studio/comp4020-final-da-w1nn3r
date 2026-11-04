// Pure rules for keeping the service inside its budgets: the agent cap (ADR-0097) and the database size (ADR-0098).
// No database is opened here, so a spec can run them against a scratch connection.
import type { DatabaseSync } from "node:sqlite";

export const DAY_MS = 86_400_000;

/** True when the database has reached its budget (DB_MAX_MB, default 800 of the 1 GB volume). */
export const overBudget = (bytes: number, limit: number): boolean => bytes >= limit;

/** Keep only the newest `max` rows of an append-only table with an integer `id` (ADR-0098). Returns rows deleted. */
export function capRows(conn: DatabaseSync, table: "app_log", max: number): number {
  const cut = conn.prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?`).get(max) as { id: number } | undefined;
  return cut ? Number(conn.prepare(`DELETE FROM ${table} WHERE id <= ?`).run(cut.id).changes) : 0;
}

/**
 * The account an idle reclaim would free (ADR-0097): registered and last seen more than `days` ago, and it never
 * swiped, sent a message, blocked anyone or edited its profile. Nobody can have matched it (a match needs its own
 * like). The longest unseen goes first.
 */
export function idleAccount(conn: DatabaseSync, now: number, days: number): { id: number; handle: string } | undefined {
  const cutoff = now - days * DAY_MS;
  const row = conn.prepare(
    `SELECT a.id, a.handle FROM agents a JOIN profiles p ON p.agent_id = a.id
     WHERE a.created_at < ? AND COALESCE(a.last_seen_at, a.created_at) < ? AND p.updated_at <= a.created_at
       AND NOT EXISTS (SELECT 1 FROM swipes WHERE swiper_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM messages WHERE sender_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = a.id)
     ORDER BY COALESCE(a.last_seen_at, a.created_at) ASC, a.id ASC LIMIT 1`,
  ).get(cutoff, cutoff) as { id: number; handle: string } | undefined;
  return row ? { id: Number(row.id), handle: String(row.handle) } : undefined;
}

/**
 * A cache for a value that is costly to build and fine to be a little stale (ADR-0099). It is rebuilt when it is
 * `ttlMs` old, or sooner (but never more often than every `minMs`) once `version()` changes, so a page reflects new
 * activity within seconds while a flood of requests still costs at most one build per `minMs`.
 */
export function cached<T>(
  ttlMs: number,
  build: () => T,
  opts: { minMs?: number; version?: () => number; clock?: () => number } = {},
): () => T {
  const { minMs = ttlMs, version = () => 0, clock = Date.now } = opts;
  let memo: { at: number; version: number; value: T } | undefined;
  return () => {
    const now = clock();
    const age = memo ? now - memo.at : Infinity;
    if (!memo || age >= ttlMs || (age >= minMs && version() !== memo.version)) {
      const v = version();
      memo = { at: now, version: v, value: build() };
    }
    return memo.value;
  };
}

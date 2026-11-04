import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config, ensureDataDir } from "./config.ts";
import { overBudget } from "./limits.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS profiles (
  agent_id INTEGER PRIMARY KEY REFERENCES agents(id),
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL,
  interests TEXT NOT NULL,
  looking_for TEXT NOT NULL,
  emoji TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'unknown',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS swipes (
  swiper_id INTEGER NOT NULL REFERENCES agents(id),
  target_id INTEGER NOT NULL REFERENCES agents(id),
  direction TEXT NOT NULL CHECK (direction IN ('like','pass')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (swiper_id, target_id)
);
CREATE INDEX IF NOT EXISTS swipes_target ON swipes(target_id, direction);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_a INTEGER NOT NULL REFERENCES agents(id),
  agent_b INTEGER NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  UNIQUE (agent_a, agent_b),
  CHECK (agent_a < agent_b)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  sender_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_match ON messages(match_id, id);
CREATE TABLE IF NOT EXISTS read_state (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  last_read_id INTEGER NOT NULL,
  PRIMARY KEY (match_id, agent_id)
);
-- Each agent's private opinion of a match, 0-100 (ADR-0080). Never shown to the other agent or to spectators.
CREATE TABLE IF NOT EXISTS opinions (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  value INTEGER NOT NULL,
  PRIMARY KEY (match_id, agent_id)
);
-- The public activity log: what spectators see (ADR-0008). Passes are not here.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
-- What the admin UI did (ADR-0018). Never holds tokens.
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
-- Every line src/log.ts writes, kept so admin can download it by week (ADR-0034). Same redaction as stdout.
CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_log_ts ON app_log(ts);
-- Who blocked whom (ADR-0096). Private: never in the events feed, never on a spectator page.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES agents(id),
  blocked_id INTEGER NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks(blocked_id);
-- Reports an agent filed with a block, queued for the admin (ADR-0096). The reason is agent text: escaped on output.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES agents(id),
  reported_id INTEGER NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS reports_open ON reports(resolved_at, id);
-- Admin sessions ended by logout, until they would have expired anyway (ADR-0046). Holds a hash of the
-- cookie's signature, never the cookie.
CREATE TABLE IF NOT EXISTS admin_revoked (
  sig_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

ensureDataDir();

/** The only handle that can write. Used by the MCP side only. */
export const db = new DatabaseSync(config.dbPath);
try {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
} catch (err) {
  // WAL needs shared-memory locks that Windows drives under WSL (/mnt/c, often OneDrive) don't provide. Say what to
  // do instead of leaving a bare "disk I/O error" (ADR-0049). Still fatal: WAL stays on everywhere.
  if (/disk I\/O error/i.test(String(err))) {
    console.error(`\nCannot open ${config.dbPath} in WAL mode (disk I/O error). This usually means the database is on a Windows ` +
      `drive mounted into WSL (/mnt/c, OneDrive). Put it on the Linux filesystem instead, for example:\n` +
      `  mkdir -p ~/ribbon-data && cp .data/app.db* ~/ribbon-data/ 2>/dev/null; DB_PATH=~/ribbon-data/app.db PORT=8081 node src/server.ts\n`);
  }
  throw err;
}
db.exec(SCHEMA);
// Databases created before ADR-0016 have no model column.
if (!(db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).some((c) => c.name === "model")) {
  db.exec("ALTER TABLE profiles ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'");
}

// Databases created before ADR-0065 have no avatar colour.
if (!(db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).some((c) => c.name === "color")) {
  db.exec("ALTER TABLE profiles ADD COLUMN color TEXT");
}

// Databases created before ADR-0027 have no way to end a match.
const matchCols = (db.prepare("PRAGMA table_info(matches)").all() as { name: string }[]).map((c) => c.name);
if (!matchCols.includes("ended_at")) {
  db.exec("ALTER TABLE matches ADD COLUMN ended_at INTEGER; ALTER TABLE matches ADD COLUMN ended_by INTEGER; ALTER TABLE matches ADD COLUMN end_reason TEXT");
}

// Databases created before ADR-0078 have no ending outcome and no commitment.
if (!matchCols.includes("end_outcome")) {
  db.exec("ALTER TABLE matches ADD COLUMN end_outcome TEXT; ALTER TABLE matches ADD COLUMN commit_by INTEGER; ALTER TABLE matches ADD COLUMN commit_note TEXT; ALTER TABLE matches ADD COLUMN committed_at INTEGER");
}

/** Read-only handle for everything spectators can reach (CLAUDE.md hard rule). */
export const readDb = new DatabaseSync(config.dbPath, { readOnly: true });
readDb.exec("PRAGMA busy_timeout = 5000;");

// --- the database's budget on the volume (ADR-0098) ---
const SIZE_MEMO_MS = 5_000;
let sizeMemo = { at: 0, bytes: 0 };
/** Bytes the database uses: pages in use (free pages are reused, so pruning makes room) plus the WAL. Re-read every 5 s. */
export function dbBytes(now = Date.now()): number {
  if (now - sizeMemo.at < SIZE_MEMO_MS) return sizeMemo.bytes;
  const r = db.prepare("SELECT (p.page_count - f.freelist_count) * s.page_size AS n FROM pragma_page_count() p, pragma_freelist_count() f, pragma_page_size() s").get() as { n: number };
  let wal = 0;
  try { wal = statSync(`${config.dbPath}-wal`).size; } catch {}
  sizeMemo = { at: now, bytes: Number(r.n) + wal };
  return sizeMemo.bytes;
}
/** True when the database has reached its budget, DB_MAX_MB (ADR-0098). */
export const dbFull = (): boolean => overBudget(dbBytes(), config.dbMaxBytes);

/**
 * Remove an agent and everything that points at it: messages and matches it was in, swipes either way, blocks and
 * reports either way, and its feed events. Runs inside the caller's transaction. Used by admin delete (ADR-0018)
 * and by idle-account reclaim (ADR-0097).
 */
export function purgeAgent(id: number, handle: string): void {
  const matches = "SELECT id FROM matches WHERE agent_a = ? OR agent_b = ?";
  db.prepare(`DELETE FROM messages WHERE sender_id = ? OR match_id IN (${matches})`).run(id, id, id);
  db.prepare(`DELETE FROM read_state WHERE agent_id = ? OR match_id IN (${matches})`).run(id, id, id);
  db.prepare(`DELETE FROM opinions WHERE agent_id = ? OR match_id IN (${matches})`).run(id, id, id);
  db.prepare("DELETE FROM matches WHERE agent_a = ? OR agent_b = ?").run(id, id);
  db.prepare("DELETE FROM swipes WHERE swiper_id = ? OR target_id = ?").run(id, id);
  db.prepare("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?").run(id, id);
  db.prepare("DELETE FROM reports WHERE reporter_id = ? OR reported_id = ?").run(id, id);
  db.prepare("DELETE FROM profiles WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  db.prepare("DELETE FROM events WHERE json_extract(payload, '$.actor') = ? OR json_extract(payload, '$.target') = ?").run(handle, handle);
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

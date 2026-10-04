import { DatabaseSync } from "node:sqlite";
import { config, ensureDataDir } from "./config.ts";

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
`;

ensureDataDir();

/** The only handle that can write. Used by the MCP side only. */
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec(SCHEMA);
// Databases created before ADR-0016 have no model column.
if (!(db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).some((c) => c.name === "model")) {
  db.exec("ALTER TABLE profiles ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'");
}

/** Read-only handle for everything spectators can reach (CLAUDE.md hard rule). */
export const readDb = new DatabaseSync(config.dbPath, { readOnly: true });
readDb.exec("PRAGMA busy_timeout = 5000;");

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

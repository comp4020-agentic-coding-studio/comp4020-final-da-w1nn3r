// Read-only queries for the spectator site. Only ever uses `readDb`: this file
// cannot write, by construction (CLAUDE.md hard rule).
import { readDb } from "./db.ts";

type Row = Record<string, unknown>;
const all = (sql: string, ...args: (string | number)[]): Row[] => readDb.prepare(sql).all(...args) as Row[];
const one = (sql: string, ...args: (string | number)[]): Row | undefined => readDb.prepare(sql).get(...args) as Row | undefined;

/** An agent is "online" if it made an authenticated call within this window. */
export const ONLINE_WINDOW_MS = 15 * 60_000;
export const isOnline = (lastSeen: unknown): boolean => lastSeen != null && Date.now() - Number(lastSeen) < ONLINE_WINDOW_MS;

export interface FeedEvent {
  id: number;
  type: string;
  at: number;
  actor: string;
  target?: string;
  matchId?: number;
}

const toEvent = (r: Row): FeedEvent => {
  const p = JSON.parse(String(r.payload)) as Record<string, unknown>;
  return {
    id: Number(r.id),
    type: String(r.type),
    at: Number(r.created_at),
    actor: String(p.actor),
    target: p.target === undefined ? undefined : String(p.target),
    matchId: p.match_id === undefined ? undefined : Number(p.match_id),
  };
};

export const recentEvents = (limit: number): FeedEvent[] =>
  all("SELECT * FROM events ORDER BY id DESC LIMIT ?", limit).map(toEvent);

export const eventsAfter = (id: number, limit = 100): FeedEvent[] =>
  all("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?", id, limit).map(toEvent);

export const latestEventId = (): number => Number(one("SELECT COALESCE(MAX(id), 0) AS n FROM events")?.n);

export function stats(): { agents: number; online: number; matches: number; messages: number; likes: number; passes: number } {
  const n = (sql: string): number => Number(one(sql)?.n);
  return {
    agents: n("SELECT COUNT(*) AS n FROM agents"),
    online: Number(one("SELECT COUNT(*) AS n FROM agents WHERE last_seen_at > ?", Date.now() - ONLINE_WINDOW_MS)?.n),
    matches: n("SELECT COUNT(*) AS n FROM matches"),
    messages: n("SELECT COUNT(*) AS n FROM messages"),
    likes: n("SELECT COUNT(*) AS n FROM swipes WHERE direction = 'like'"),
    passes: n("SELECT COUNT(*) AS n FROM swipes WHERE direction = 'pass'"),
  };
}

export const listAgents = (): Row[] =>
  all(
    `SELECT a.handle, p.display_name, p.emoji, p.model, p.bio, p.interests, a.created_at, a.last_seen_at
     FROM agents a JOIN profiles p ON p.agent_id = a.id
     ORDER BY a.last_seen_at IS NULL, a.last_seen_at DESC, a.id DESC LIMIT 200`,
  );

export function agentDetail(handle: string): { profile: Row; matches: Row[]; likesGiven: number; likesReceived: number; passesGiven: number } | null {
  const profile = one(
    `SELECT a.id, a.handle, p.display_name, p.emoji, p.model, p.bio, p.interests, p.looking_for, a.created_at, a.last_seen_at
     FROM agents a JOIN profiles p ON p.agent_id = a.id WHERE a.handle = ?`,
    handle,
  );
  if (!profile) return null;
  const id = Number(profile.id);
  const n = (sql: string): number => Number(one(sql, id)?.n);
  return {
    profile,
    matches: all(
      `SELECT x.id, x.created_at, o.handle AS partner, o.id AS partner_id FROM matches x
       JOIN agents o ON o.id = CASE WHEN x.agent_a = ? THEN x.agent_b ELSE x.agent_a END
       WHERE ? IN (x.agent_a, x.agent_b) ORDER BY x.id DESC`,
      id, id,
    ),
    likesGiven: n("SELECT COUNT(*) AS n FROM swipes WHERE swiper_id = ? AND direction = 'like'"),
    likesReceived: n("SELECT COUNT(*) AS n FROM swipes WHERE target_id = ? AND direction = 'like'"),
    passesGiven: n("SELECT COUNT(*) AS n FROM swipes WHERE swiper_id = ? AND direction = 'pass'"),
  };
}

export const listMatches = (): Row[] =>
  all(
    `SELECT x.id, x.created_at, a.handle AS a_handle, b.handle AS b_handle,
       (SELECT COUNT(*) FROM messages WHERE match_id = x.id) AS message_count,
       (SELECT body FROM messages WHERE match_id = x.id ORDER BY id DESC LIMIT 1) AS last_body
     FROM matches x JOIN agents a ON a.id = x.agent_a JOIN agents b ON b.id = x.agent_b
     ORDER BY x.id DESC LIMIT 100`,
  );

export function matchDetail(id: number): { match: Row; messages: Row[] } | null {
  const match = one(
    `SELECT x.id, x.created_at, a.handle AS a_handle, b.handle AS b_handle
     FROM matches x JOIN agents a ON a.id = x.agent_a JOIN agents b ON b.id = x.agent_b WHERE x.id = ?`,
    id,
  );
  if (!match) return null;
  const messages = all(
    `SELECT m.id, m.body, m.created_at, s.handle AS sender FROM messages m
     JOIN agents s ON s.id = m.sender_id WHERE m.match_id = ? ORDER BY m.id ASC LIMIT 500`,
    id,
  );
  return { match, messages };
}

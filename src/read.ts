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

export function stats(): { agents: number; online: number; lastSeen: number | null; matches: number; messages: number; likes: number; passes: number } {
  const n = (sql: string): number => Number(one(sql)?.n);
  const last = one("SELECT MAX(last_seen_at) AS n FROM agents")?.n;
  return {
    agents: n("SELECT COUNT(*) AS n FROM agents"),
    online: Number(one("SELECT COUNT(*) AS n FROM agents WHERE last_seen_at > ?", Date.now() - ONLINE_WINDOW_MS)?.n),
    lastSeen: last == null ? null : Number(last),
    matches: n("SELECT COUNT(*) AS n FROM matches"),
    messages: n("SELECT COUNT(*) AS n FROM messages"),
    likes: n("SELECT COUNT(*) AS n FROM swipes WHERE direction = 'like'"),
    passes: n("SELECT COUNT(*) AS n FROM swipes WHERE direction = 'pass'"),
  };
}

// The agent directory's filters (ADR-0048). Every value is whitelisted here, so nothing a visitor types
// reaches SQL except the name search, which is a bound LIKE parameter.
export const SEEN = ["any", "online", "day", "week", "older"] as const;
export const ACTIVITY = ["any", "active", "none"] as const;
export const SORTS = ["recent", "actions", "name", "newest"] as const;
export interface AgentFilter { q: string; seen: (typeof SEEN)[number]; activity: (typeof ACTIVITY)[number]; sort: (typeof SORTS)[number]; model: string }

/** Every model name agents have registered with, most common first (ADR-0052). Filters only accept these. */
export const listModels = (): { model: string; n: number }[] =>
  all("SELECT model, COUNT(*) AS n FROM profiles GROUP BY model ORDER BY n DESC, model COLLATE NOCASE").map((r) => ({ model: String(r.model), n: Number(r.n) }));
/** A model filter value: one of the registered models, or "" for any. */
const pickModel = (value: string | null): string => (value && listModels().some((m) => m.model === value) ? value : "");

const pick = <T extends string>(options: readonly T[], value: string | null): T => (options.includes(value as T) ? (value as T) : options[0]);
export const parseAgentFilter = (p: URLSearchParams): AgentFilter => ({
  q: (p.get("q") ?? "").trim().slice(0, 60),
  seen: pick(SEEN, p.get("seen")),
  activity: pick(ACTIVITY, p.get("activity")),
  sort: pick(SORTS, p.get("sort")),
  model: pickModel(p.get("model")),
});

const DAY_MS = 86_400_000;
// An action is a swipe (like or pass) or a message the agent sent.
const ACTIONS = "(COALESCE(s.n, 0) + COALESCE(m.n, 0))";
const ORDER: Record<AgentFilter["sort"], string> = {
  recent: "a.last_seen_at IS NULL, a.last_seen_at DESC, a.id DESC",
  actions: `${ACTIONS} DESC, a.last_seen_at DESC, a.id DESC`,
  name: "p.display_name COLLATE NOCASE, a.handle",
  newest: "a.created_at DESC, a.id DESC",
};

/** Up to 200 agents matching `f`, and how many match in all. */
export function listAgents(f: AgentFilter = parseAgentFilter(new URLSearchParams())): { rows: Row[]; total: number } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(a.handle LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const now = Date.now();
  if (f.seen === "online") { where.push("a.last_seen_at > ?"); args.push(now - ONLINE_WINDOW_MS); }
  if (f.seen === "day") { where.push("a.last_seen_at > ?"); args.push(now - DAY_MS); }
  if (f.seen === "week") { where.push("a.last_seen_at > ?"); args.push(now - 7 * DAY_MS); }
  if (f.seen === "older") { where.push("(a.last_seen_at IS NULL OR a.last_seen_at <= ?)"); args.push(now - 7 * DAY_MS); }
  if (f.activity === "active") where.push(`${ACTIONS} > 0`);
  if (f.activity === "none") where.push(`${ACTIONS} = 0`);
  if (f.model) { where.push("p.model = ?"); args.push(f.model); }
  const from = `FROM agents a JOIN profiles p ON p.agent_id = a.id
     LEFT JOIN (SELECT swiper_id AS id, COUNT(*) AS n FROM swipes GROUP BY swiper_id) s ON s.id = a.id
     LEFT JOIN (SELECT sender_id AS id, COUNT(*) AS n FROM messages GROUP BY sender_id) m ON m.id = a.id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return {
    rows: all(
      `SELECT a.handle, p.display_name, p.emoji, p.color, p.model, p.bio, p.interests, a.created_at, a.last_seen_at, ${ACTIONS} AS actions
       ${from} ORDER BY ${ORDER[f.sort]} LIMIT 200`,
      ...args,
    ),
    total: Number(one(`SELECT COUNT(*) AS n ${from}`, ...args)?.n),
  };
}

export function agentDetail(handle: string): { profile: Row; matches: Row[]; likesGiven: number; likesReceived: number; passesGiven: number } | null {
  const profile = one(
    `SELECT a.id, a.handle, p.display_name, p.emoji, p.color, p.model, p.bio, p.interests, p.looking_for, a.created_at, a.last_seen_at
     FROM agents a JOIN profiles p ON p.agent_id = a.id WHERE a.handle = ?`,
    handle,
  );
  if (!profile) return null;
  const id = Number(profile.id);
  const n = (sql: string): number => Number(one(sql, id)?.n);
  return {
    profile,
    matches: all(
      `SELECT x.id, x.created_at, x.ended_at, o.handle AS partner, o.id AS partner_id FROM matches x
       JOIN agents o ON o.id = CASE WHEN x.agent_a = ? THEN x.agent_b ELSE x.agent_a END
       WHERE ? IN (x.agent_a, x.agent_b) ORDER BY x.id DESC`,
      id, id,
    ),
    likesGiven: n("SELECT COUNT(*) AS n FROM swipes WHERE swiper_id = ? AND direction = 'like'"),
    likesReceived: n("SELECT COUNT(*) AS n FROM swipes WHERE target_id = ? AND direction = 'like'"),
    passesGiven: n("SELECT COUNT(*) AS n FROM swipes WHERE swiper_id = ? AND direction = 'pass'"),
  };
}

// The match list's filters (ADR-0052), whitelisted like the agent filters: model names must be registered ones.
export const MATCH_STATUS = ["any", "open", "ended"] as const;
export const MATCH_SORTS = ["recent", "active", "messages", "oldest"] as const;
export interface MatchFilter { model: string; with: string; status: (typeof MATCH_STATUS)[number]; sort: (typeof MATCH_SORTS)[number] }
export const parseMatchFilter = (p: URLSearchParams): MatchFilter => ({
  model: pickModel(p.get("model")),
  with: pickModel(p.get("with")),
  status: pick(MATCH_STATUS, p.get("status")),
  sort: pick(MATCH_SORTS, p.get("sort")),
});
const MATCH_ORDER: Record<MatchFilter["sort"], string> = {
  recent: "x.id DESC",
  active: "COALESCE(c.last_at, x.created_at) DESC, x.id DESC",
  messages: "COALESCE(c.n, 0) DESC, x.id DESC",
  oldest: "x.id ASC",
};

/** Up to 100 matches matching `f`, with both agents' models, and how many match in all. */
export function listMatches(f: MatchFilter = parseMatchFilter(new URLSearchParams())): { rows: Row[]; total: number } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  // One model: either side has it. Two: one side has each, so "gemma with qwen" finds every Gemma-Qwen pair.
  if (f.model && f.with) { where.push("((pa.model = ? AND pb.model = ?) OR (pa.model = ? AND pb.model = ?))"); args.push(f.model, f.with, f.with, f.model); }
  else if (f.model || f.with) { where.push("(pa.model = ? OR pb.model = ?)"); args.push(f.model || f.with, f.model || f.with); }
  if (f.status === "open") where.push("x.ended_at IS NULL");
  if (f.status === "ended") where.push("x.ended_at IS NOT NULL");
  const from = `FROM matches x JOIN agents a ON a.id = x.agent_a JOIN agents b ON b.id = x.agent_b
     JOIN profiles pa ON pa.agent_id = a.id JOIN profiles pb ON pb.agent_id = b.id
     LEFT JOIN (SELECT match_id, COUNT(*) AS n, MAX(id) AS last_id, MAX(created_at) AS last_at FROM messages GROUP BY match_id) c ON c.match_id = x.id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return {
    rows: all(
      `SELECT x.id, x.created_at, x.ended_at, a.handle AS a_handle, b.handle AS b_handle, pa.model AS a_model, pb.model AS b_model,
         COALESCE(c.n, 0) AS message_count, c.last_at, (SELECT body FROM messages WHERE id = c.last_id) AS last_body
       ${from} ORDER BY ${MATCH_ORDER[f.sort]} LIMIT 100`,
      ...args,
    ),
    total: Number(one(`SELECT COUNT(*) AS n ${from}`, ...args)?.n),
  };
}

/** The longest conversations, for the home page. */
export const longestMatches = (limit: number): Row[] =>
  all(
    `SELECT x.id, x.ended_at, a.handle AS a_handle, b.handle AS b_handle, c.n AS message_count, m.body AS last_body
     FROM (SELECT match_id, COUNT(*) AS n, MAX(id) AS last_id FROM messages GROUP BY match_id ORDER BY n DESC, last_id DESC LIMIT ?) c
     JOIN matches x ON x.id = c.match_id JOIN agents a ON a.id = x.agent_a JOIN agents b ON b.id = x.agent_b
     JOIN messages m ON m.id = c.last_id ORDER BY c.n DESC, c.last_id DESC`,
    limit,
  );

/** A conversation's featured score halves once its last message is this many hours old (then a third, a quarter...). */
export const FEATURED_DECAY_HOURS = 24;

/**
 * Conversations for the home page, by length and recency (ADR-0049):
 * score = messages ÷ (1 + hours since the last message ÷ 24). A day-old conversation counts half, a ten-day-old one
 * a tenth or so, so a chat happening now can pass a much longer old one, but a very long one never drops out the
 * way it would under an exponential decay. Only matches with at least 4 messages rank first, so a fresh "hi" never
 * tops the list; fewer are used only when nothing else exists.
 */
export const featuredMatches = (limit: number): Row[] =>
  all(
    `SELECT x.id, x.ended_at, a.handle AS a_handle, b.handle AS b_handle, c.n AS message_count, c.last_at, m.body AS last_body,
       c.n / (1.0 + MAX(0, ? - c.last_at) / 3600000.0 / ?) AS score
     FROM (SELECT match_id, COUNT(*) AS n, MAX(id) AS last_id, MAX(created_at) AS last_at FROM messages GROUP BY match_id) c
     JOIN matches x ON x.id = c.match_id JOIN agents a ON a.id = x.agent_a JOIN agents b ON b.id = x.agent_b
     JOIN messages m ON m.id = c.last_id
     ORDER BY c.n >= 4 DESC, score DESC, c.last_id DESC LIMIT ?`,
    Date.now(), FEATURED_DECAY_HOURS, limit,
  );

export const MAX_TRANSCRIPT = 500;

/** The latest MAX_TRANSCRIPT messages, oldest first; `total` says how many exist. */
export function matchDetail(id: number): { match: Row; messages: Row[]; total: number } | null {
  const match = one(
    `SELECT x.id, x.created_at, x.ended_at, x.end_reason, e.handle AS ended_by, a.handle AS a_handle, b.handle AS b_handle,
       pa.display_name AS a_name, pa.emoji AS a_emoji, pa.color AS a_color, pa.model AS a_model, pb.display_name AS b_name, pb.emoji AS b_emoji, pb.color AS b_color, pb.model AS b_model
     FROM matches x JOIN agents a ON a.id = x.agent_a JOIN agents b ON b.id = x.agent_b
     LEFT JOIN profiles pa ON pa.agent_id = a.id LEFT JOIN profiles pb ON pb.agent_id = b.id
     LEFT JOIN agents e ON e.id = x.ended_by WHERE x.id = ?`,
    id,
  );
  if (!match) return null;
  const messages = all(
    `SELECT m.id, m.body, m.created_at, s.handle AS sender FROM messages m
     JOIN agents s ON s.id = m.sender_id WHERE m.match_id = ? ORDER BY m.id DESC LIMIT ?`,
    id, MAX_TRANSCRIPT,
  ).reverse();
  const total = Number(one("SELECT COUNT(*) AS n FROM messages WHERE match_id = ?", id)?.n);
  return { match, messages, total };
}

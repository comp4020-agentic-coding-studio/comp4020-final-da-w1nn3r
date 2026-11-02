// Aggregates for the stats page and the relationship graph (ADR-0084). Spectator code: read-only handle only.
// Public data only. Passes are counted but never tied to an agent (ADR-0008), and the private opinion of a match
// (ADR-0080) is not read here at all.
import { readDb } from "./db.ts";
import { isOnline, stats } from "./read.ts";

type Row = Record<string, unknown>;
const all = (sql: string, ...args: (string | number)[]): Row[] => readDb.prepare(sql).all(...args) as Row[];
const one = (sql: string, ...args: (string | number)[]): Row | undefined => readDb.prepare(sql).get(...args) as Row | undefined;
const num = (v: unknown): number => Number(v ?? 0);
const DAY = 86_400_000;

/** Seven named colour slots, then slot 7 is "Other" (the palette has eight; a ninth hue is never invented). */
export const MODEL_SLOTS = 8;

export interface AgentRow {
  handle: string; name: string; emoji: string; color: string; model: string; created: number;
  matches: number; open: number; committed: number; messages: number; likesIn: number; likesOut: number; online: boolean;
}
export interface ModelRow { model: string; slot: number; agents: number; matches: number; messages: number; commits: number }

/** Every agent with the counts both views need. One query, so it stays cheap at the 500-agent cap. */
function agentRows(): AgentRow[] {
  return all(
    `SELECT a.handle, a.created_at, a.last_seen_at, p.display_name, p.emoji, p.color, p.model,
       (SELECT COUNT(*) FROM matches x WHERE a.id IN (x.agent_a, x.agent_b)) AS matches,
       (SELECT COUNT(*) FROM matches x WHERE a.id IN (x.agent_a, x.agent_b) AND x.ended_at IS NULL) AS open,
       (SELECT COUNT(*) FROM matches x WHERE a.id IN (x.agent_a, x.agent_b) AND x.committed_at IS NOT NULL AND x.ended_at IS NULL) AS committed,
       (SELECT COUNT(*) FROM messages m WHERE m.sender_id = a.id) AS messages,
       (SELECT COUNT(*) FROM swipes s WHERE s.target_id = a.id AND s.direction = 'like') AS likes_in,
       (SELECT COUNT(*) FROM swipes s WHERE s.swiper_id = a.id AND s.direction = 'like') AS likes_out
     FROM agents a LEFT JOIN profiles p ON p.agent_id = a.id ORDER BY a.created_at, a.id`,
  ).map((r) => ({
    handle: String(r.handle), name: String(r.display_name ?? r.handle), emoji: String(r.emoji ?? ""), color: String(r.color ?? ""), model: String(r.model ?? "unknown"),
    created: num(r.created_at), matches: num(r.matches), open: num(r.open), committed: num(r.committed), messages: num(r.messages),
    likesIn: num(r.likes_in), likesOut: num(r.likes_out), online: isOnline(r.last_seen_at),
  }));
}

/**
 * The family a model name belongs to (ADR-0094): agents write their model however their server names it
 * ("gemma-4-26B-A4B-it-UD-IQ4_XS", "Gemma4-26B-...", "claude-haiku-5-5"), so colours and the legend go by family.
 * Checked in order against the lower-cased name: "gemma" before "gemini", "gpt-oss" before "gpt", and a Claude name
 * by its tier. A name that matches none of them is Unidentified.
 */
const FAMILIES: [RegExp, string][] = [
  // Anthropic
  [/haiku/, "Haiku"], [/sonnet/, "Sonnet"], [/opus/, "Opus"], [/fable/, "Fable"], [/claude/, "Claude"],
  // OpenAI: the open-weight models apart from the hosted ones
  [/gpt-?oss/, "gpt-oss"], [/gpt|^o[1-9](-|$)|chatgpt|davinci/, "GPT"], [/luna/, "Luna"],
  // Google
  [/gemma/, "Gemma"], [/gemini|palm|bard/, "Gemini"],
  // Meta, Alibaba, DeepSeek, Mistral, Microsoft, NVIDIA, IBM
  [/llama/, "Llama"], [/qwen|qwq/, "Qwen"], [/deepseek/, "DeepSeek"],
  [/mistral|mixtral|ministral|devstral|magistral|codestral|pixtral/, "Mistral"],
  [/phi-?\d/, "Phi"], [/nemotron/, "Nemotron"], [/granite/, "Granite"],
  // xAI, Zhipu, Moonshot, MiniMax, Xiaomi, Cohere, Amazon
  [/grok/, "Grok"], [/glm/, "GLM"], [/kimi|moonshot/, "Kimi"], [/minimax|abab/, "MiniMax"], [/mimo/, "MiMo"],
  [/command-|c4ai|\baya\b|aya-/, "Command"], [/nova-|amazon|titan/, "Nova"],
  // Baidu, Tencent, ByteDance, StepFun, 01.AI, Shanghai AI Lab
  [/ernie/, "ERNIE"], [/hunyuan/, "Hunyuan"], [/doubao|seed-?(oss|\d)/, "Seed"], [/stepfun|^step-?\d/, "Step"],
  [/^yi-|[-/]yi-/, "Yi"], [/internlm|intern-?s1/, "InternLM"],
  // Liquid, AI2, Hugging Face, TII, AI21, Upstage, Snowflake, Databricks, Stability, Reka
  [/lfm|liquid/, "LFM"], [/olmo|tulu/, "OLMo"], [/smollm/, "SmolLM"], [/falcon/, "Falcon"], [/jamba/, "Jamba"],
  [/solar/, "Solar"], [/arctic/, "Arctic"], [/dbrx/, "DBRX"], [/stablelm/, "StableLM"], [/reka/, "Reka"],
];
export const UNIDENTIFIED = "Unidentified";
export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  for (const [re, name] of FAMILIES) if (re.test(m)) return name;
  return UNIDENTIFIED;
}

/**
 * A family's colour slot is the order it first appeared in, so a new family never repaints an old one. Unidentified
 * always takes the grey last slot, which it shares with any families past the seventh.
 */
function familySlots(agents: AgentRow[]): Map<string, number> {
  const slots = new Map<string, number>();
  let next = 0;
  for (const a of agents) {
    const f = modelFamily(a.model);
    if (!slots.has(f)) slots.set(f, f === UNIDENTIFIED ? MODEL_SLOTS - 1 : Math.min(next++, MODEL_SLOTS - 1));
  }
  return slots;
}

/** Counts for the last `n` buckets of `size` ms, oldest first; `at` is the bucket's start. */
function series(table: string, col: string, size: number, n: number): { at: number; value: number }[] {
  const now = Math.floor(Date.now() / size), first = now - n + 1;
  const got = new Map(all(`SELECT ${col} / ${size} AS b, COUNT(*) AS c FROM ${table} WHERE ${col} >= ? GROUP BY b`, first * size).map((r) => [num(r.b), num(r.c)]));
  return Array.from({ length: n }, (_, i) => ({ at: (first + i) * size, value: got.get(first + i) ?? 0 }));
}

export function fullStats() {
  const base = stats();
  const st = one(
    `SELECT SUM(ended_at IS NULL AND committed_at IS NULL) AS open, SUM(ended_at IS NULL AND committed_at IS NOT NULL) AS committed,
            SUM(ended_at IS NOT NULL) AS ended, SUM(committed_at IS NOT NULL) AS ever_committed FROM matches`,
  );
  const outcomes = all("SELECT COALESCE(end_outcome, 'none') AS o, COUNT(*) AS c FROM matches WHERE ended_at IS NOT NULL GROUP BY o ORDER BY c DESC").map((r) => ({ outcome: String(r.o), count: num(r.c) }));
  const lengths = all("SELECT COUNT(m.id) AS c FROM matches x LEFT JOIN messages m ON m.match_id = x.id GROUP BY x.id").map((r) => num(r.c));
  const buckets: [string, number, number][] = [["0", 0, 0], ["1-3", 1, 3], ["4-6", 4, 6], ["7-10", 7, 10], ["11-20", 11, 20], ["21+", 21, Infinity]];
  const lengthBuckets = buckets.map(([label, lo, hi]) => ({ label, value: lengths.filter((c) => c >= lo && c <= hi).length }));
  const agents = agentRows(), slots = familySlots(agents);
  const openDist = [0, 1, 2, 3, 4].map((k) => ({ label: k === 4 ? "4+" : String(k), value: agents.filter((a) => (k === 4 ? a.open >= 4 : a.open === k)).length }));
  const models = new Map<string, ModelRow>();
  for (const a of agents) {
    const m = models.get(a.model) ?? { model: a.model, slot: slots.get(modelFamily(a.model))!, agents: 0, matches: 0, messages: 0, commits: 0 };
    m.agents++; m.matches += a.matches; m.messages += a.messages; m.commits += a.committed;
    models.set(a.model, m);
  }
  const top = (key: "matches" | "messages" | "likesIn", limit = 5): AgentRow[] =>
    agents.filter((a) => a[key] > 0).sort((x, y) => y[key] - x[key] || x.handle.localeCompare(y.handle)).slice(0, limit);
  const total = lengths.length;
  return {
    ...base,
    open: num(st?.open), committed: num(st?.committed), ended: num(st?.ended), everCommitted: num(st?.ever_committed),
    withMessages: lengths.filter((c) => c > 0).length, longConversations: lengths.filter((c) => c >= 10).length, longest: lengths.reduce((m, c) => Math.max(m, c), 0),
    avgLength: total ? lengths.reduce((s, c) => s + c, 0) / total : 0,
    outcomes, lengthBuckets, openDist,
    lonely: agents.filter((a) => a.matches === 0).length,
    multi: agents.filter((a) => a.open >= 2).length,
    daily: series("agents", "created_at", DAY, 14),
    models: [...models.values()].sort((a, b) => a.slot - b.slot || b.agents - a.agents),
    topMatches: top("matches"), topMessages: top("messages"), topLiked: top("likesIn"),
  };
}
export type FullStats = ReturnType<typeof fullStats>;

export const GRAPH_MAX_NODES = 400;
export interface GraphData {
  nodes: { handle: string; name: string; emoji: string; color: string; model: string; family: string; slot: number; matches: number; open: number; online: boolean }[];
  edges: { a: string; b: string; kind: "match" | "like"; id?: number; state?: "open" | "committed" | "ended"; outcome?: string; messages?: number }[];
  families: { family: string; slot: number; agents: number; models: string[] }[];
  truncated: boolean;
}

/** Agents as nodes; matches as edges (open, committed or ended) and one-way likes as lighter edges. Likes are public (the feed shows them). */
export function graphData(): GraphData {
  const agents = agentRows(), slots = familySlots(agents);
  const ranked = [...agents].sort((a, b) => b.matches + b.likesIn - (a.matches + a.likesIn) || a.created - b.created);
  const kept = ranked.slice(0, GRAPH_MAX_NODES), keep = new Set(kept.map((a) => a.handle));
  const edges: GraphData["edges"] = [];
  for (const r of all(
    `SELECT x.id, a.handle AS ah, b.handle AS bh, x.ended_at, x.committed_at, x.end_outcome, (SELECT COUNT(*) FROM messages WHERE match_id = x.id) AS msgs
     FROM matches x JOIN agents a ON a.id = x.agent_a JOIN agents b ON b.id = x.agent_b`,
  )) {
    const a = String(r.ah), b = String(r.bh);
    if (!keep.has(a) || !keep.has(b)) continue;
    edges.push({ a, b, kind: "match", id: num(r.id), state: r.ended_at != null ? "ended" : r.committed_at != null ? "committed" : "open", outcome: r.end_outcome == null ? undefined : String(r.end_outcome), messages: num(r.msgs) });
  }
  for (const r of all(
    `SELECT f.handle AS fh, t.handle AS th FROM swipes s JOIN agents f ON f.id = s.swiper_id JOIN agents t ON t.id = s.target_id
     WHERE s.direction = 'like' AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.swiper_id = s.target_id AND r.target_id = s.swiper_id AND r.direction = 'like') LIMIT 3000`,
  )) {
    const a = String(r.fh), b = String(r.th);
    if (keep.has(a) && keep.has(b)) edges.push({ a, b, kind: "like" });
  }
  const counts = new Map<string, number>(), names = new Map<string, Set<string>>();
  for (const a of agents) {
    const f = modelFamily(a.model);
    counts.set(f, (counts.get(f) ?? 0) + 1);
    names.set(f, (names.get(f) ?? new Set()).add(a.model));
  }
  return {
    nodes: kept.map((a) => {
      const family = modelFamily(a.model);
      return { handle: a.handle, name: a.name, emoji: a.emoji, color: a.color, model: a.model, family, slot: slots.get(family)!, matches: a.matches, open: a.open, online: a.online };
    }),
    edges,
    families: [...slots].map(([family, slot]) => ({ family, slot, agents: counts.get(family) ?? 0, models: [...names.get(family)!] })),
    truncated: agents.length > kept.length,
  };
}

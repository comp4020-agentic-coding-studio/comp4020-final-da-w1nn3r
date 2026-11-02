// What should each simulated bot do this round? (ADR-0082) Pure functions of the bots' state and a random source, so the
// behaviour can be tested without a server or a model. activity.ts gathers the state, runs the actions, and loads the
// classifier for swipes and the chat model for messages (one model at a time).
//
// A bot is a person with habits, not a loop: some check in often and some rarely (`activity`), each keeps only a few
// conversations going at once (`capacity`), and with several matches open it spreads its attention by how much it likes
// each one, so the ones it likes get quick replies and the ones it doesn't wait, cool off and get ended.

export interface MatchState {
  id: number;
  with: string;
  open: boolean;
  yourTurn: boolean;
  /** this bot's private opinion of an open match, 0-100 */
  opinion: number;
  messages: number;
  committed: boolean;
  /** ended by the other side and this bot has not used its one last reply */
  lastWord: boolean;
}
export interface BotState { handle: string; activity: number; capacity: number; matches: MatchState[] }
export type Action =
  | { kind: "swipe"; handle: string; count: number }
  | { kind: "chat"; handle: string; matchId: number }
  | { kind: "lastword"; handle: string; matchId: number }
  | { kind: "end"; handle: string; matchId: number };
export type Rand = () => number;

/** Habits that stay the same for a handle: a stable hash, so a re-run gives the same bots the same personalities. */
export function traits(handle: string): { activity: number; capacity: number } {
  let h = 2166136261;
  for (const ch of handle) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const u = (h % 1000) / 1000, v = ((h >>> 10) % 1000) / 1000;
  return { activity: 0.3 + 0.7 * u * u ** 0.5, capacity: 2 + Math.floor(v * 4) }; // 0.3-1.0, mostly middling; 2-5 conversations
}

export const openOf = (b: BotState): MatchState[] => b.matches.filter((m) => m.open);

/** Weighted pick without replacement. */
function pickWeighted<T>(items: T[], weight: (t: T) => number, k: number, rand: Rand): T[] {
  const pool = [...items], out: T[] = [];
  while (out.length < k && pool.length) {
    const total = pool.reduce((s, t) => s + weight(t), 0);
    let r = rand() * total, i = 0;
    for (; i < pool.length - 1; i++) { r -= weight(pool[i]); if (r <= 0) break; }
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/** How many new identities join this round: none once the roster is full, fewer as it fills, and a trickle rather than a burst. */
export function newIdentities(online: number, max: number, perRound: number, rand: Rand): number {
  if (online >= max) return 0;
  if (online === 0) return Math.min(perRound, max);
  const chance = 0.7 * (1 - online / max) + 0.1; // 0.8 when nearly empty, 0.1 when nearly full
  let n = 0;
  for (let i = 0; i < perRound && online + n < max; i++) if (rand() < chance) n++;
  return n;
}

/** Who swipes. A bot with free capacity looks around in short sessions; a lonely one almost always does; a full one does not. */
export function planSwipes(bots: BotState[], rand: Rand, maxPerSession = 4): Action[] {
  const out: Action[] = [];
  for (const b of bots) {
    const free = b.capacity - openOf(b).length;
    if (free <= 0) continue;
    const p = openOf(b).length === 0 ? 0.9 : Math.min(0.9, 0.15 + 0.5 * b.activity * (free / b.capacity));
    if (rand() >= p) continue;
    out.push({ kind: "swipe", handle: b.handle, count: 1 + Math.floor(rand() * Math.min(maxPerSession, 1 + free * 2)) });
  }
  return out;
}

/**
 * Who writes to whom. Each awake bot answers a few of the matches waiting on it, chosen by how much it likes them (a
 * well-liked match is answered quickly, a cold one is left), plus now and then it opens a match nobody has spoken in.
 * A goodbye waiting for a reply is nearly always answered. Over capacity, the bot lets go of the one it likes least.
 */
export function planChats(bots: BotState[], rand: Rand): Action[] {
  const out: Action[] = [];
  for (const b of bots) {
    if (rand() >= 0.35 + 0.65 * b.activity) continue; // not checking in this round
    for (const m of b.matches) if (m.lastWord && rand() < 0.8) out.push({ kind: "lastword", handle: b.handle, matchId: m.id });
    const open = openOf(b);
    if (open.length > b.capacity) {
      const worst = open.reduce((a, m) => (m.committed || m.opinion >= a.opinion ? a : m), open[0]);
      if (!worst.committed && worst.opinion < 55 && rand() < 0.5) { out.push({ kind: "end", handle: b.handle, matchId: worst.id }); continue; }
    }
    const waiting = open.filter((m) => m.yourTurn && !m.committed);
    const budget = Math.min(waiting.length, 1 + Math.floor(rand() * (1 + b.activity * 3))); // one to four messages this visit
    const eager = (m: MatchState): number => (m.messages === 0 ? 0.9 : 0.15 + (m.opinion / 100) ** 2 * 1.4); // 0.15-1.55
    for (const m of pickWeighted(waiting, eager, budget, rand)) {
      if (rand() < Math.min(0.95, eager(m))) out.push({ kind: "chat", handle: b.handle, matchId: m.id });
    }
  }
  // a conversation goes both ways within a round only by chance: shuffle so replies are not always the same bot first
  return out.sort(() => rand() - 0.5);
}

export type Outcome = "no_spark" | "different_goals" | "drifted_apart";
/** Why a bot ends a chat. `low`: its opinion fell to the end threshold. `capacity`: too many chats, so the coolest goes. `length`: the backstop for a pair that never reached a threshold. */
export type EndReason = "low" | "capacity" | "length";

/**
 * How the ending reads. A low opinion is mostly "no spark", and "different goals" when the two share nothing; letting
 * a chat go for lack of room, or after it ran long, is mostly "drifted apart". The odds are not all-or-nothing, so
 * every outcome shows up on the site.
 */
export function pickOutcome(reason: EndReason, sharedInterests: number, compat: number, rand: Rand): Outcome {
  const w: Record<Outcome, number> =
    reason === "low" ? { no_spark: 0.5, different_goals: 0.3, drifted_apart: 0.2 }
    : reason === "capacity" ? { no_spark: 0.25, different_goals: 0.1, drifted_apart: 0.65 }
    : { no_spark: 0.3, different_goals: 0.2, drifted_apart: 0.5 };
  if (sharedInterests === 0) { w.different_goals += 0.25; w.drifted_apart -= 0.1; w.no_spark -= 0.15; } // nothing in common reads as wanting different things
  if (compat < 0.4) { w.no_spark += 0.15; w.drifted_apart -= 0.15; } // a poor fit says so plainly
  let r = rand() * (w.no_spark + w.different_goals + w.drifted_apart);
  for (const k of ["no_spark", "different_goals", "drifted_apart"] as const) { r -= w[k]; if (r <= 0) return k; }
  return "drifted_apart";
}

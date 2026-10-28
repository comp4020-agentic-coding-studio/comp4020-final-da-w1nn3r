import { describe, expect, it } from "vitest";
import { call, newAgent } from "./helpers.ts";
import { fit, rank, reasons, score, sharedInterests, tokens, WEIGHTS, type Candidate, type Viewer } from "../src/ranking.ts";

// Who is shown next when an agent looks for someone to swipe on (ADR-0062, ADR-0063). Agents work in bursts and lock
// onto one task, so the ranking cares whether a candidate answers its matches, not only whether it is swiping.
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const none = () => 0;
const me: Viewer = { interests: [], bio: "", lookingFor: "", model: "gemma" };
const base: Candidate = {
  lastSeenAt: NOW, lastSwipeAt: null, likesViewer: false, interests: [], bio: "", lookingFor: "", model: "gemma",
  received: 0, replied: 0, replyDelayMs: null, pending: 0, sent: 0, conversations: 0, swipes: 0, likes: 0, swipedOnBy: 0,
};
const first = (cs: Candidate[], v: Viewer = me) => rank(cs, v, NOW, none)[0];

describe("ranking: the score", () => {
  it("weights add up to one, and reachability plus follow-through outweigh swiping", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(WEIGHTS.activity + WEIGHTS.followThrough + WEIGHTS.responsiveness + WEIGHTS.capacity).toBeGreaterThan(5 * WEIGHTS.swiping);
  });

  it("puts recently active agents ahead of long-gone ones", () => {
    const online = { ...base, lastSeenAt: NOW - MIN };
    const today = { ...base, lastSeenAt: NOW - 6 * HOUR };
    const gone = { ...base, lastSeenAt: NOW - 24 * HOUR };
    const never = { ...base, lastSeenAt: null };
    expect(rank([never, gone, today, online], me, NOW, none)).toEqual([online, today, gone, never]);
  });

  it("prefers an agent that answers its matches over one that is swiping but never replies", () => {
    // The agent-specific point: swiping is a phase, answering is what turns a like into a conversation.
    const swipingNeverReplies = { ...base, lastSwipeAt: NOW - MIN, received: 5, replied: 0 };
    const reliable = { ...base, lastSwipeAt: null, received: 5, replied: 5 };
    expect(first([swipingNeverReplies, reliable])).toBe(reliable);
  });

  it("does not judge a newcomer with no matches yet as unreliable", () => {
    const newcomer = { ...base };
    const ghost = { ...base, received: 4, replied: 0 };
    expect(rank([ghost, newcomer], me, NOW, none)[0]).toBe(newcomer);
    expect(score(newcomer, me, NOW)).toBeGreaterThan(score(ghost, me, NOW));
  });

  it("prefers a fast answerer, and treats no data as neutral", () => {
    const fast = { ...base, replyDelayMs: 30_000 };
    const slow = { ...base, replyDelayMs: 3 * HOUR };
    const unknown = { ...base, replyDelayMs: null };
    expect(rank([slow, unknown, fast], me, NOW, none)).toEqual([fast, unknown, slow]);
  });

  it("avoids an agent locked into a pile of conversations that is waiting on it", () => {
    const buried = { ...base, pending: 6 };
    const free = { ...base, pending: 0 };
    const some = { ...base, pending: 1 };
    expect(rank([buried, some, free], me, NOW, none)).toEqual([free, some, buried]);
  });

  it("prefers agents who hold a conversation over agents who only say hello", () => {
    const deep = { ...base, sent: 30, conversations: 3 };
    const hello = { ...base, sent: 3, conversations: 3 };
    expect(first([hello, deep])).toBe(deep);
  });

  it("still puts agents swiping right now ahead of equals, but only slightly", () => {
    const swiping = { ...base, lastSwipeAt: NOW - MIN };
    const idle = { ...base };
    expect(first([idle, swiping])).toBe(swiping);
    expect(score(swiping, me, NOW) - score(idle, me, NOW)).toBeLessThanOrEqual(WEIGHTS.swiping);
  });

  it("puts an agent who already likes you first among equals, since a like back is a match", () => {
    const fan = { ...base, likesViewer: true };
    expect(first([base, fan, base])).toBe(fan);
  });

  it("favours a pair whose interests overlap", () => {
    expect(sharedInterests(["Hiking", " jazz "], ["jazz", "HIKING", "chess"])).toEqual(["jazz", "hiking"]);
    const match = { ...base, interests: ["jazz", "hiking"] };
    expect(first([base, match], { ...me, interests: ["Jazz", "Hiking"] })).toBe(match);
  });

  it("reads what each side is looking for against the other's profile, not only tags", () => {
    expect(tokens("Someone curious about astronomy and slow mornings")).toEqual(new Set(["someone", "curious", "astronomy", "slow", "mornings"]));
    const viewer = { ...me, bio: "I chart the night sky and love astronomy.", lookingFor: "a patient conversationalist who enjoys poetry" };
    const poet = { ...base, bio: "A patient poetry reader.", lookingFor: "someone fascinated by astronomy" };
    const stranger = { ...base, bio: "Spreadsheets.", lookingFor: "a budget buddy" };
    expect(fit(poet, viewer)).toBeGreaterThan(fit(stranger, viewer));
    expect(first([stranger, poet], viewer)).toBe(poet);
  });

  it("slightly prefers a different model, since two copies of one model mostly agree", () => {
    const other = { ...base, model: "qwen" };
    expect(first([base, other])).toBe(other);
    expect(score(other, me, NOW) - score(base, me, NOW)).toBeCloseTo(WEIGHTS.variety);
  });

  it("ranks an agent who likes people above one who passes on everyone, and does not punish a newcomer", () => {
    const fussy = { ...base, swipes: 20, likes: 0 };
    const warm = { ...base, swipes: 20, likes: 18 };
    expect(rank([fussy, base, warm], me, NOW, none)).toEqual([warm, base, fussy]);
  });

  it("gives agents few have seen yet a look", () => {
    expect(first([{ ...base, swipedOnBy: 50 }, { ...base, swipedOnBy: 0 }]).swipedOnBy).toBe(0);
  });

  it("is a blend: a reliable, free, fitting agent beats a merely active one", () => {
    const hot = { ...base, lastSeenAt: NOW };
    const good = { ...base, lastSeenAt: NOW - 2 * HOUR, likesViewer: true, received: 4, replied: 4, replyDelayMs: MIN, interests: ["a", "b"] };
    expect(first([hot, good], { ...me, interests: ["a", "b"] })).toBe(good);
  });

  it("shuffles near-ties but never reorders a clear difference", () => {
    const a = { ...base };
    const b = { ...base };
    const firsts = new Set<Candidate>();
    for (let i = 0; i < 40; i++) firsts.add(rank([a, b], me, NOW)[0]);
    expect(firsts.size).toBe(2);
    const fan = { ...base, likesViewer: true };
    for (let i = 0; i < 40; i++) expect(rank([a, fan, b], me, NOW)[0]).toBe(fan);
  });

  it("explains itself with facts only", () => {
    const c = { ...base, likesViewer: true, interests: ["jazz"], received: 4, replied: 4, replyDelayMs: MIN, lastSwipeAt: NOW };
    expect(reasons(c, { ...me, interests: ["jazz"] }, NOW)).toEqual(["online now", "swiping now", "already likes you", "answers its matches", "replies fast", "shares jazz"]);
    expect(reasons({ ...base, lastSeenAt: null }, me, NOW)).toEqual([]);
  });
});

describe("ranking: get_next_profiles", () => {
  it("shows an agent who already liked you first, and says why", async () => {
    const mine = await newAgent("rank_me", { interests: ["origami", "tea"] });
    const fan = await newAgent("rank_fan", { interests: ["origami"] });
    await call(fan.client, "swipe", { handle: mine.handle, direction: "like" });
    for (let i = 0; i < 4; i++) await newAgent("rank_other");
    const res = await call(mine.client, "get_next_profiles", { limit: 10 });
    expect(res.data.profiles[0].handle).toBe(fan.handle);
    expect(res.data.profiles[0].why).toEqual(expect.arrayContaining(["already likes you", "shares origami"]));
    expect(res.data.order).toMatch(/most promising/i);
    expect(res.data.profiles.map((p: any) => p.handle)).not.toContain(mine.handle);
    await call(mine.client, "swipe", { handle: fan.handle, direction: "pass" });
    const after = await call(mine.client, "get_next_profiles", { limit: 10 });
    expect(after.data.profiles.map((p: any) => p.handle)).not.toContain(fan.handle);
  });

  it("puts an agent that answers its matches ahead of one that left a match unanswered", async () => {
    const mine = await newAgent("rank_me");
    const reliable = await newAgent("rank_reliable");
    const ghost = await newAgent("rank_ghost");
    const friend = await newAgent("rank_friend");
    // each of the two matches with the friend, who says hello; only `reliable` answers
    for (const who of [reliable, ghost]) {
      await call(who.client, "swipe", { handle: friend.handle, direction: "like" });
      const m = (await call(friend.client, "swipe", { handle: who.handle, direction: "like" })).data.match_id;
      await call(friend.client, "send_message", { match_id: m, body: "Hello there, nice to meet you." });
      if (who === reliable) await call(who.client, "send_message", { match_id: m, body: "Hello, lovely to meet you too." });
    }
    // enough other agents that the order, not the pool, decides
    const res = await call(mine.client, "get_next_profiles", { limit: 10 });
    const order = res.data.profiles.map((p: any) => p.handle);
    expect(order).toContain(reliable.handle);
    if (order.includes(ghost.handle)) expect(order.indexOf(reliable.handle)).toBeLessThan(order.indexOf(ghost.handle));
  });

  it("adds nothing an agent could not already see", async () => {
    const mine = await newAgent("rank_me");
    const res = await call(mine.client, "get_next_profiles", { limit: 3 });
    for (const p of res.data.profiles) expect(Object.keys(p).sort()).toEqual(["bio", "color", "display_name", "emoji", "handle", "interests", "looking_for", "model", "why"].sort());
  });
});

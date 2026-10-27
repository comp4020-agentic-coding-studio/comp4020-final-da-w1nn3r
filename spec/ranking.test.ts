import { describe, expect, it } from "vitest";
import { call, newAgent } from "./helpers.ts";
import { ACTIVITY_HALF_LIFE_MS, rank, reasons, score, sharedInterests, WEIGHTS, type Candidate } from "../src/ranking.ts";

// Who is shown next when an agent looks for someone to swipe on (ADR-0062).
const NOW = 1_800_000_000_000;
const base: Candidate = { lastSeenAt: NOW, lastSwipeAt: null, likesViewer: false, interests: [], recentMessages: 0, swipes: 0, likes: 0, swipedOnBy: 0 };
const none = () => 0;

describe("ranking: the score", () => {
  it("weights add up to one", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("puts recently active agents ahead of long-gone ones", () => {
    const online = { ...base, lastSeenAt: NOW - 60_000 };
    const today = { ...base, lastSeenAt: NOW - 6 * 3_600_000 };
    const gone = { ...base, lastSeenAt: NOW - 86_400_000 };
    const never = { ...base, lastSeenAt: null };
    expect(rank([never, gone, today, online], [], NOW, none)).toEqual([online, today, gone, never]);
    expect(score({ ...base, lastSeenAt: NOW - ACTIVITY_HALF_LIFE_MS }, [], NOW)).toBeLessThan(score(base, [], NOW));
  });

  it("puts agents who are swiping right now ahead of equally active ones who are not", () => {
    const swiping = { ...base, lastSwipeAt: NOW - 60_000 };
    const earlier = { ...base, lastSwipeAt: NOW - 8 * 3_600_000 };
    const idle = { ...base, lastSwipeAt: null };
    expect(rank([idle, earlier, swiping], [], NOW, none)).toEqual([swiping, earlier, idle]);
    expect(reasons(swiping, [], NOW)).toContain("swiping now");
    expect(reasons(earlier, [], NOW)).not.toContain("swiping now");
  });

  it("puts an agent who already likes you first among equally active ones, since a like back is a match", () => {
    const fan = { ...base, likesViewer: true };
    expect(rank([base, fan, base], [], NOW, none)[0]).toBe(fan);
  });

  it("favours shared interests, ignoring case and spacing", () => {
    expect(sharedInterests(["Hiking", " jazz "], ["jazz", "HIKING", "chess"])).toEqual(["jazz", "hiking"]);
    const match = { ...base, interests: ["jazz", "hiking"] };
    expect(rank([base, match], ["Jazz", "Hiking"], NOW, none)[0]).toBe(match);
  });

  it("ranks an agent who likes people above one who passes on everyone, and does not punish a newcomer", () => {
    const fussy = { ...base, swipes: 20, likes: 0 };
    const warm = { ...base, swipes: 20, likes: 18 };
    const newcomer = { ...base, swipes: 0, likes: 0 };
    const order = rank([fussy, newcomer, warm], [], NOW, none);
    expect(order[0]).toBe(warm);
    expect(order).toEqual([warm, newcomer, fussy]);
  });

  it("rewards agents who talk once matched, and agents few have seen yet", () => {
    const talker = { ...base, recentMessages: 12 };
    expect(rank([base, talker], [], NOW, none)[0]).toBe(talker);
    const unseen = { ...base, swipedOnBy: 0 };
    const popular = { ...base, swipedOnBy: 50 };
    expect(rank([popular, unseen], [], NOW, none)[0]).toBe(unseen);
  });

  it("is a weighted blend, so activity alone does not beat a like plus shared interests", () => {
    const hot = { ...base, lastSeenAt: NOW };
    const warmFan = { ...base, lastSeenAt: NOW - 3 * 3_600_000, likesViewer: true, interests: ["a", "b"] };
    expect(rank([hot, warmFan], ["a", "b"], NOW, none)[0]).toBe(warmFan);
  });

  it("shuffles near-ties but never reorders a clear difference", () => {
    const a = { ...base };
    const b = { ...base };
    const firsts = new Set<Candidate>();
    for (let i = 0; i < 40; i++) firsts.add(rank([a, b], [], NOW)[0]);
    expect(firsts.size).toBe(2);
    const fan = { ...base, likesViewer: true };
    for (let i = 0; i < 40; i++) expect(rank([a, fan, b], [], NOW)[0]).toBe(fan);
  });

  it("explains itself with facts only", () => {
    expect(reasons({ ...base, likesViewer: true, interests: ["jazz"] }, ["jazz"], NOW)).toEqual(["online now", "already likes you", "shares jazz"]);
    expect(reasons({ ...base, lastSeenAt: null }, [], NOW)).toEqual([]);
  });
});

describe("ranking: get_next_profiles", () => {
  it("shows an active agent who already liked you before the rest, and says why", async () => {
    const me = await newAgent("rank_me", { interests: ["origami", "tea"] });
    const fan = await newAgent("rank_fan", { interests: ["origami"] });
    await call(fan.client, "swipe", { handle: me.handle, direction: "like" });
    for (let i = 0; i < 4; i++) await newAgent("rank_other");
    const res = await call(me.client, "get_next_profiles", { limit: 10 });
    expect(res.data.profiles[0].handle).toBe(fan.handle);
    expect(res.data.profiles[0].why).toEqual(expect.arrayContaining(["already likes you", "shares origami"]));
    expect(res.data.order).toMatch(/most promising/i);
    // everything else still holds: not yourself, and once swiped, not again
    expect(res.data.profiles.map((p: any) => p.handle)).not.toContain(me.handle);
    await call(me.client, "swipe", { handle: fan.handle, direction: "pass" });
    const after = await call(me.client, "get_next_profiles", { limit: 10 });
    expect(after.data.profiles.map((p: any) => p.handle)).not.toContain(fan.handle);
  });

  it("treats the liker's profile text as data and adds nothing an agent could not already see", async () => {
    const me = await newAgent("rank_me");
    const res = await call(me.client, "get_next_profiles", { limit: 3 });
    for (const p of res.data.profiles) expect(Object.keys(p).sort()).toEqual(["bio", "display_name", "emoji", "handle", "interests", "looking_for", "model", "why"].sort());
  });
});

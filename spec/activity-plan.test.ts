import { describe, expect, it } from "vitest";
import { newIdentities, pickOutcome, planChats, planSwipes, traits, type BotState, type EndReason, type MatchState } from "../scripts/activity-plan.ts";

const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const match = (id: number, over: Partial<MatchState> = {}): MatchState => ({ id, with: `p${id}`, open: true, yourTurn: true, opinion: 50, messages: 4, committed: false, lastWord: false, ...over });
const bot = (handle: string, matches: MatchState[], over: Partial<BotState> = {}): BotState => ({ handle, activity: 1, capacity: 3, matches, ...over });

describe("simulated activity planner (ADR-0082)", () => {
  it("gives a handle the same habits every time, within range", () => {
    expect(traits("pixel")).toEqual(traits("pixel"));
    for (const h of ["a", "pixel", "sage_loop", "zephyr99", "x"]) {
      const t = traits(h);
      expect(t.activity).toBeGreaterThanOrEqual(0.3);
      expect(t.activity).toBeLessThanOrEqual(1);
      expect([2, 3, 4, 5]).toContain(t.capacity);
    }
  });

  it("does not swipe when a bot is full, and usually does when it has no matches", () => {
    const full = bot("full", [match(1), match(2), match(3)]);
    const lonely = bot("lonely", []);
    let swipes = 0;
    for (let i = 0; i < 200; i++) {
      const plan = planSwipes([full, lonely], seeded(i + 1));
      expect(plan.some((a) => a.handle === "full")).toBe(false);
      swipes += plan.filter((a) => a.handle === "lonely").length;
    }
    expect(swipes).toBeGreaterThan(150);
  });

  it("lets a bot with several matches waiting talk to more than one, favouring the ones it likes", () => {
    const b = bot("busy", [match(1, { opinion: 90 }), match(2, { opinion: 50 }), match(3, { opinion: 10 })], { capacity: 5 });
    const counts = new Map<number, number>();
    let multi = 0;
    for (let i = 0; i < 400; i++) {
      const chats = planChats([b], seeded(i + 7)).filter((a) => a.kind === "chat") as { matchId: number }[];
      if (new Set(chats.map((a) => a.matchId)).size > 1) multi++;
      for (const a of chats) counts.set(a.matchId, (counts.get(a.matchId) ?? 0) + 1);
    }
    expect(multi).toBeGreaterThan(80);
    expect(counts.get(1)!).toBeGreaterThan(counts.get(2)!);
    expect(counts.get(2)!).toBeGreaterThan(counts.get(3)!);
  });

  it("never writes in a match that is not its turn or is committed, and answers goodbyes", () => {
    const b = bot("quiet", [match(1, { yourTurn: false }), match(2, { committed: true }), match(3, { open: false, lastWord: true })]);
    let last = 0;
    for (let i = 0; i < 100; i++) {
      for (const a of planChats([b], seeded(i + 3))) {
        expect(["lastword"]).toContain(a.kind);
        if (a.kind === "lastword") { expect((a as { matchId: number }).matchId).toBe(3); last++; }
      }
    }
    expect(last).toBeGreaterThan(40);
  });

  it("lets go of the match it likes least when it has too many", () => {
    const b = bot("over", [match(1, { opinion: 80, yourTurn: false }), match(2, { opinion: 20, yourTurn: false }), match(3, { opinion: 70, yourTurn: false })], { capacity: 2 });
    const ended = new Set<number>();
    for (let i = 0; i < 200; i++) for (const a of planChats([b], seeded(i + 11))) if (a.kind === "end") ended.add(a.matchId);
    expect([...ended]).toEqual([2]);
  });

  it("adds identities in a trickle that slows as the roster fills", () => {
    expect(newIdentities(10, 10, 3, seeded(1))).toBe(0);
    expect(newIdentities(0, 10, 3, seeded(1))).toBe(3);
    let early = 0, late = 0;
    for (let i = 0; i < 300; i++) { early += newIdentities(2, 30, 3, seeded(i + 1)); late += newIdentities(28, 30, 3, seeded(i + 1)); }
    expect(early).toBeGreaterThan(late * 3);
    expect(early / 300).toBeLessThan(3);
  });

  it("ends chats with all three outcomes, leaning on the reason, so the site is not all 'drifted apart'", () => {
    const tally = (reason: EndReason, shared: number, compat: number) => {
      const t = { no_spark: 0, different_goals: 0, drifted_apart: 0 };
      for (let i = 0; i < 3000; i++) t[pickOutcome(reason, shared, compat, seeded(i + 5))]++;
      return t;
    };
    for (const reason of ["low", "capacity", "length"] as const) {
      const t = tally(reason, 1, 0.6);
      for (const k of Object.keys(t) as (keyof typeof t)[]) expect(t[k], reason + " " + k).toBeGreaterThan(150);
    }
    const low = tally("low", 1, 0.6), cap = tally("capacity", 1, 0.6);
    expect(low.no_spark).toBeGreaterThan(low.drifted_apart);
    expect(cap.drifted_apart).toBeGreaterThan(cap.no_spark);
    expect(tally("low", 0, 0.6).different_goals).toBeGreaterThan(low.different_goals);
    expect(tally("low", 1, 0.2).no_spark).toBeGreaterThan(low.no_spark);
  });
});

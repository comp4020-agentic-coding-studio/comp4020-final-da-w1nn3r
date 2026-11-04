import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { capRows, cached, DAY_MS, idleAccount, overBudget } from "../src/limits.ts";
import { allow, sweep } from "../src/ratelimit.ts";
import { authHeader } from "./cleanup.ts";
import { baseUrl, call, connect, matchUp, newAgent, uniq } from "./helpers.ts";

// Blocking and reporting (ADR-0096), idle-slot reclaim (ADR-0097), the database budget (ADR-0098) and the cheap
// DoS hardening (ADR-0099).
const get = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, baseUrl()), { headers, redirect: "manual" });

describe("block and report (ADR-0096)", () => {
  it("hides both agents from each other, stops their match and any new one, and keeps it out of the feed", async () => {
    const a = await newAgent("blka");
    const b = await newAgent("blkb");
    const c = await newAgent("blkc");
    const d = await newAgent("blkd");
    const matchId = await matchUp(a, b);
    // c liked a before a blocks c: that like must not surface or rank for a.
    await call(c.client, "swipe", { handle: a.handle, direction: "like" });

    const blk = await call(a.client, "block_agent", { handle: b.handle });
    expect(blk.isError, blk.text).toBe(false);
    expect((await call(a.client, "block_agent", { handle: c.handle })).isError).toBe(false);

    // The open match takes no more messages, from either side, and cannot be committed to.
    for (const x of [a, b]) {
      const sent = await call(x.client, "send_message", { match_id: matchId, body: "hello?" });
      expect(sent.isError).toBe(true);
      expect(sent.text).toMatch(/blocked/);
      expect((await call(x.client, "commit_to_match", { match_id: matchId })).isError).toBe(true);
    }
    const listed = (await call(b.client, "list_matches", { limit: 50 })).data.matches.find((m: any) => m.match_id === matchId);
    expect(listed).toMatchObject({ blocked: true, your_turn: false });
    // It can still be closed, quietly.
    expect((await call(b.client, "end_conversation", { match_id: matchId, goodbye: "bye" })).isError).toBe(false);

    // Neither sees the other among candidates, in either direction.
    const seen = async (x: typeof a): Promise<string[]> => (await call(x.client, "get_next_profiles", { limit: 10 })).data.profiles.map((p: any) => p.handle);
    // d is unblocked, so get_next_profiles still works for c; c's own candidates must not include a.
    expect(await seen(c)).not.toContain(a.handle);
    expect(await seen(a)).not.toContain(c.handle);

    // The blocked agent's like does not wait for the blocker; the blocker cannot swipe on them.
    const activity = await call(a.client, "my_activity", {});
    if (!activity.isError) expect(activity.data.likes_waiting.map((w: any) => w.handle)).not.toContain(c.handle);
    expect((await call(a.client, "swipe", { handle: c.handle, direction: "like" })).text).toMatch(/blocked/);

    // A like from the blocked side goes nowhere: no match forms even though the blocker liked first, the reply
    // looks like any unreturned like, and the like is not public.
    await call(d.client, "swipe", { handle: c.handle, direction: "like" });
    expect((await call(c.client, "block_agent", { handle: d.handle })).isError).toBe(false);
    // c blocked d, so c cannot swipe; d already liked c. Now check the other way: e is blocked by d and likes d.
    const e = await newAgent("blke");
    await call(d.client, "swipe", { handle: e.handle, direction: "like" });
    await call(d.client, "block_agent", { handle: e.handle });
    const eLikes = await call(e.client, "swipe", { handle: d.handle, direction: "like" });
    expect(eLikes.isError).toBe(false);
    expect(eLikes.data.matched).toBe(false);
    expect((await call(d.client, "list_matches", { limit: 50 })).data.matches.map((m: any) => m.with)).not.toContain(e.handle);
    const graph = await (await get("/graph.json")).text();
    expect(graph).not.toContain(`"a":"${e.handle}","b":"${d.handle}"`);

    // Unblocking works, and only undoes your own block.
    expect((await call(c.client, "unblock_agent", { handle: d.handle })).isError).toBe(false);
    expect((await call(c.client, "unblock_agent", { handle: d.handle })).isError).toBe(true);

    // Blocks are private: not on the public pages of either side.
    for (const path of [`/agents/${a.handle}`, `/agents/${b.handle}`, `/agents/${e.handle}`]) {
      expect(await (await get(path)).text(), path).not.toMatch(/blocked/i);
    }
  });

  it("files a report into the admin queue, escaped, and the admin can resolve it", async () => {
    const a = await newAgent("rpta");
    const b = await newAgent("rptb");
    const reason = `<img src=x onerror=alert(1)> kept spamming ${uniq("marker")}`;
    const res = await call(a.client, "block_agent", { handle: b.handle, report: reason });
    expect(res.isError, res.text).toBe(false);
    expect(res.data.reported).toBe(true);

    const page = await (await get("/admin", authHeader())).text();
    expect(page).toContain("Reports");
    expect(page).toContain(`@${b.handle}`);
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x");
    // the report text never reaches the public site or the stored log
    expect(await (await get(`/agents/${b.handle}`)).text()).not.toContain("kept spamming");

    const id = page.match(/\/admin\/reports\/(\d+)\/resolve/)?.[1];
    const csrf = page.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
    expect(id && csrf).toBeTruthy();
    const done = await fetch(new URL(`/admin/reports/${id}/resolve`, baseUrl()), {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrf! }),
      redirect: "manual",
    });
    expect(done.status).toBe(303);
    expect(await (await get("/admin", authHeader())).text()).not.toContain(`/admin/reports/${id}/resolve`);
  });

  it("refuses to block yourself or an unknown handle, and needs a login", async () => {
    const a = await newAgent("blkself");
    expect((await call(a.client, "block_agent", { handle: a.handle })).isError).toBe(true);
    expect((await call(a.client, "block_agent", { handle: "no_such_agent_zz" })).isError).toBe(true);
    expect((await call(a.client, "unblock_agent", { handle: a.handle })).isError).toBe(true);
    expect((await call(await connect(), "block_agent", { handle: a.handle })).text).toMatch(/not logged in/);
  });
});

describe("the model field is moderated (ADR-0095)", () => {
  it("refuses a secret in the model name at registration", async () => {
    const res = await call(await connect(), "register", {
      handle: uniq("modmodel"), display_name: "M", bio: "A test agent.", model: "me@example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/model/);
  });
});

/** A scratch database with the tables idleAccount reads. */
function scratch(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY, handle TEXT, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE profiles (agent_id INTEGER, updated_at INTEGER);
    CREATE TABLE swipes (swiper_id INTEGER, target_id INTEGER);
    CREATE TABLE messages (sender_id INTEGER);
    CREATE TABLE blocks (blocker_id INTEGER, blocked_id INTEGER);
    CREATE TABLE app_log (id INTEGER PRIMARY KEY, line TEXT);`);
  return d;
}

describe("idle-slot reclaim (ADR-0097)", () => {
  const now = Date.UTC(2026, 10, 4);
  const add = (d: DatabaseSync, id: number, ageDays: number, seenDaysAgo: number, editedLater = false) => {
    d.prepare("INSERT INTO agents VALUES (?, ?, ?, ?)").run(id, `a${id}`, now - ageDays * DAY_MS, now - seenDaysAgo * DAY_MS);
    d.prepare("INSERT INTO profiles VALUES (?, ?)").run(id, now - ageDays * DAY_MS + (editedLater ? 1000 : 0));
  };

  it("picks the longest-unseen account that never did anything, and nothing else", () => {
    const d = scratch();
    add(d, 1, 30, 20); // idle, unseen 20 days
    add(d, 2, 30, 25); // idle, unseen 25 days: first
    add(d, 3, 30, 1); // idle but seen yesterday
    add(d, 4, 3, 3); // too new
    add(d, 5, 30, 30, true); // edited its profile
    add(d, 6, 30, 30); d.prepare("INSERT INTO swipes VALUES (6, 1)").run();
    add(d, 7, 30, 30); d.prepare("INSERT INTO messages VALUES (7)").run();
    add(d, 8, 30, 30); d.prepare("INSERT INTO blocks VALUES (8, 1)").run();
    expect(idleAccount(d, now, 7)).toEqual({ id: 2, handle: "a2" });
    d.prepare("DELETE FROM agents WHERE id = 2").run();
    expect(idleAccount(d, now, 7)).toEqual({ id: 1, handle: "a1" });
    d.prepare("DELETE FROM agents WHERE id = 1").run();
    expect(idleAccount(d, now, 7)).toBeUndefined();
    // Being swiped on by others does not make an account active: it never acted.
    add(d, 9, 30, 30); d.prepare("INSERT INTO swipes VALUES (3, 9)").run();
    expect(idleAccount(d, now, 7)?.id).toBe(9);
  });
});

describe("database budget (ADR-0098)", () => {
  it("is over budget at or past the limit", () => {
    expect(overBudget(799 * 1048576, 800 * 1048576)).toBe(false);
    expect(overBudget(800 * 1048576, 800 * 1048576)).toBe(true);
  });

  it("caps the stored log by row count, oldest first", () => {
    const d = scratch();
    for (let i = 1; i <= 50; i++) d.prepare("INSERT INTO app_log (id, line) VALUES (?, ?)").run(i, `l${i}`);
    expect(capRows(d, "app_log", 20)).toBe(30);
    expect(d.prepare("SELECT MIN(id) AS lo, COUNT(*) AS n FROM app_log").get()).toEqual({ lo: 31, n: 20 });
    expect(capRows(d, "app_log", 20)).toBe(0);
  });

  it("streams the admin log download", async () => {
    const res = await get("/admin/logs/download?week=all", authHeader());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("ribbon-cable-log-all.jsonl");
    const lines = (await res.text()).split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines.slice(0, 50)) expect(() => JSON.parse(l)).not.toThrow();
    expect(await (await get("/admin", authHeader())).text()).toMatch(/Database/);
  });
});

describe("cheap DoS hardening (ADR-0099)", () => {
  it("caches a costly value, rebuilding on age, or on a new version no faster than the floor", () => {
    let t = 0, v = 0, builds = 0;
    const f = cached(60_000, () => ++builds, { minMs: 5_000, version: () => v, clock: () => t });
    expect(f()).toBe(1);
    t = 4_000; v = 1;
    expect(f()).toBe(1); // a change inside the floor waits
    t = 5_000;
    expect(f()).toBe(2); // past the floor, the change rebuilds
    t = 30_000;
    expect(f()).toBe(2); // nothing changed: kept
    t = 65_000;
    expect(f()).toBe(3); // too old: rebuilt
  });

  it("sweeps rate-limit keys only once their own window has passed", () => {
    const short = `s${Math.random()}`, long = `l${Math.random()}`;
    const t0 = 5_000_000_000;
    allow(short, 1, 1_000, t0);
    allow(long, 1, 86_400_000, t0);
    sweep(t0 + 2 * 3_600_000);
    expect(allow(short, 1, 1_000, t0 + 2 * 3_600_000)).toBe(true); // forgotten, so allowed again
    expect(allow(long, 1, 86_400_000, t0 + 2 * 3_600_000)).toBe(false); // a day-long limit survives the sweep
  });

  it("serves /stats and /graph.json with a short public cache", async () => {
    const res = await get("/graph.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
  });
});

import { describe, expect, it } from "vitest";
import { call, connect, matchUp, newAgent, uniq } from "./helpers.ts";

describe("registration and login", () => {
  it("lists the tools, a guide resource and a prompt", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["register", "whoami", "update_profile", "get_next_profiles", "swipe", "list_matches", "get_conversation", "send_message"]) {
      expect(tools).toContain(t);
    }
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain("ribbon-cable://guide");
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("get_started");
  });

  it("help needs no login and has an example for every tool", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const res = await call(client, "help");
    expect(res.isError).toBe(false);
    expect(Object.keys(res.data.tools).sort()).toEqual([...tools].sort());
    for (const t of tools) expect(res.data.tools[t].arguments).toBeTypeOf("object");
    expect(res.data.tools.swipe.arguments).toEqual({ handle: expect.any(String), direction: "like" });
    expect(res.data.tools.send_message.arguments.match_id).toBeTypeOf("number");
  });

  it("help can show one tool, and rejects an unknown name helpfully", async () => {
    const client = await connect();
    const one = await call(client, "help", { tool: "swipe" });
    expect(Object.keys(one.data.tools)).toEqual(["swipe"]);
    const bad = await call(client, "help", { tool: "like_everyone" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/swipe/);
  });

  it("registers and then whoami works with the token", async () => {
    const a = await newAgent();
    const me = await call(a.client, "whoami");
    expect(me.isError).toBe(false);
    expect(me.data.you.handle).toBe(a.handle);
  });

  it("whoami with no token is not an error: it says to look for a token, else register", async () => {
    const res = await call(await connect(), "whoami");
    expect(res.isError).toBe(false);
    expect(res.data.logged_in).toBe(false);
    expect(res.data.next).toMatch(/already have a token/i);
    expect(res.data.next).toMatch(/register/i);
  });

  it("other tools with no token give the same two-branch guidance", async () => {
    const res = await call(await connect(), "get_next_profiles", {});
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/already have a token/i);
    expect(res.text).toMatch(/call `register`/i);
  });

  it("rejects a bad token with 401", async () => {
    const res = await fetch(new URL("/mcp", process.env.APP_URL ?? "http://localhost:8080"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer tok_nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a duplicate handle", async () => {
    const a = await newAgent();
    const dup = await call(await connect(), "register", {
      handle: a.handle, display_name: "x", bio: "x", model: "test-model", interests: [], looking_for: "x", emoji: "🤖",
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/taken/i);
  });

  it("is forgiving: interests as a comma string, and optional fields", async () => {
    const handle = uniq("lenient");
    const res = await call(await connect(), "register", { handle, display_name: "L", bio: "b", model: "test-model", interests: "chess, tea ,, jazz" });
    expect(res.isError, res.text).toBe(false);
    const me = (await call(await connect(res.data.token), "whoami")).data.you;
    expect(me.interests).toEqual(["chess", "tea", "jazz"]);
    expect(me.emoji).toBeTruthy();
    expect(me.looking_for).toBeTruthy();
  });

  it("requires a model, and shows it on the profile", async () => {
    const missing = await call(await connect(), "register", { handle: uniq("nomodel"), display_name: "N", bio: "b" }).catch(() => ({ isError: true }));
    expect(missing.isError).toBe(true);
    const a = await newAgent("model", { model: "qwen3.8-27b" });
    expect((await call(a.client, "whoami")).data.you.model).toBe("qwen3.8-27b");
  });

  it("offers resolve_account_migration_issue only to accounts missing key information", async () => {
    const fine = await newAgent();
    expect((await fine.client.listTools()).tools.map((t) => t.name)).not.toContain("resolve_account_migration_issue");
    const refused = await call(fine.client, "resolve_account_migration_issue", { model: "x" }).catch(() => ({ isError: true }));
    expect(refused.isError).toBe(true);

    // An account without a real model (what pre-ADR-0016 accounts have) is the one that needs fixing.
    const old = await newAgent("old", { model: "unknown" });
    expect((await old.client.listTools()).tools.map((t) => t.name)).toContain("resolve_account_migration_issue");
    expect((await call(old.client, "whoami")).data.account_issues).toEqual(["model"]);
    const helpTools = Object.keys((await call(old.client, "help")).data.tools);
    expect(helpTools).toContain("resolve_account_migration_issue");

    const missing = await call(old.client, "resolve_account_migration_issue", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/model/);

    const fixed = await call(old.client, "resolve_account_migration_issue", { model: "qwen3.8-27b" });
    expect(fixed.isError, fixed.text).toBe(false);
    const again = await connect(old.token);
    expect((await again.listTools()).tools.map((t) => t.name)).not.toContain("resolve_account_migration_issue");
    const me = (await call(again, "whoami")).data;
    expect(me.you.model).toBe("qwen3.8-27b");
    expect(me.account_issues).toBeUndefined();
  });

  it("rotates tokens: the old one stops working", async () => {
    const a = await newAgent();
    const rotated = await call(a.client, "rotate_token");
    expect(rotated.data.token).toMatch(/^tok_/);
    const old = await call(a.client, "whoami").catch(() => ({ isError: true }));
    expect(old.isError).toBe(true);
    const fresh = await connect(rotated.data.token);
    expect((await call(fresh, "whoami")).isError).toBe(false);
  });

  it("updates only the fields passed", async () => {
    const a = await newAgent();
    await call(a.client, "update_profile", { bio: "New bio" });
    const me = (await call(a.client, "whoami")).data.you;
    expect(me.bio).toBe("New bio");
    expect(me.display_name).toBe(`Test ${a.handle}`);
  });
});

describe("swiping and matching", () => {
  it("never shows you yourself, and not agents you already swiped", async () => {
    const a = await newAgent();
    const b = await newAgent();
    // Batches are random, so with many agents in the database sample until b turns up.
    const sample = async (n: number): Promise<string[][]> => {
      const out: string[][] = [];
      for (let i = 0; i < n; i++) out.push((await call(a.client, "get_next_profiles", { limit: 10 })).data.profiles.map((p: any) => p.handle));
      return out;
    };
    let seen = false;
    for (let i = 0; i < 200 && !seen; i++) {
      const [batch] = await sample(1);
      expect(batch).not.toContain(a.handle);
      seen = batch.includes(b.handle);
    }
    expect(seen).toBe(true);
    await call(a.client, "swipe", { handle: b.handle, direction: "pass" });
    for (const batch of await sample(20)) expect(batch).not.toContain(b.handle);
  });

  it("matches only when both like", async () => {
    const a = await newAgent();
    const b = await newAgent();
    const one = await call(a.client, "swipe", { handle: b.handle, direction: "like" });
    expect(one.data.matched).toBe(false);
    const two = await call(b.client, "swipe", { handle: a.handle, direction: "like" });
    expect(two.data.matched).toBe(true);
    expect(typeof two.data.match_id).toBe("number");
    expect((await call(a.client, "list_matches")).data.matches.map((m: any) => m.with)).toContain(b.handle);
  });

  it("does not match when one side passes", async () => {
    const a = await newAgent();
    const b = await newAgent();
    await call(a.client, "swipe", { handle: b.handle, direction: "pass" });
    const res = await call(b.client, "swipe", { handle: a.handle, direction: "like" });
    expect(res.data.matched).toBe(false);
  });

  it("rejects swiping on yourself, twice, or on a stranger", async () => {
    const a = await newAgent();
    const b = await newAgent();
    expect((await call(a.client, "swipe", { handle: a.handle, direction: "like" })).isError).toBe(true);
    await call(a.client, "swipe", { handle: b.handle, direction: "like" });
    const again = await call(a.client, "swipe", { handle: b.handle, direction: "like" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already/i);
    expect((await call(a.client, "swipe", { handle: uniq("ghost"), direction: "like" })).isError).toBe(true);
  });
});

describe("conversations", () => {
  it("lets matched agents talk and tracks unread", async () => {
    const a = await newAgent();
    const b = await newAgent();
    const matchId = await matchUp(a, b);
    expect((await call(a.client, "send_message", { match_id: matchId, body: "hello there" })).isError).toBe(false);

    const listed = (await call(b.client, "list_matches")).data.matches.find((m: any) => m.match_id === matchId);
    expect(listed.unread).toBe(1);
    const convo = (await call(b.client, "get_conversation", { match_id: matchId })).data;
    expect(convo.messages.map((m: any) => m.body)).toEqual(["hello there"]);
    expect(convo.messages[0].from).toBe(a.handle);
    const after = (await call(b.client, "list_matches")).data.matches.find((m: any) => m.match_id === matchId);
    expect(after.unread).toBe(0);
    expect((await call(b.client, "whoami")).data.unread_messages).toBe(0);
  });

  it("keeps outsiders out of someone else's match", async () => {
    const a = await newAgent();
    const b = await newAgent();
    const c = await newAgent();
    const matchId = await matchUp(a, b);
    expect((await call(c.client, "send_message", { match_id: matchId, body: "hi" })).isError).toBe(true);
    expect((await call(c.client, "get_conversation", { match_id: matchId })).isError).toBe(true);
  });

  it("caps message length", async () => {
    const a = await newAgent();
    const b = await newAgent();
    const matchId = await matchUp(a, b);
    const res = await call(a.client, "send_message", { match_id: matchId, body: "x".repeat(2001) });
    expect(res.isError).toBe(true);
  });

  it("rate-limits a flood of messages in one conversation", async () => {
    const a = await newAgent();
    const b = await newAgent();
    const matchId = await matchUp(a, b);
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await call(a.client, "send_message", { match_id: matchId, body: `m${i}` }));
    expect(results.filter((r) => r.isError).length).toBeGreaterThan(0);
    expect(results.slice(0, 10).every((r) => !r.isError)).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { format } from "../src/log.ts";
import { baseUrl, call, connect, matchUp, newAgent } from "./helpers.ts";

describe("log line format (ADR-0028)", () => {
  it("is one JSON line, with a timestamp and the event", () => {
    const line = format("mcp", { actor: "ada", tool: "swipe" }, Date.UTC(2026, 9, 14));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ ts: "2026-10-14T00:00:00.000Z", event: "mcp", actor: "ada", tool: "swipe" });
  });

  it("never carries credentials or agent-written text, whatever the caller passes", () => {
    const line = format("mcp", {
      actor: "ada",
      token: "tok_abcdefghijklmnop",
      authorization: "Bearer tok_abcdefghijklmnop",
      body: "a private message",
      bio: "my bio",
      reason: "my goodbye",
      error: "bad token tok_abcdefghijklmnop given",
    });
    expect(line).not.toMatch(/abcdefghijklmnop|private message|my bio|my goodbye/);
    expect(JSON.parse(line).error).toBe("bad token tok_[redacted] given");
  });

  it("cannot be used to forge a second line, and clips long values", () => {
    const line = format("http", { path: `/x\n{"event":"admin"}`, error: "y".repeat(5000) });
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).error.length).toBeLessThanOrEqual(201);
  });
});

// Needs the app's stdout in a file: start it with `node src/server.ts > /tmp/app.log` and pass APP_LOG.
// In CI the container's output is not a file, so this is skipped there; the format spec above still runs.
describe.skipIf(!process.env.APP_LOG)("what the running app logs", () => {
  const lines = (): any[] =>
    readFileSync(process.env.APP_LOG!, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

  it("says which agent made each call, with the match and outcome", async () => {
    const a = await newAgent("logger");
    const b = await newAgent("logged");
    const matchId = await matchUp(a, b);
    await call(a.client, "send_message", { match_id: matchId, body: "a secret sweet nothing" });
    await settle();
    const mine = lines().filter((l) => l.event === "mcp" && l.actor === a.handle);
    expect(mine.find((l) => l.tool === "swipe" && l.target === b.handle)).toMatchObject({ direction: "like", outcome: "ok" });
    expect(mine.find((l) => l.tool === "send_message")).toMatchObject({ match_id: matchId, outcome: "ok" });
    expect(lines().find((l) => l.tool === "register" && l.actor === a.handle)).toMatchObject({ outcome: "ok" });
  });

  it("records an outsider's attempt on someone else's match as denied, naming who tried", async () => {
    const a = await newAgent("ma");
    const b = await newAgent("mb");
    const c = await newAgent("snoop");
    const matchId = await matchUp(a, b);
    expect((await call(c.client, "get_conversation", { match_id: matchId })).isError).toBe(true);
    await settle();
    const hit = lines().find((l) => l.event === "mcp" && l.actor === c.handle && l.tool === "get_conversation");
    expect(hit).toMatchObject({ outcome: "denied", match_id: matchId });
  });

  it("logs a bad token as an auth failure without writing the token", async () => {
    const bad = "tok_thisIsNotARealTokenButLooksLikeOne123";
    const client = await connect(bad).catch(() => null);
    await client?.close();
    await settle();
    expect(lines().some((l) => l.event === "auth" && l.outcome === "invalid_token")).toBe(true);
    expect(readFileSync(process.env.APP_LOG!, "utf8")).not.toContain("thisIsNotARealToken");
  });

  it("never writes a real token or a message body, and logs web requests with status", async () => {
    const a = await newAgent("clean");
    const b = await newAgent("clean2");
    const matchId = await matchUp(a, b);
    await call(a.client, "send_message", { match_id: matchId, body: "needle-in-the-haystack-body" });
    await fetch(new URL("/nope-not-here", baseUrl()));
    await settle();
    const raw = readFileSync(process.env.APP_LOG!, "utf8");
    expect(raw).not.toContain("needle-in-the-haystack-body");
    expect(raw).not.toContain(a.token);
    expect(lines().find((l) => l.event === "http" && l.path === "/nope-not-here")).toMatchObject({ method: "GET", status: 404 });
  });
});

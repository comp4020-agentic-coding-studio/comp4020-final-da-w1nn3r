import { describe, expect, it } from "vitest";
import { call, matchUp, newAgent, baseUrl } from "./helpers.ts";

const get = (path: string): Promise<Response> => fetch(new URL(path, baseUrl()));

describe("spectator pages", () => {
  it("render for every public route", async () => {
    for (const path of ["/", "/agents", "/matches", "/feed", "/connect", "/healthz"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
  });

  it("show an agent and a full conversation to humans", async () => {
    const a = await newAgent("alice");
    const b = await newAgent("bob");
    const matchId = await matchUp(a, b);
    await call(a.client, "send_message", { match_id: matchId, body: "spectators can read this" });

    expect(await (await get(`/agents/${a.handle}`)).text()).toContain(a.handle);
    const transcript = await (await get(`/matches/${matchId}`)).text();
    expect(transcript).toContain("spectators can read this");
    // transcripts and the match list update themselves from the event stream
    expect(transcript).toContain("/static/feed.js");
    expect(await (await get("/matches")).text()).toContain("/static/feed.js");
    expect(await (await get("/feed")).text()).toContain(`${a.handle} messaged ${b.handle}`);
  });

  it("shows a green online dot for an agent that was just active", async () => {
    const a = await newAgent("dot");
    const profile = await (await get(`/agents/${a.handle}`)).text();
    expect(profile).toMatch(/class="presence on"[^>]*data-handle="[^"]*"/);
    expect(profile).toContain("online now");
    const list = await (await get("/agents")).text();
    expect(list).toContain(`data-handle="${a.handle}"`);
    expect(list).toMatch(new RegExp(`class="presence on" data-handle="${a.handle}"`));
    expect(await (await get("/")).text()).toMatch(/online now/);
  });

  it("serves the stylesheet and scripts from its own origin", async () => {
    const page = await (await get("/")).text();
    expect(page).not.toMatch(/style="/);
    expect(page).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    for (const [path, type] of [["/static/style.css", "text/css"], ["/static/app.js", "text/javascript"], ["/static/feed.js", "text/javascript"], ["/static/logo.png", "image/png"]]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
    }
  });

  it("404s for unknown pages", async () => {
    expect((await get("/agents/nobody_here_xyz")).status).toBe(404);
    expect((await get("/matches/99999999")).status).toBe(404);
  });

  it("hides passes (counts only)", async () => {
    const a = await newAgent();
    const b = await newAgent();
    await call(a.client, "swipe", { handle: b.handle, direction: "pass" });
    const feed = await (await get("/feed")).text();
    expect(feed).not.toMatch(new RegExp(`${a.handle}[^<]*pass`));
  });
});

describe("spectators are read-only", () => {
  const paths = ["/", "/agents", "/agents/x", "/matches", "/matches/1", "/feed", "/feed/stream", "/connect", "/readme/", "/healthz", "/anything"];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`refuses ${method} on every web route`, async () => {
      for (const path of paths) {
        const res = await fetch(new URL(path, baseUrl()), { method, body: method === "DELETE" ? undefined : "x=1" });
        expect(res.status, `${method} ${path}`).toBe(405);
      }
    });
  }
});

describe("untrusted text", () => {
  it("is escaped, and never leaks tokens", async () => {
    const a = await newAgent("xss", { bio: `<script>alert("bio")</script>` });
    const b = await newAgent("xss");
    const matchId = await matchUp(a, b);
    await call(a.client, "send_message", { match_id: matchId, body: `<img src=x onerror=alert(1)>` });

    const pages = [await (await get("/agents")).text(), await (await get(`/agents/${a.handle}`)).text(), await (await get(`/matches/${matchId}`)).text()];
    for (const body of pages) {
      expect(body).not.toContain("<script>alert");
      expect(body).not.toContain("<img src=x");
      expect(body).not.toContain(a.token);
    }
    expect(pages[1]).toContain("&lt;script&gt;");
  });

  it("is served with a locked-down content security policy", async () => {
    const csp = (await get("/")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });
});

describe("live feed", () => {
  it("streams new events over SSE", async () => {
    const ctrl = new AbortController();
    const res = await fetch(new URL("/feed/stream", baseUrl()), { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const a = await newAgent("live");
    const decoder = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.includes(a.handle)) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 5000)),
      ]);
      if (done) break;
      seen += decoder.decode(value);
    }
    ctrl.abort();
    expect(seen).toContain(`${a.handle} joined`);
  });
});

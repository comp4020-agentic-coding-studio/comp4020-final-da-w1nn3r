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

  it("404s (not 500s) for a malformed escape in an agent URL", async () => {
    expect((await get("/agents/%E0%A4%A")).status).toBe(404);
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

  it("sends the headline counters with each event, and the pages that show them are live", async () => {
    const a = await newAgent("counts");
    await newAgent("counts2"); // so there is at least one event after id 1 to replay
    const seen = await readFor(1, 1500);
    const last = seen.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).pop();
    expect(last.stats.agents).toBeGreaterThanOrEqual(1);
    expect(last.stats.online).toBeGreaterThanOrEqual(1);
    const home = await (await get("/")).text();
    expect(home).toContain('data-stat="agents"');
    expect(home).toContain("/static/feed.js");
    const agents = await (await get("/agents")).text();
    expect(agents).toContain("/static/feed.js");
    expect(agents).toContain(a.handle);
  });

  // Reads whatever the stream sends in its first `ms` milliseconds.
  async function readFor(lastEventId: number, ms: number): Promise<string> {
    const ctrl = new AbortController();
    const res = await fetch(new URL("/feed/stream", baseUrl()), { signal: ctrl.signal, headers: { "last-event-id": String(lastEventId) } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), stop - Date.now())),
      ]);
      if (done) break;
      seen += decoder.decode(value);
    }
    ctrl.abort();
    return seen;
  }

  it("replays events missed since Last-Event-ID on reconnect", async () => {
    const a = await newAgent("replay");
    const feed = await (await get("/feed")).text();
    const id = Number(feed.match(new RegExp(`data-id="(\\d+)"><time>[^<]*</time> <a [^>]*>${a.handle} joined`))?.[1]);
    expect(id).toBeGreaterThan(0);
    expect(await readFor(id - 1, 1000)).toContain(`${a.handle} joined`);
  });

  it("caps the replay for a very old Last-Event-ID", async () => {
    const seen = await readFor(1, 1000);
    expect(seen.match(/^id: /gm)?.length ?? 0).toBeLessThanOrEqual(100);
  });
});

import { describe, expect, it } from "vitest";
import { call, humanCookie, matchUp, newAgent, baseUrl } from "./helpers.ts";

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

  it("shows an ended conversation as ended, with who ended it and why, escaped", async () => {
    const a = await newAgent("endr");
    const b = await newAgent("endee");
    const matchId = await matchUp(a, b);
    await call(a.client, "end_conversation", { match_id: matchId, reason: "<script>alert(1)</script> bye" });

    const transcript = await (await get(`/matches/${matchId}`)).text();
    expect(transcript).toContain("ended this conversation");
    expect(transcript).toContain("&lt;script&gt;alert(1)&lt;/script&gt; bye");
    expect(transcript).not.toContain("<script>alert(1)");
    expect(await (await get("/matches")).text()).toContain('badge ended');
    expect(await (await get(`/agents/${b.handle}`)).text()).toContain('badge ended');
    expect(await (await get("/feed")).text()).toContain(`${a.handle} ended the conversation with ${b.handle}`);
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

describe("agent directory and home page (ADR-0048)", () => {
  // Display names are unique per run so a search finds only this test's agents.
  const tag = Math.random().toString(36).slice(2, 7);
  const cards = (html: string): string[] => [...html.matchAll(/data-handle="([^"]+)"/g)].map((m) => m[1]);

  it("searches by name or handle, and filters by actions taken", async () => {
    const busy = await newAgent("busy", { display_name: `Zed Busy ${tag}` });
    const idle = await newAgent("idle", { display_name: `Amy Idle ${tag}` });
    await call(busy.client, "swipe", { handle: idle.handle, direction: "pass" });

    const all = cards(await (await get(`/agents?q=${tag}`)).text());
    expect(all).toContain(busy.handle);
    expect(all).toContain(idle.handle);
    expect(cards(await (await get(`/agents?q=${idle.handle}`)).text())).toEqual([idle.handle]);

    expect(cards(await (await get(`/agents?q=${tag}&activity=none`)).text())).toEqual([idle.handle]);
    expect(cards(await (await get(`/agents?q=${tag}&activity=active`)).text())).toEqual([busy.handle]);
    expect(cards(await (await get(`/agents?q=${tag}&sort=name`)).text())).toEqual([idle.handle, busy.handle]);
    expect(cards(await (await get(`/agents?q=${tag}&sort=actions`)).text())[0]).toBe(busy.handle);
    expect(cards(await (await get(`/agents?q=${tag}&seen=online`)).text()).sort()).toEqual([busy.handle, idle.handle].sort());
    expect(cards(await (await get(`/agents?q=${tag}&seen=older`)).text())).toEqual([]);
    expect(await (await get(`/agents?q=${busy.handle}`)).text()).toContain("1 action");
  });

  it("treats the search as text, ignores unknown filter values, and keeps the form escaped", async () => {
    for (const q of ["%", "_", "' OR 1=1 --", "\\"]) {
      const res = await get(`/agents?q=${encodeURIComponent(q)}&seen=bogus&sort=DROP`);
      expect(res.status, q).toBe(200);
    }
    const page = await (await get(`/agents?q=${encodeURIComponent('"><script>x</script>')}`)).text();
    expect(page).not.toContain("<script>x</script>");
    expect(page).toContain('method="get"');
    expect((await get("/agents")).headers.get("content-security-policy")).toContain("form-action 'self'");
  });

  it("says how many are online while anyone is, and falls back to last activity", async () => {
    await newAgent("pres");
    const home = await (await get("/")).text();
    expect(home).toMatch(/<span class="eyebrow" data-when="online">/);
    expect(home).toContain("online now");
    // The fallback is always in the page, hidden while anyone is online, so the browser can switch to it.
    expect(home).toMatch(/<h2 class="feed-head">Happening now <span class="quiet" data-when="offline" hidden>no agents online &middot; last activity <span data-since="\d+">/);
    // Said once: the stat row holds totals only, not a second presence tile (ADR-0049).
    expect(home.match(/data-stat="online"/g)).toHaveLength(1);
  });

  it("shows the longest conversations on the home page, with previews cut at a word", async () => {
    const a = await newAgent("long");
    const b = await newAgent("long");
    const matchId = await matchUp(a, b);
    const words = "lighthouse ".repeat(20).trim();
    await call(a.client, "send_message", { match_id: matchId, body: words });
    const matches = await (await get("/matches")).text();
    // Whole words only, then an ellipsis: never a word cut in half.
    expect(matches).toMatch(/<p>(lighthouse ){5,}lighthouse…<\/p>/);
    expect(matches).not.toMatch(/ lighth?o?u?s?…/);
    expect(await (await get("/")).text()).toContain("Featured conversations");
  });
});

describe("website polish (ADR-0049)", () => {
  it("shows times as relative <time> elements with the exact UTC time kept", async () => {
    const a = await newAgent("when");
    const b = await newAgent("when");
    const matchId = await matchUp(a, b);
    await call(a.client, "send_message", { match_id: matchId, body: "what time is it" });
    const stampRe = /<time datetime="\d{4}-\d\d-\d\dT[\d:.]+Z" title="[\d-]+ [\d:]+ UTC" data-since="\d+">(just now|\d+[mhd] ago)<\/time>/;
    for (const path of [`/matches/${matchId}`, `/agents/${a.handle}`, "/feed", "/"]) {
      const html = await (await get(path)).text();
      expect(html, path).toMatch(stampRe);
      expect(html, path).not.toMatch(/<time>\d{4}-/);
    }
  });

  it("falls back to the name's first letter when the avatar emoji is missing or mangled", async () => {
    const q = await newAgent("qmark", { display_name: "Quill Mangled", emoji: "??" });
    const ok = await newAgent("emoji", { emoji: "🦊" });
    const page = await (await get(`/agents/${q.handle}`)).text();
    expect(page).toContain('<span class="avatar initial" aria-hidden="true">Q</span>');
    expect(page).not.toContain('<span class="avatar">??</span>');
    // A real emoji is stored and shown unchanged: the "??" comes from the client, not from saving.
    expect(await (await get(`/agents/${ok.handle}`)).text()).toContain('<span class="avatar">🦊</span>');
    expect(await (await get(`/agents?q=${q.handle}`)).text()).toContain('avatar initial');
  });

  it("shows one emoji on a two-emoji avatar and the colour the agent picked (ADR-0065)", async () => {
    const two = await newAgent("two", { emoji: "🦊🐙", color: "#7c3aed" });
    const page = await (await get(`/agents/${two.handle}`)).text();
    expect(page).toContain('<span class="avatar custom" style="background:#7c3aed">🦊</span>');
    expect(page).not.toContain("🐙");
    // A colour that is not #rrggbb is refused, so it can never reach a style attribute.
    const bad = await call(two.client, "update_profile", { color: 'red;" onmouseover="x' });
    expect(bad.isError).toBe(true);
  });

  it("explains a 404 and links back, naming the missing agent or match, escaped", async () => {
    const res = await get("/agents/nobody_here_xyz");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("No agent called @nobody_here_xyz");
    expect(html).toContain('href="/agents?q=nobody_here_xyz"');
    const evil = await (await get(`/agents/${encodeURIComponent("<b>x</b>")}`)).text();
    expect(evil).toContain("No agent called @&lt;b&gt;x&lt;/b&gt;");
    expect(evil).not.toContain("<b>x</b>");
    const match = await get("/matches/99999999");
    expect(match.status).toBe(404);
    expect(await match.text()).toContain("No conversation #99999999");
    const other = await get("/no/such/page");
    expect(other.status).toBe(404);
    const body = await other.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('href="/"');
  });

  it("serves a small logo, a 2x logo and a favicon", async () => {
    const logo = await get("/static/logo.png");
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect((await logo.arrayBuffer()).byteLength).toBeLessThan(10_000);
    const retina = await get("/static/logo@2x.png");
    expect(retina.status).toBe(200);
    expect((await retina.arrayBuffer()).byteLength).toBeLessThan(20_000);
    const ico = await get("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    expect(new Uint8Array(await ico.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));
    const home = await (await get("/")).text();
    expect(home).toContain('srcset="/static/logo@2x.png 2x"');
    expect(home).toContain('<link rel="icon" href="/favicon.ico"');
  });

  it("features conversations by length when they are equally recent", async () => {
    // Both new here, so recency ties; the longer one must rank first, and each needs 4+ messages to count.
    const [a, b, c, d] = await Promise.all(["feat", "feat", "feat", "feat"].map((p) => newAgent(p)));
    const long = await matchUp(a, b);
    const short = await matchUp(c, d);
    for (let i = 0; i < 6; i++) await call(i % 2 ? b.client : a.client, "send_message", { match_id: long, body: `long ${i}` });
    for (let i = 0; i < 4; i++) await call(i % 2 ? d.client : c.client, "send_message", { match_id: short, body: `short ${i}` });
    const home = await (await get("/")).text();
    const featured = home.slice(home.indexOf("Featured conversations"), home.indexOf("Happening now"));
    const ids = [...featured.matchAll(/href="\/matches\/(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids).toContain(long);
    if (ids.includes(short)) expect(ids.indexOf(long)).toBeLessThan(ids.indexOf(short));
  });
});

describe("model filters, match header, replay and connect page (ADR-0051, ADR-0052)", () => {
  const tag = Math.random().toString(36).slice(2, 7);
  const cards = (html: string): string[] => [...html.matchAll(/data-handle="([^"]+)"/g)].map((m) => m[1]);
  const matchIds = (html: string): number[] => [...html.matchAll(/<a href="\/matches\/(\d+)">/g)].map((m) => Number(m[1]));

  it("filters agents and matches by model, and sorts matches by message count", async () => {
    const mA = `spec-model-a-${tag}`, mB = `spec-model-b-${tag}`;
    const a = await newAgent("mdl", { model: mA });
    const b = await newAgent("mdl", { model: mB });
    const c = await newAgent("mdl", { model: mB });
    const ab = await matchUp(a, b);
    const bc = await matchUp(b, c);
    await call(b.client, "send_message", { match_id: bc, body: "one" });
    await call(c.client, "send_message", { match_id: bc, body: "two" });

    const agents = await (await get("/agents")).text();
    expect(agents).toContain(`<option value="${mA}">`);
    expect(cards(await (await get(`/agents?model=${mA}`)).text())).toEqual([a.handle]);
    expect(cards(await (await get(`/agents?model=${mB}`)).text()).sort()).toEqual([b.handle, c.handle].sort());

    expect(matchIds(await (await get(`/matches?model=${mA}`)).text())).toEqual([ab]);
    expect(matchIds(await (await get(`/matches?model=${mB}&sort=messages`)).text())).toEqual([bc, ab]);
    expect(matchIds(await (await get(`/matches?model=${mA}&with=${mB}`)).text())).toEqual([ab]);
    expect(matchIds(await (await get(`/matches?model=${mB}&with=${mB}`)).text())).toEqual([bc]);
    expect(matchIds(await (await get(`/matches?model=${mB}&status=ended`)).text())).toEqual([]);
    const list = await (await get(`/matches?model=${mA}`)).text();
    expect(list).toContain(`model: ${mA} &amp; ${mB}`);
    expect(list).toContain('method="get" action="/matches"');
  });

  it("ignores unknown sorts and models, and escapes model names in the dropdown", async () => {
    await newAgent("mdlx", { model: `<b>x${tag}</b>` });
    for (const q of ["sort=DROP%20TABLE", "model=no-such-model", "status=bogus&with=%27%20OR%201%3D1", "sort=id;DELETE"]) {
      const res = await get(`/matches?${q}`);
      expect(res.status, q).toBe(200);
      expect((await get(`/agents?${q}`)).status, q).toBe(200);
    }
    // An unknown model is ignored, so the list is unfiltered rather than empty.
    expect(await (await get("/matches?model=no-such-model")).text()).not.toContain("No conversations match");
    const agents = await (await get("/agents")).text();
    expect(agents).not.toContain(`<b>x${tag}</b>`);
    expect(agents).toContain(`&lt;b&gt;x${tag}&lt;/b&gt;`);
    for (const path of ["/matches?sort=messages", "/agents?model=x"]) expect((await fetch(new URL(path, baseUrl()), { method: "POST", body: "x=1" })).status).toBe(405);
  });

  it("shows both agents' avatars, names and models in the match header, escaped", async () => {
    const a = await newAgent("hdr", { model: `<i>mdl</i>`, display_name: `Ann <b>${tag}</b>`, emoji: "🦊" });
    const b = await newAgent("hdr", { model: "plain-model", emoji: "🐙" });
    const id = await matchUp(a, b);
    const page = await (await get(`/matches/${id}`)).text();
    expect(page).toContain('<div class="duo">');
    expect(page).toContain("🦊");
    expect(page).toContain("🐙");
    expect(page).toContain("model: &lt;i&gt;mdl&lt;/i&gt;");
    expect(page).toContain("model: plain-model");
    expect(page).toContain(`Ann &lt;b&gt;${tag}&lt;/b&gt;`);
    expect(page).not.toContain("<i>mdl</i>");
  });

  it("offers a replay with each message's original time, and no extra stream", async () => {
    const a = await newAgent("rpl");
    const b = await newAgent("rpl");
    const id = await matchUp(a, b);
    const one = await (await get(`/matches/${id}`)).text();
    expect(one).not.toContain("data-replay");
    await call(a.client, "send_message", { match_id: id, body: "first" });
    await call(b.client, "send_message", { match_id: id, body: "second" });
    const page = await (await get(`/matches/${id}`)).text();
    // Hidden until app.js shows it, so a page without JavaScript just has the full transcript.
    expect(page).toMatch(/<div class="replay" id="replay" data-replay hidden>/);
    expect(page).toContain("Replay this conversation");
    const at = [...page.matchAll(/class="msg [a-z]+" data-at="(\d+)"/g)].map((m) => Number(m[1]));
    expect(at).toHaveLength(2);
    expect(at[1]).toBeGreaterThanOrEqual(at[0]);
    expect(page).not.toMatch(/stream/i);
    const js = await (await get("/static/app.js")).text();
    expect(js).toContain("data-replay");
    expect(js).toContain("reduce");
    // The quiet-time offer is on the home page and the feed, hidden while anyone is online.
    for (const path of ["/", "/feed"]) expect(await (await get(path)).text()).toMatch(/class="replay-offer glass" data-when="offline" hidden>.*href="\/matches\/\d+#replay"/);
  });

  it("explains the terms and offers both ways to connect up front", async () => {
    const page = await (await get("/connect")).text();
    for (const term of ["MCP (Model Context Protocol)", "Streamable HTTP", "Harness", "API token"]) expect(page).toContain(`<dt>${term}`);
    const harness = page.indexOf('href="#harness" data-tab="harness"');
    const mcp = page.indexOf('href="#mcp" data-tab="mcp"');
    expect(harness).toBeGreaterThan(0);
    expect(mcp).toBeGreaterThan(0);
    // Both choices sit above both sections, and both sections are in the page without JavaScript.
    expect(mcp).toBeLessThan(page.indexOf('id="harness"'));
    expect(page).toMatch(/<section class="path-panel" id="mcp" data-panel="mcp">/);
    expect(page).toMatch(/<section class="path-panel" id="harness" data-panel="harness">/);
    expect(page).not.toMatch(/path-panel"[^>]* hidden/);
    expect(page).toContain("&quot;mcpServers&quot;");
    expect(page).toContain("/harness/install.ps1 | iex");
    expect(page).toContain("--auto");
    expect(page).toContain("--check");
    expect(page).not.toContain("look for an API token you saved");
  });
});

describe("spectators are read-only", () => {
  const paths = ["/", "/agents", "/agents/x", "/matches", "/matches/1", "/feed", "/feed/stream", "/connect", "/readme/", "/healthz", "/robots.txt", "/llms.txt", "/human/verify", "/anything"];
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
    const res = await fetch(new URL("/feed/stream", baseUrl()), { signal: ctrl.signal, headers: { cookie: await humanCookie() } });
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
    const res = await fetch(new URL("/feed/stream", baseUrl()), { signal: ctrl.signal, headers: { "last-event-id": String(lastEventId), cookie: await humanCookie() } });
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
    const id = Number(feed.match(new RegExp(`data-id="(\\d+)"><time [^>]*>[^<]*</time> <a [^>]*>${a.handle} joined`))?.[1]);
    expect(id).toBeGreaterThan(0);
    expect(await readFor(id - 1, 1000)).toContain(`${a.handle} joined`);
  });

  it("caps the replay for a very old Last-Event-ID", async () => {
    const seen = await readFor(1, 1000);
    expect(seen.match(/^id: /gm)?.length ?? 0).toBeLessThanOrEqual(100);
  });
});

describe("human check (ADR-0036)", () => {
  it("refuses the live stream without it, and leaves the pages open", async () => {
    expect((await get("/feed/stream")).status).toBe(403);
    expect((await get("/")).status).toBe(200);
    expect((await get("/readme/")).status).toBe(200);
  });

  it("lets the stream through after a solved challenge", async () => {
    const ctrl = new AbortController();
    const res = await fetch(new URL("/feed/stream", baseUrl()), { signal: ctrl.signal, headers: { cookie: await humanCookie() } });
    expect(res.status).toBe(200);
    ctrl.abort();
  });

  it("rejects a wrong or forged solution", async () => {
    const { challenge } = (await (await get("/human/challenge")).json()) as { challenge: string };
    expect((await get(`/human/verify?c=${encodeURIComponent(challenge)}&n=0x`)).status).toBe(400);
    expect((await get(`/human/verify?c=forged.${"0".repeat(16)}.${"0".repeat(64)}&n=1`)).status).toBe(400);
    expect((await get("/feed/stream")).status).toBe(403);
  });

  it("does not accept a forged cookie", async () => {
    const res = await fetch(new URL("/feed/stream", baseUrl()), { headers: { cookie: `human=${Date.now() + 1e9}.${"a".repeat(64)}` } });
    expect(res.status).toBe(403);
  });
});

describe("bots files (ADR-0036)", () => {
  it("serves robots.txt that keeps crawlers off the write surfaces", async () => {
    const res = await get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    for (const p of ["/admin", "/mcp", "/feed/stream"]) expect(body).toContain(`Disallow: ${p}`);
  });

  it("serves llms.txt that points agents at the MCP endpoint", async () => {
    const body = await (await get("/llms.txt")).text();
    expect(body).toContain("/mcp");
    expect(body).toContain("/connect");
  });
});

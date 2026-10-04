import { describe, expect, it } from "vitest";
import { baseUrl, call, connect, matchUp, newAgent } from "./helpers.ts";

// The admin UI (ADR-0018) only exists when the app runs with ADMIN_TOKEN; these tests
// need the same ADMIN_TOKEN in their environment and are skipped without it.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const auth = { authorization: `Basic ${Buffer.from(`admin:${ADMIN_TOKEN}`).toString("base64")}` };
const url = (path: string): URL => new URL(path, baseUrl());

const adminGet = (path: string) => fetch(url(path), { headers: auth, redirect: "manual" });
async function csrfFrom(path: string): Promise<string> {
  const html = await (await adminGet(path)).text();
  const m = html.match(/name="csrf" value="([0-9a-f]+)"/);
  if (!m) throw new Error(`no csrf token on ${path}`);
  return m[1];
}
const adminPost = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url(path), { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form), redirect: "manual" });

describe.skipIf(!ADMIN_TOKEN)("admin UI", () => {
  it("requires the admin password", async () => {
    expect((await fetch(url("/admin"))).status).toBe(401);
    const wrong = { authorization: `Basic ${Buffer.from("admin:nope").toString("base64")}` };
    expect((await fetch(url("/admin"), { headers: wrong })).status).toBe(401);
    expect((await fetch(url("/admin/agents/x"), { method: "POST", body: "x=1" })).status).toBe(401);
    expect((await adminGet("/admin")).status).toBe(200);
  });

  it("refuses POSTs without a valid CSRF token or from another origin", async () => {
    const a = await newAgent("adm");
    expect((await adminPost(`/admin/agents/${a.handle}/delete`, { confirm: a.handle })).status).toBe(403);
    const csrf = await csrfFrom(`/admin/agents/${a.handle}`);
    expect((await adminPost(`/admin/agents/${a.handle}/delete`, { csrf, confirm: a.handle }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await adminGet(`/admin/agents/${a.handle}`)).status).toBe(200); // still there
  });

  it("escapes agent-written text", async () => {
    const a = await newAgent("adm", { bio: `<script>alert("bio")</script>` });
    const body = await (await adminGet(`/admin/agents/${a.handle}`)).text();
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;");
  });

  it("resets a token: old one stops working, new one works, profile survives", async () => {
    const a = await newAgent("adm");
    const csrf = await csrfFrom(`/admin/agents/${a.handle}`);
    const res = await adminPost(`/admin/agents/${a.handle}/reset-token`, { csrf });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const token = (await res.text()).match(/tok_[A-Za-z0-9_-]+/)?.[0];
    expect(token).toBeTruthy();
    await expect(connect(a.token).then((c) => call(c, "whoami"))).rejects.toThrow();
    const me = await call(await connect(token), "whoami");
    expect(me.isError).toBe(false);
    expect(JSON.stringify(me.data)).toContain(a.handle);
    expect(await (await fetch(url("/admin"), { headers: auth })).text()).not.toContain(token!);
  });

  it("deletes a message, then an agent only when the handle is confirmed", async () => {
    const a = await newAgent("adm");
    const b = await newAgent("adm");
    const matchId = await matchUp(a, b);
    await call(a.client, "send_message", { match_id: matchId, body: "remove me please" });
    expect(await (await fetch(url(`/matches/${matchId}`))).text()).toContain("remove me please");

    let csrf = await csrfFrom(`/admin/agents/${a.handle}`);
    const page = await (await adminGet(`/admin/agents/${a.handle}`)).text();
    const msgId = page.match(/\/admin\/messages\/(\d+)\/delete/)![1];
    expect((await adminPost(`/admin/messages/${msgId}/delete`, { csrf, back: a.handle })).status).toBe(303);
    expect(await (await fetch(url(`/matches/${matchId}`))).text()).not.toContain("remove me please");

    expect((await adminPost(`/admin/agents/${a.handle}/delete`, { csrf, confirm: "wrong" })).status).toBe(303);
    expect((await fetch(url(`/agents/${a.handle}`))).status).toBe(200);
    csrf = await csrfFrom(`/admin/agents/${a.handle}`);
    expect((await adminPost(`/admin/agents/${a.handle}/delete`, { csrf, confirm: a.handle })).status).toBe(303);
    expect((await fetch(url(`/agents/${a.handle}`))).status).toBe(404);
    expect((await fetch(url(`/matches/${matchId}`))).status).toBe(404);
    expect((await fetch(url(`/agents/${b.handle}`))).status).toBe(200); // partner untouched
  });
});

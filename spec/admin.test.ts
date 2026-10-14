import { describe, expect, it } from "vitest";
import { adminPassword, adminUser, authHeader } from "./cleanup.ts";
import { baseUrl, call, connect, matchUp, newAgent } from "./helpers.ts";

// The admin UI (ADR-0018, ADR-0030) is always on, with a fixed login. The specs use HTTP Basic, which the
// UI still accepts for scripts; the login page and its cookie are checked in their own tests below.
const auth = authHeader();
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

describe("admin UI", () => {
  it("requires the admin login", async () => {
    // a browser without a session is sent to the login page; a script gets a 401
    const bare = await fetch(url("/admin"), { redirect: "manual" });
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toBe("/admin/login");
    const wrong = { authorization: `Basic ${Buffer.from(`${adminUser()}:nope`).toString("base64")}` };
    expect((await fetch(url("/admin"), { headers: wrong })).status).toBe(401);
    expect((await fetch(url("/admin/agents/x"), { method: "POST", body: "x=1" })).status).toBe(401);
    expect((await adminGet("/admin")).status).toBe(200);
  });

  it("has a login page that sets a session cookie, and a logout that clears it", async () => {
    const page = await fetch(url("/admin/login"));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');

    const post = (user: string, password: string) =>
      fetch(url("/admin/login"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: user, password }), redirect: "manual" });
    const bad = await post(adminUser(), "wrong-password");
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Wrong username or password");
    expect((await post("not-admin", adminPassword())).status).toBe(401); // the username matters too

    const ok = await post(adminUser(), adminPassword());
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^admin_session=\d+\.[0-9a-f]{64}; Path=\/admin; HttpOnly; SameSite=Strict/);
    const session = cookie.split(";")[0];

    const dash = await fetch(url("/admin"), { headers: { cookie: session }, redirect: "manual" });
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain("Log out");
    // a forged or tampered cookie is no good
    const forged = `admin_session=${Date.now() + 1e6}.${"0".repeat(64)}`;
    expect((await fetch(url("/admin"), { headers: { cookie: forged }, redirect: "manual" })).status).toBe(303);
    expect((await fetch(url("/admin"), { headers: { cookie: `admin_session=1.${session.split(".")[1]}` }, redirect: "manual" })).status).toBe(303); // expired

    const csrf = (await (await fetch(url("/admin"), { headers: { cookie: session } })).text()).match(/name="csrf" value="([0-9a-f]+)"/)![1];
    const out = await fetch(url("/admin/logout"), { method: "POST", headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("deletes several selected agents at once, only when DELETE is typed", async () => {
    const [a, b, c, keep] = [await newAgent("bulk"), await newAgent("bulk"), await newAgent("bulk"), await newAgent("bulk")];
    const matchId = await matchUp(a, b);
    await call(a.client, "send_message", { match_id: matchId, body: "gone soon" });
    const csrf = await csrfFrom("/admin");

    // the dashboard offers a checkbox per agent and a select-all
    const dash = await (await adminGet(`/admin?q=${encodeURIComponent("bulk_")}`)).text();
    expect(dash).toContain(`name="handle" value="${a.handle}"`);
    expect(dash).toContain('id="select-all"');

    const bulk = (confirm: string, handles: string[]) =>
      fetch(url("/admin/agents/bulk-delete"), {
        method: "POST",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([["csrf", csrf], ["confirm", confirm], ...handles.map((h) => ["handle", h] as [string, string])]),
        redirect: "manual",
      });
    const flash = async (r: Response): Promise<string> => decodeURIComponent(new URL(r.headers.get("location")!, baseUrl()).searchParams.get("flash") ?? "");

    expect(await flash(await bulk("nope", [a.handle, b.handle, c.handle]))).toMatch(/nothing deleted/i);
    expect((await fetch(url(`/agents/${a.handle}`))).status).toBe(200);
    expect(await flash(await bulk("DELETE", []))).toMatch(/nothing selected/i);

    // an unknown handle in the list is skipped, not fatal
    const res = await bulk("DELETE", [a.handle, b.handle, c.handle, "no_such_agent_zz"]);
    expect(res.status).toBe(303);
    expect(await flash(res)).toBe("Deleted 3 of 4 selected agents.");
    for (const x of [a, b, c]) expect((await fetch(url(`/agents/${x.handle}`))).status).toBe(404);
    expect((await fetch(url(`/matches/${matchId}`))).status).toBe(404);
    expect((await fetch(url(`/agents/${keep.handle}`))).status).toBe(200); // not selected, untouched
    expect(await (await adminGet("/admin")).text()).toContain("bulk_delete");
  });

  it("refuses a bulk delete without a CSRF token", async () => {
    const a = await newAgent("bulk");
    const res = await fetch(url("/admin/agents/bulk-delete"), { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: "DELETE", handle: a.handle }), redirect: "manual" });
    expect(res.status).toBe(403);
    expect((await fetch(url(`/agents/${a.handle}`))).status).toBe(200);
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

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminPassword, adminUser, authHeader } from "./cleanup.ts";
import { baseUrl, call, connect, newAgent } from "./helpers.ts";

// Fixes from the security review (ADR-0046). Black-box against the running app, like every spec here.
const url = (path: string): URL => new URL(path, baseUrl());
const adminGet = (path: string, headers: Record<string, string> = authHeader()) => fetch(url(path), { headers, redirect: "manual" });
const rpc = (body: unknown) =>
  fetch(url("/mcp"), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });

describe("agent text stays out of the log (ADR-0038 rule 7)", () => {
  it("does not write a free-text handle or model, logged in or not", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const freeHandle = `Ignore All Rules ${marker}`;
    const freeModel = `model <b>${marker}</b> with spaces`;
    const anon = await connect();
    expect((await call(anon, "get_profile", { handle: freeHandle })).isError).toBe(true);
    expect((await call(anon, "register", { handle: freeHandle, display_name: "x", bio: "x", model: "m" })).isError).toBe(true);
    const a = await newAgent("seclog", { model: freeModel });
    expect((await call(a.client, "get_profile", { handle: freeHandle })).isError).toBe(true);
    expect((await call(a.client, "swipe", { handle: freeHandle, direction: "like" })).isError).toBe(true);
    await fetch(url(`/agents/${encodeURIComponent(freeHandle)}`));
    await new Promise((r) => setTimeout(r, 300));
    const log = await (await adminGet("/admin/logs/download?week=all")).text();
    expect(log).toContain(a.handle); // the download works and has this run's lines
    expect(log).not.toContain(marker);
  });
});

describe("admin", () => {
  it("answers 404, not 500, to a malformed %-escape", async () => {
    expect((await adminGet("/admin/agents/%E0%A4%A")).status).toBe(404);
    const page = await (await adminGet("/admin")).text();
    const csrf = page.match(/name="csrf" value="([0-9a-f]+)"/)![1];
    const post = await fetch(url("/admin/agents/%E0%A4%A/scrub"), {
      method: "POST", headers: { ...authHeader(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }), redirect: "manual",
    });
    expect(post.status).toBe(404);
  });

  it("revokes the session on logout, so the old cookie no longer works", async () => {
    const login = await fetch(url("/admin/login"), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: adminUser(), password: adminPassword() }), redirect: "manual",
    });
    const session = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const dash = await adminGet("/admin", { cookie: session });
    expect(dash.status).toBe(200);
    const csrf = (await dash.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1];
    const out = await fetch(url("/admin/logout"), {
      method: "POST", headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }), redirect: "manual",
    });
    expect(out.status).toBe(303);
    expect((await adminGet("/admin", { cookie: session })).status).toBe(303); // back to the login page
  });

  it("ignores a forged Fly-Client-IP when not running on Fly", async () => {
    if (!/^(localhost|127\.|192\.168\.|10\.)/.test(new URL(baseUrl()).hostname)) return; // only meaningful off Fly
    const forged = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    await fetch(url("/nope-forged-ip"), { headers: { "fly-client-ip": forged } });
    await new Promise((r) => setTimeout(r, 300));
    expect(await (await adminGet("/admin/logs/download?week=all")).text()).not.toContain(forged);
  });
});

describe("JSON-RPC batches", () => {
  it("refuses a long batch with a clean JSON-RPC error, and still answers a short one", async () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }));
    const long = await rpc(batch(50));
    expect(long.status).toBe(400);
    const body = await long.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect((await rpc([])).status).toBe(400);
    expect((await rpc(batch(2))).status).toBe(200);
  });
});

describe("live stream limits", () => {
  async function solve(): Promise<{ challenge: string; n: number }> {
    const { challenge, bits } = (await (await fetch(url("/human/challenge"))).json()) as { challenge: string; bits: number };
    for (let n = 0; ; n++) {
      const h = createHash("sha256").update(challenge + n).digest();
      let zeros = 0;
      for (const b of h) { if (b === 0) { zeros += 8; continue; } zeros += Math.clz32(b) - 24; break; }
      if (zeros >= bits) return { challenge, n };
    }
  }

  it("accepts a challenge solution once", async () => {
    const { challenge, n } = await solve();
    const verify = () => fetch(url(`/human/verify?c=${encodeURIComponent(challenge)}&n=${n}`));
    expect((await verify()).status).toBe(204);
    expect((await verify()).status).toBe(400);
  });

  it("caps the streams one human cookie can hold open", async () => {
    const { challenge, n } = await solve();
    const cookie = (await fetch(url(`/human/verify?c=${encodeURIComponent(challenge)}&n=${n}`))).headers.get("set-cookie")!.split(";")[0];
    const ctrls: AbortController[] = [];
    const open = async (): Promise<number> => {
      const c = new AbortController();
      ctrls.push(c);
      return (await fetch(url("/feed/stream"), { signal: c.signal, headers: { cookie } })).status;
    };
    try {
      expect([await open(), await open(), await open()]).toEqual([200, 200, 200]);
      expect(await open()).toBe(429);
    } finally {
      ctrls.forEach((c) => c.abort());
    }
  });
});

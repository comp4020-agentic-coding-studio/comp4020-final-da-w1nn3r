// Admin UI under /admin (ADR-0018). The only write surface besides /mcp, so it is
// deliberately small: one shared secret (ADMIN_TOKEN) over HTTP Basic, a CSRF token
// on every POST, a failed-login throttle, and an audit log. Everything agent-written
// is escaped on output (CLAUDE.md hard rule); tokens are never stored or logged raw.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";
import { db, tx } from "./db.ts";
import { hash, newToken } from "./service.ts";
import { STYLE } from "./theme.ts";
import { esc } from "./web.ts";

export interface AdminResponse {
  status: number;
  body: string;
  type?: string;
  headers?: Record<string, string>;
}

type Row = Record<string, unknown>;
const all = (sql: string, ...args: (string | number)[]): Row[] => db.prepare(sql).all(...args) as Row[];
const one = (sql: string, ...args: (string | number)[]): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;

export const enabled = (): boolean => config.adminToken.length > 0;
export const isAdminPath = (path: string): boolean => path === "/admin" || path.startsWith("/admin/");

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();
const csrfToken = (): string => createHmac("sha256", config.adminToken).update("admin-csrf").digest("hex");
const time = (ms: unknown): string => new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19) + " UTC";

// --- login throttle: 10 bad passwords per 15 minutes per IP, checked before comparing ---
const FAIL_LIMIT = 10;
const FAIL_WINDOW = 15 * 60_000;
const fails = new Map<string, number[]>();
const recentFails = (ip: string): number[] => {
  const now = Date.now();
  const recent = (fails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW);
  if (recent.length) fails.set(ip, recent);
  else fails.delete(ip);
  return recent;
};

function authorised(req: IncomingMessage): boolean {
  const header = String(req.headers.authorization ?? "");
  if (!header.toLowerCase().startsWith("basic ")) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(sha(password), sha(config.adminToken));
}

async function readForm(req: IncomingMessage, limit = 8 * 1024): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sameOrigin(req: IncomingMessage): boolean {
  // Browsers say outright whether a request is same-origin. Prefer that: with
  // `Referrer-Policy: no-referrer` they send `Origin: null` even for same-origin form posts.
  const site = req.headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(String(origin)).host === req.headers.host;
  } catch {
    return false;
  }
}

// --- audit ---
function audit(action: string, target: string, detail = ""): void {
  db.prepare("INSERT INTO admin_log (created_at, action, target, detail) VALUES (?, ?, ?, ?)").run(Date.now(), action, target, detail);
}

// --- actions ---
function deleteAgent(handle: string): boolean {
  const agent = one("SELECT id FROM agents WHERE handle = ?", handle);
  if (!agent) return false;
  const id = Number(agent.id);
  tx(() => {
    const matches = "SELECT id FROM matches WHERE agent_a = ? OR agent_b = ?";
    db.prepare(`DELETE FROM messages WHERE sender_id = ? OR match_id IN (${matches})`).run(id, id, id);
    db.prepare(`DELETE FROM read_state WHERE agent_id = ? OR match_id IN (${matches})`).run(id, id, id);
    db.prepare("DELETE FROM matches WHERE agent_a = ? OR agent_b = ?").run(id, id);
    db.prepare("DELETE FROM swipes WHERE swiper_id = ? OR target_id = ?").run(id, id);
    db.prepare("DELETE FROM profiles WHERE agent_id = ?").run(id);
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    db.prepare("DELETE FROM events WHERE json_extract(payload, '$.actor') = ? OR json_extract(payload, '$.target') = ?").run(handle, handle);
    audit("delete_agent", handle);
  });
  return true;
}

/** Recovery: swap in a fresh token. The agent keeps its profile, matches and messages. */
function resetToken(handle: string): string | null {
  if (!one("SELECT id FROM agents WHERE handle = ?", handle)) return null;
  const token = newToken();
  tx(() => {
    db.prepare("UPDATE agents SET token_hash = ? WHERE handle = ?").run(hash(token), handle);
    audit("reset_token", handle);
  });
  return token;
}

function scrubProfile(handle: string): boolean {
  const agent = one("SELECT id FROM agents WHERE handle = ?", handle);
  if (!agent) return false;
  tx(() => {
    db.prepare("UPDATE profiles SET display_name = ?, bio = ?, interests = '[]', looking_for = ?, emoji = '🚫', updated_at = ? WHERE agent_id = ?")
      .run(handle, "[removed by admin]", "[removed by admin]", Date.now(), Number(agent.id));
    audit("scrub_profile", handle);
  });
  return true;
}

function deleteMessage(id: number): string | null {
  const msg = one("SELECT m.id, a.handle FROM messages m JOIN agents a ON a.id = m.sender_id WHERE m.id = ?", id);
  if (!msg) return null;
  tx(() => {
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    db.prepare("DELETE FROM events WHERE type = 'message' AND json_extract(payload, '$.message_id') = ?").run(id);
    audit("delete_message", String(msg.handle), `message ${id}`);
  });
  return String(msg.handle);
}

// --- views ---
const ADMIN_CSS = `
.banner.admin{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);color:var(--fg);padding:.5rem 1.25rem;font:.85rem var(--mono)}
body{background:var(--bg)}table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font:.75rem var(--mono);text-transform:uppercase}
.stats{display:flex;flex-wrap:wrap;gap:.8rem;margin:1rem 0}.stats .stat{padding:.8rem 1.2rem}.stats b{display:block;font-size:1.6rem}
form.inline{display:inline}input[type=text],input[type=search]{padding:.5rem .8rem;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--fg);font:inherit}
button.btn{cursor:pointer;font:inherit;font-weight:600}button.danger{border-color:#ef4444;color:#ef4444}
.panel{padding:1.2rem;margin:1rem 0}.token{font:1rem var(--mono);word-break:break-all;padding:.8rem;border:1px dashed var(--accent);border-radius:12px;user-select:all}
.flash{padding:.7rem 1rem;border-radius:12px;border:1px solid var(--online);margin:1rem 0}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · admin</title><link rel="stylesheet" href="/admin/static/admin.css"></head>
<body><p class="banner admin">admin &middot; changes here are real and are written to the audit log</p>
<header class="nav"><a class="brand" href="/admin"><span class="logo-mark">&#9881;</span><span>Admin</span></a><nav><a href="/admin">Dashboard</a><a href="/">Public site</a></nav></header>
<main>${body}</main></body></html>`;
}

const csrf = (): string => `<input type="hidden" name="csrf" value="${csrfToken()}">`;
const postForm = (action: string, inner: string): string => `<form class="inline" method="post" action="${esc(action)}">${csrf()}${inner}</form>`;
const agentHref = (h: unknown): string => `/admin/agents/${encodeURIComponent(String(h))}`;

function dashboard(q: string, flash: string): string {
  const count = (t: string): number => Number(one(`SELECT COUNT(*) n FROM ${t}`)?.n ?? 0);
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const agents = all(
    `SELECT a.handle, p.model, a.created_at, a.last_seen_at,
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id = a.id) AS msgs
     FROM agents a LEFT JOIN profiles p ON p.agent_id = a.id
     WHERE a.handle LIKE ? ESCAPE '\\' OR p.model LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\'
     ORDER BY COALESCE(a.last_seen_at, a.created_at) DESC LIMIT 200`,
    like, like, like,
  );
  const rows = agents
    .map((a) => `<tr><td><a href="${agentHref(a.handle)}">@${esc(a.handle)}</a></td><td>${esc(a.model)}</td><td>${time(a.created_at)}</td><td>${a.last_seen_at ? time(a.last_seen_at) : "–"}</td><td>${Number(a.msgs)}</td></tr>`)
    .join("");
  const log = all("SELECT created_at, action, target, detail FROM admin_log ORDER BY id DESC LIMIT 25")
    .map((l) => `<tr><td>${time(l.created_at)}</td><td>${esc(l.action)}</td><td>${esc(l.target)}</td><td>${esc(l.detail)}</td></tr>`)
    .join("");
  return layout(
    "Dashboard",
    `<h1>Dashboard</h1>${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
<div class="stats">${[["Agents", count("agents")], ["Matches", count("matches")], ["Messages", count("messages")], ["Events", count("events")]]
      .map(([k, v]) => `<div class="stat"><span class="muted">${k}</span><b>${v}</b></div>`)
      .join("")}</div>
<form method="get" action="/admin"><input type="search" name="q" value="${esc(q)}" placeholder="search handle, name or model" maxlength="100"> <button class="btn" type="submit">Search</button></form>
<h2>Agents${q ? ` matching “${esc(q)}”` : ""} <span class="muted">(${agents.length}${agents.length === 200 ? "+" : ""})</span></h2>
<div class="panel"><table><thead><tr><th>Handle</th><th>Model</th><th>Registered</th><th>Last seen</th><th>Msgs</th></tr></thead><tbody>${rows || '<tr><td colspan="5">None.</td></tr>'}</tbody></table></div>
<h2>Audit log</h2><div class="panel"><table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${log || '<tr><td colspan="4">Nothing yet.</td></tr>'}</tbody></table></div>`,
  );
}

function agentView(handle: string, flash: string): AdminResponse | null {
  const a = one(
    `SELECT a.id, a.handle, a.created_at, a.last_seen_at, p.display_name, p.bio, p.interests, p.looking_for, p.emoji, p.model
     FROM agents a LEFT JOIN profiles p ON p.agent_id = a.id WHERE a.handle = ?`,
    handle,
  );
  if (!a) return null;
  const id = Number(a.id);
  const matches = all(
    `SELECT m.id, CASE WHEN m.agent_a = ? THEN b.handle ELSE x.handle END AS partner
     FROM matches m JOIN agents x ON x.id = m.agent_a JOIN agents b ON b.id = m.agent_b
     WHERE m.agent_a = ? OR m.agent_b = ? ORDER BY m.id DESC`,
    id, id, id,
  );
  const convos = matches
    .map((m) => {
      const msgs = all("SELECT m.id, a.handle sender, m.body, m.created_at FROM messages m JOIN agents a ON a.id = m.sender_id WHERE m.match_id = ? ORDER BY m.id DESC LIMIT 50", Number(m.id))
        .map((x) => `<tr><td>@${esc(x.sender)}</td><td>${esc(x.body)}</td><td>${time(x.created_at)}</td><td>${postForm(`/admin/messages/${Number(x.id)}/delete`, `<input type="hidden" name="back" value="${esc(handle)}"><button class="btn danger" type="submit">Delete</button>`)}</td></tr>`)
        .join("");
      return `<div class="panel"><h3>Match #${Number(m.id)} with @${esc(m.partner)}</h3><table><tbody>${msgs || '<tr><td>No messages.</td></tr>'}</tbody></table></div>`;
    })
    .join("");
  const h = encodeURIComponent(handle);
  return {
    status: 200,
    body: layout(
      `@${handle}`,
      `<p><a href="/admin">&larr; All agents</a></p>${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
<section class="panel"><h1>${esc(a.emoji)} ${esc(a.display_name)}</h1>
<p class="muted">@${esc(handle)} &middot; model: ${esc(a.model)} &middot; registered ${time(a.created_at)} &middot; last seen ${a.last_seen_at ? time(a.last_seen_at) : "never"}</p>
<p>${esc(a.bio)}</p><p><b>Interests:</b> ${esc(a.interests)}</p><p><b>Looking for:</b> ${esc(a.looking_for)}</p></section>
<h2>Actions</h2>
<section class="panel"><h3>Recover account</h3><p class="muted">Issues a new token and invalidates the old one. Profile, matches and messages are kept. The new token is shown once.</p>
${postForm(`/admin/agents/${h}/reset-token`, '<button class="btn primary" type="submit">Reset token</button>')}</section>
<section class="panel"><h3>Scrub profile</h3><p class="muted">Replaces display name, bio, interests and looking-for with placeholders. Keeps the account.</p>
${postForm(`/admin/agents/${h}/scrub`, '<button class="btn danger" type="submit">Scrub profile</button>')}</section>
<section class="panel"><h3>Delete agent</h3><p class="muted">Permanently removes the account, profile, swipes, matches, messages and feed events. Cannot be undone. Type the handle to confirm.</p>
${postForm(`/admin/agents/${h}/delete`, '<input type="text" name="confirm" autocomplete="off" placeholder="handle" required> <button class="btn danger" type="submit">Delete agent</button>')}</section>
<h2>Conversations</h2>${convos || '<p class="muted">No matches.</p>'}`,
    ),
  };
}

const redirect = (to: string): AdminResponse => ({ status: 303, body: "", headers: { location: to } });
const html = (status: number, body: string): AdminResponse => ({ status, body });
const flashUrl = (path: string, msg: string): string => `${path}${path.includes("?") ? "&" : "?"}flash=${encodeURIComponent(msg)}`;

/** Handles every request under /admin. Returns null when the feature is disabled so the caller can 404. */
export async function handleAdmin(req: IncomingMessage, ip: string): Promise<AdminResponse | null> {
  if (!enabled()) return null;
  const url = new URL(req.url ?? "/admin", "http://x");
  const path = url.pathname.replace(/(.)\/+$/, "$1");
  const method = req.method ?? "GET";
  const noStore = { "cache-control": "no-store", "referrer-policy": "same-origin", "content-security-policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };

  if (recentFails(ip).length >= FAIL_LIMIT) return { status: 429, body: "Too many failed attempts. Try again later.", type: "text/plain", headers: noStore };
  if (!authorised(req)) {
    fails.set(ip, [...recentFails(ip), Date.now()]);
    return { status: 401, body: "Authentication required.", type: "text/plain", headers: { ...noStore, "www-authenticate": 'Basic realm="admin", charset="UTF-8"' } };
  }

  const finish = (r: AdminResponse | null): AdminResponse => {
    const out = r ?? html(404, layout("Not found", "<h1>Not found</h1>"));
    out.headers = { ...noStore, ...out.headers };
    return out;
  };

  if (path === "/admin/static/admin.css") return finish({ status: 200, body: STYLE + ADMIN_CSS, type: "text/css; charset=utf-8" });

  let m: RegExpMatchArray | null;
  if (method === "GET" || method === "HEAD") {
    const flash = url.searchParams.get("flash") ?? "";
    if (path === "/admin") return finish(html(200, dashboard((url.searchParams.get("q") ?? "").slice(0, 100), flash)));
    if ((m = path.match(/^\/admin\/agents\/([^/]+)$/))) return finish(agentView(decodeURIComponent(m[1]), flash));
    return finish(null);
  }
  if (method !== "POST") return finish({ status: 405, body: "Method not allowed.", type: "text/plain", headers: { allow: "GET, HEAD, POST" } });

  // POST: same-origin and a CSRF token that only a page served to the admin contains.
  if (!sameOrigin(req)) return finish({ status: 403, body: "Cross-site request refused.", type: "text/plain" });
  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    return finish({ status: 400, body: "Bad form body.", type: "text/plain" });
  }
  const given = sha(form.get("csrf") ?? "");
  if (!timingSafeEqual(given, sha(csrfToken()))) return finish({ status: 403, body: "Missing or bad CSRF token. Reload the page and try again.", type: "text/plain" });

  if ((m = path.match(/^\/admin\/agents\/([^/]+)\/(delete|reset-token|scrub)$/))) {
    const handle = decodeURIComponent(m[1]);
    const back = agentHref(handle);
    if (m[2] === "delete") {
      if (form.get("confirm") !== handle) return finish(redirect(flashUrl(back, "Handle did not match; nothing deleted.")));
      return finish(deleteAgent(handle) ? redirect(flashUrl("/admin", `Deleted @${handle}.`)) : null);
    }
    if (m[2] === "scrub") return finish(scrubProfile(handle) ? redirect(flashUrl(back, "Profile scrubbed.")) : null);
    const token = resetToken(handle);
    if (!token) return finish(null);
    return finish(
      html(200, layout("New token", `<h1>New token for @${esc(handle)}</h1><p>Give this to the agent now. It is not stored and will not be shown again; the old token no longer works.</p><p class="token">${esc(token)}</p><p><a href="${back}">&larr; Back to @${esc(handle)}</a></p>`)),
    );
  }
  if ((m = path.match(/^\/admin\/messages\/(\d+)\/delete$/))) {
    const sender = deleteMessage(Number(m[1]));
    if (!sender) return finish(null);
    const back = form.get("back");
    return finish(redirect(flashUrl(back ? agentHref(back) : "/admin", `Deleted message ${m[1]} by @${sender}.`)));
  }
  return finish(null);
}

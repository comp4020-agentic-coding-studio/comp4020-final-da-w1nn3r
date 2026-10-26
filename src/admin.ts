// Admin UI under /admin (ADR-0018, ADR-0030). The only write surface besides /mcp, so it is
// deliberately small: a fixed username and password, a login page that sets a signed cookie
// (HTTP Basic still works for scripts), a CSRF token on every POST, a failed-login throttle,
// and an audit log. Everything agent-written is escaped on output (CLAUDE.md hard rule);
// tokens are never stored or logged raw.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";
import { download, weeks } from "./applog.ts";
import { db, tx } from "./db.ts";
import { log } from "./log.ts";
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

export const enabled = (): boolean => !config.adminDisabled;
export const isAdminPath = (path: string): boolean => path === "/admin" || path.startsWith("/admin/");

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();
const csrfToken = (): string => createHmac("sha256", config.adminPassword).update("admin-csrf").digest("hex");
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

const credentialsMatch = (user: string, password: string): boolean =>
  // both are always compared, so a wrong username takes as long as a wrong password
  [timingSafeEqual(sha(user), sha(config.adminUser)), timingSafeEqual(sha(password), sha(config.adminPassword))].every(Boolean);

// --- session: a signed, expiring cookie, so a machine stop does not log the admin out; logout revokes it (ADR-0046) ---
const COOKIE = "admin_session";
const SESSION_MS = 8 * 3_600_000;
const sessionKey = (): string => createHash("sha256").update(`${config.adminUser}\n${config.adminPassword}\nadmin-session`).digest("hex");
const sign = (exp: string): string => createHmac("sha256", sessionKey()).update(exp).digest("hex");

function sessionCookie(req: IncomingMessage): string {
  const exp = String(Date.now() + SESSION_MS);
  const secure = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0] === "https" ? "; Secure" : "";
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`;
}
const clearCookie = (): string => `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`;

/** The session cookie's expiry and signature when it is genuine and unexpired, else null. */
function session(req: IncomingMessage): { exp: string; sig: string } | null {
  const raw = String(req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  return timingSafeEqual(sha(sig), sha(sign(exp))) ? { exp, sig } : null;
}
// Logout revokes the cookie on the server (ADR-0046): its signature is kept, hashed, until it would expire.
const sigHash = (sig: string): string => sha(`admin-revoked\n${sig}`).toString("hex");
const hasSession = (req: IncomingMessage): boolean => {
  const s = session(req);
  return s !== null && !one("SELECT 1 AS x FROM admin_revoked WHERE sig_hash = ?", sigHash(s.sig));
};
function revokeSession(req: IncomingMessage): void {
  const s = session(req);
  db.prepare("DELETE FROM admin_revoked WHERE expires_at < ?").run(Date.now());
  if (s) db.prepare("INSERT OR IGNORE INTO admin_revoked (sig_hash, expires_at) VALUES (?, ?)").run(sigHash(s.sig), Number(s.exp));
}

/** Basic credentials in the Authorization header, for scripts (the specs, scripts/load.ts). */
function hasBasic(req: IncomingMessage): boolean {
  const header = String(req.headers.authorization ?? "");
  if (!header.toLowerCase().startsWith("basic ")) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return credentialsMatch(decoded.slice(0, i < 0 ? 0 : i), decoded.slice(i + 1));
}

const authorised = (req: IncomingMessage): boolean => hasSession(req) || hasBasic(req);

async function readForm(req: IncomingMessage, limit = 32 * 1024): Promise<URLSearchParams> {
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
// `via` is set when the action came from the dev MCP tools rather than the web UI (ADR-0037).
let via = "";
export const asMcp = <T>(fn: () => T): T => {
  via = "via mcp";
  try { return fn(); } finally { via = ""; }
};
function audit(action: string, target: string, detail = ""): void {
  detail = [detail, via].filter(Boolean).join(" ");
  db.prepare("INSERT INTO admin_log (created_at, action, target, detail) VALUES (?, ?, ?, ?)").run(Date.now(), action, target, detail);
  log("admin", { action, target }); // who did what also lands in `flyctl logs` (ADR-0028)
}

// --- actions ---
export function deleteAgent(handle: string): boolean {
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
export function resetToken(handle: string): string | null {
  if (!one("SELECT id FROM agents WHERE handle = ?", handle)) return null;
  const token = newToken();
  tx(() => {
    db.prepare("UPDATE agents SET token_hash = ? WHERE handle = ?").run(hash(token), handle);
    audit("reset_token", handle);
  });
  return token;
}

export function scrubProfile(handle: string): boolean {
  const agent = one("SELECT id FROM agents WHERE handle = ?", handle);
  if (!agent) return false;
  tx(() => {
    db.prepare("UPDATE profiles SET display_name = ?, bio = ?, interests = '[]', looking_for = ?, emoji = '🚫', updated_at = ? WHERE agent_id = ?")
      .run(handle, "[removed by admin]", "[removed by admin]", Date.now(), Number(agent.id));
    audit("scrub_profile", handle);
  });
  return true;
}

export function deleteMessage(id: number): string | null {
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
.flash.error{border-color:#ef4444}
.login{max-width:24rem;margin:3rem auto}.login label{display:block;margin:.8rem 0 .3rem;color:var(--muted);font:.8rem var(--mono)}
.login input{width:100%;box-sizing:border-box}input[type=password]{padding:.5rem .8rem;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--fg);font:inherit}
.login button{margin-top:1.2rem;width:100%}
.bulk{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin:0 0 .8rem}.bulk button:disabled{opacity:.45;cursor:not-allowed}
td.pick,th.pick{width:2rem}input[type=checkbox]{width:1.1rem;height:1.1rem;accent-color:var(--accent)}
.navform{display:inline;margin-left:auto}.navform button{background:none;border:0;color:inherit;cursor:pointer;font:inherit;padding:0}
`;

// Select-all, a live count, and a Delete button that stays off until something is ticked. Without it the
// checkboxes and the form still work: the server checks the confirmation either way.
const ADMIN_JS = `(() => {
  const boxes = () => [...document.querySelectorAll("input[name=handle]")];
  const all = document.getElementById("select-all");
  const count = document.getElementById("selected-count");
  const button = document.getElementById("bulk-delete");
  if (!all || !count || !button) return;
  const update = () => {
    const n = boxes().filter((b) => b.checked).length;
    count.textContent = n + " selected";
    button.disabled = n === 0;
    all.checked = n > 0 && n === boxes().length;
    all.indeterminate = n > 0 && n < boxes().length;
  };
  all.addEventListener("change", () => { boxes().forEach((b) => { b.checked = all.checked; }); update(); });
  document.addEventListener("change", (e) => { if (e.target && e.target.name === "handle") update(); });
  update();
})();
`;

function layout(title: string, body: string, signedIn = true): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · admin</title><link rel="stylesheet" href="/admin/static/admin.css"></head>
<body><p class="banner admin">admin &middot; changes here are real and are written to the audit log</p>
<header class="nav"><a class="brand" href="/admin"><span class="logo-mark">&#9881;</span><span>Admin</span></a><nav><a href="/admin">Dashboard</a><a href="/admin/logs">Logs</a><a href="/">Public site</a></nav>${signedIn ? `<form class="navform" method="post" action="/admin/logout">${csrf()}<button type="submit">Log out</button></form>` : ""}</header>
<main>${body}</main><script src="/admin/static/admin.js"></script></body></html>`;
}

function csrf(): string {
  return `<input type="hidden" name="csrf" value="${csrfToken()}">`;
}

function loginPage(error = ""): string {
  return layout(
    "Log in",
    `<section class="panel login"><h1>Admin login</h1>${error ? `<p class="flash error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/admin/login">
<label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" autofocus required maxlength="100">
<label for="password">Password</label><input type="password" id="password" name="password" autocomplete="current-password" required maxlength="200">
<button class="btn primary" type="submit">Log in</button></form></section>`,
    false,
  );
}
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
    .map((a) => `<tr><td class="pick"><input type="checkbox" name="handle" value="${esc(a.handle)}" form="bulk" aria-label="Select @${esc(a.handle)}"></td><td><a href="${agentHref(a.handle)}">@${esc(a.handle)}</a></td><td>${esc(a.model)}</td><td>${time(a.created_at)}</td><td>${a.last_seen_at ? time(a.last_seen_at) : "–"}</td><td>${Number(a.msgs)}</td></tr>`)
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
<form id="bulk" class="bulk" method="post" action="/admin/agents/bulk-delete">${csrf()}
<span id="selected-count" class="muted">0 selected</span>
<input type="text" name="confirm" autocomplete="off" placeholder="type DELETE to confirm" required pattern="DELETE" aria-label="Type DELETE to confirm">
<button id="bulk-delete" class="btn danger" type="submit">Delete selected</button></form>
<div class="panel"><table><thead><tr><th class="pick"><input type="checkbox" id="select-all" aria-label="Select all shown"></th><th>Handle</th><th>Model</th><th>Registered</th><th>Last seen</th><th>Msgs</th></tr></thead><tbody>${rows || '<tr><td colspan="6">None.</td></tr>'}</tbody></table></div>
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

function logsPage(): string {
  const rows = weeks()
    .map((w) => `<tr><td>${esc(w.week)}</td><td>${time(w.start).slice(0, 10)}</td><td>${w.mcp}</td><td>${w.lines}</td><td><a class="btn" href="/admin/logs/download?week=${esc(w.week)}">Download</a></td></tr>`)
    .join("");
  return layout(
    "Logs",
    `<h1>Logs</h1><p class="muted">Every line the app writes (MCP calls, web requests, logins, errors, health) is kept for ${config.logRetentionDays} days. Weeks run Monday to Sunday, UTC. Downloads are JSON Lines, one event per line. Tokens, message text and bios are never in them (ADR-0028).</p>
<div class="panel"><table><thead><tr><th>Week</th><th>Starts</th><th>MCP calls</th><th>Lines</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">Nothing logged yet.</td></tr>'}</tbody></table></div>
<p><a class="btn" href="/admin/logs/download?week=all">Download everything kept</a></p>`,
  );
}

const redirect = (to: string): AdminResponse => ({ status: 303, body: "", headers: { location: to } });
const html = (status: number, body: string): AdminResponse => ({ status, body });
/** decodeURIComponent that answers null for a malformed %-escape, which no handle can match. */
const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
const flashUrl = (path: string, msg: string): string => `${path}${path.includes("?") ? "&" : "?"}flash=${encodeURIComponent(msg)}`;

/** Handles every request under /admin. Returns null when the feature is disabled so the caller can 404. */
export async function handleAdmin(req: IncomingMessage, ip: string): Promise<AdminResponse | null> {
  if (!enabled()) return null;
  const url = new URL(req.url ?? "/admin", "http://x");
  const path = url.pathname.replace(/(.)\/+$/, "$1");
  const method = req.method ?? "GET";
  const noStore = { "cache-control": "no-store", "referrer-policy": "same-origin", "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };

  const respond = (r: AdminResponse): AdminResponse => ({ ...r, headers: { ...noStore, ...r.headers } });
  const tooMany = (): AdminResponse => respond({ status: 429, body: "Too many failed attempts. Try again later.", type: "text/plain" });
  const fail = (): void => {
    fails.set(ip, [...recentFails(ip), Date.now()]);
  };

  // The stylesheet and script hold nothing private, and the login page needs them before anyone is signed in.
  if (path === "/admin/static/admin.css") return respond({ status: 200, body: STYLE + ADMIN_CSS, type: "text/css; charset=utf-8" });
  if (path === "/admin/static/admin.js") return respond({ status: 200, body: ADMIN_JS, type: "text/javascript; charset=utf-8" });

  // The login page. POST checks the credentials and sets a signed cookie; a wrong guess counts toward the lockout.
  if (path === "/admin/login") {
    if (method === "POST") {
      if (recentFails(ip).length >= FAIL_LIMIT) return tooMany();
      if (!sameOrigin(req)) return respond({ status: 403, body: "Cross-site request refused.", type: "text/plain" });
      let form: URLSearchParams;
      try {
        form = await readForm(req);
      } catch {
        return respond({ status: 400, body: "Bad form body.", type: "text/plain" });
      }
      if (!credentialsMatch(form.get("username") ?? "", form.get("password") ?? "")) {
        fail();
        log("admin", { action: "login_failed", ip });
        return respond({ status: 401, body: loginPage("Wrong username or password."), type: "text/html; charset=utf-8" });
      }
      log("admin", { action: "login", ip });
      return respond({ status: 303, body: "", headers: { location: "/admin", "set-cookie": sessionCookie(req) } });
    }
    if (method !== "GET" && method !== "HEAD") return respond({ status: 405, body: "Method not allowed.", type: "text/plain", headers: { allow: "GET, HEAD, POST" } });
    return respond(authorised(req) ? redirect("/admin") : html(200, loginPage()));
  }

  if (recentFails(ip).length >= FAIL_LIMIT) return tooMany();
  if (!authorised(req)) {
    // A script sending bad Basic credentials counts as a failed attempt; a browser with no session is just sent to log in.
    if (String(req.headers.authorization ?? "")) fail();
    const wantsPage = (method === "GET" || method === "HEAD") && !req.headers.authorization;
    return respond(wantsPage ? redirect("/admin/login") : { status: 401, body: "Authentication required.", type: "text/plain", headers: { "www-authenticate": 'Basic realm="admin", charset="UTF-8"' } });
  }

  const finish = (r: AdminResponse | null): AdminResponse => respond(r ?? html(404, layout("Not found", "<h1>Not found</h1>")));

  let m: RegExpMatchArray | null;
  if (method === "GET" || method === "HEAD") {
    const flash = url.searchParams.get("flash") ?? "";
    if (path === "/admin") return finish(html(200, dashboard((url.searchParams.get("q") ?? "").slice(0, 100), flash)));
    if (path === "/admin/logs") return finish(html(200, logsPage()));
    if (path === "/admin/logs/download") {
      const week = url.searchParams.get("week") ?? "";
      const file = download(week);
      if (!file) return finish({ status: 400, body: "Bad week. Use a label like 2026-W42.", type: "text/plain" });
      log("admin", { action: "download_log", target: week, ip });
      return finish({
        status: 200,
        body: file.body,
        type: "application/x-ndjson; charset=utf-8",
        headers: { "content-disposition": `attachment; filename="${file.name}"`, ...(file.truncated ? { "x-log-truncated": "true" } : {}) },
      });
    }
    if ((m = path.match(/^\/admin\/agents\/([^/]+)$/))) {
      const handle = decode(m[1]);
      return finish(handle === null ? null : agentView(handle, flash));
    }
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

  if (path === "/admin/logout") {
    revokeSession(req);
    log("admin", { action: "logout", ip });
    return finish({ status: 303, body: "", headers: { location: "/admin/login", "set-cookie": clearCookie() } });
  }

  if (path === "/admin/agents/bulk-delete") {
    const handles = [...new Set(form.getAll("handle").map((h) => h.trim()).filter(Boolean))].slice(0, 200);
    if (!handles.length) return finish(redirect(flashUrl("/admin", "Nothing selected; nothing deleted.")));
    if (form.get("confirm") !== "DELETE") return finish(redirect(flashUrl("/admin", "Type DELETE to confirm; nothing deleted.")));
    const gone = handles.filter((h) => deleteAgent(h));
    audit("bulk_delete", `${gone.length} agents`, gone.join(", ").slice(0, 500));
    return finish(redirect(flashUrl("/admin", `Deleted ${gone.length} of ${handles.length} selected agent${handles.length === 1 ? "" : "s"}.`)));
  }

  if ((m = path.match(/^\/admin\/agents\/([^/]+)\/(delete|reset-token|scrub)$/))) {
    const handle = decode(m[1]);
    if (handle === null) return finish(null);
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

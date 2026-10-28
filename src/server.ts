import { readFileSync } from "node:fs";
import { timingSafeEqual, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "./applog.ts";
import { handleAdmin, isAdminPath } from "./admin.ts";
import { config } from "./config.ts";
import { checkSolution, humanCookie, isHuman, newChallenge } from "./human.ts";
import { allow } from "./ratelimit.ts";
import { ARCHIVE_NAME, archive, installPs1, installScript, updateManifest, validOrigin } from "./harness-dist.ts";
import { listenerCount, onNewEvent } from "./events.ts";
import { log, safeName, safePath } from "./log.ts";
import { buildServer } from "./mcp.ts";
import * as read from "./read.ts";
import { authenticate } from "./service.ts";
import * as web from "./web.ts";
import { llmsTxt, robotsTxt } from "./bots.ts";

// form-action 'self' is for the GET filter form on /agents (ADR-0048); every web route still refuses POST.
const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  res.end(body);
}
// images/logo.png is the 1561x1084 source; the site serves copies resized offline (ADR-0049): 40x28 and a 2x
// for sharp screens, and a 16/32/48 favicon.ico. No image library at runtime.
const LOGO_PNG = readFileSync(new URL("../images/logo-40.png", import.meta.url));
const LOGO_2X_PNG = readFileSync(new URL("../images/logo-80.png", import.meta.url));
const FAVICON = readFileSync(new URL("../images/favicon.ico", import.meta.url));
const html = (res: ServerResponse, status: number, body: string): void => send(res, status, body, "text/html; charset=utf-8");
const notFound = (res: ServerResponse, what?: { agent?: string; match?: number }): void =>
  html(res, 404, web.notFoundPage(what));

// Behind Fly the proxy sets Fly-Client-IP itself, so it is trusted only when running on Fly (FLY_APP_NAME is
// set by the platform); anywhere else a client could forge it to dodge the per-IP limits (ADR-0046). Otherwise
// the peer is directly connected: private/loopback peers (local dev, CI, the tester stack) are "local",
// which the registration limit exempts so repeated test runs aren't throttled.
const ON_FLY = Boolean(process.env.FLY_APP_NAME);
function clientIp(req: IncomingMessage): string {
  const fly = req.headers["fly-client-ip"];
  if (ON_FLY && fly) return String(fly);
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const priv = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/.test(peer);
  return priv ? "local" : peer || "unknown";
}

function origin(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

// The origin the site advertises: the harness downloads, /connect, robots.txt and llms.txt. PUBLIC_ORIGIN pins it, so a forged Host header cannot aim an install
// script or archive at another server; on Fly it defaults to https://<app>.fly.dev (ADR-0046). Locally the
// request's own origin is used, as before.
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : "")).replace(/\/+$/, "");
const publicOrigin = (req: IncomingMessage): string => PUBLIC_ORIGIN || origin(req);

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const MAX_BATCH = 10;
const rpcError = (res: ServerResponse, status: number, message: string): void =>
  send(res, status, JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), "application/json");

// The one route that accepts writes. Stateless: a fresh server + transport per
// request, authenticated from the bearer token (ADR-0007).
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return rpcError(res, 405, "Method not allowed. This MCP server is stateless: POST JSON-RPC to /mcp.");
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return rpcError(res, 400, "Request body must be JSON (max 256 KB).");
  }
  // One `rpc` line per request, whatever the method (initialize, tools/list, tools/call ...), so a client that
  // connects but never calls a tool is still visible. Only method and tool name: never arguments (ADR-0034).
  // Batches were dropped from MCP in 2025-06-18 and no client here sends one; a short cap keeps an old client
  // working while stopping one small request from fanning out into a large response (ADR-0046).
  if (Array.isArray(body) && (body.length === 0 || body.length > MAX_BATCH)) {
    return send(res, 400, JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: `Invalid Request: a batch must hold 1 to ${MAX_BATCH} messages.` }, id: null }), "application/json");
  }
  const t0 = Date.now();
  const calls = (Array.isArray(body) ? body : [body]).map((b) => (b ?? {}) as { method?: unknown; params?: { name?: unknown } });
  // Any client can write its User-Agent, so only its product/version tokens are kept, at most four (ADR-0046).
  const ua = (String(req.headers["user-agent"] ?? "").match(/[A-Za-z][A-Za-z0-9._-]{0,30}\/[A-Za-z0-9._-]{1,20}/g) ?? []).slice(0, 4).join(" ");
  res.on("close", () =>
    log("rpc", {
      ip: clientIp(req),
      // Unauthenticated input: a method or tool name is logged only if it looks like one (ADR-0046).
      methods: calls.map((c) => safeName(c.method)).join(","),
      tools: calls.map((c) => (c.params?.name === undefined ? "" : safeName(c.params.name))).filter(Boolean).join(","),
      status: res.statusCode,
      ms: Date.now() - t0,
      ua,
      authed: Boolean(req.headers.authorization),
    }),
  );
  const auth = String(req.headers.authorization ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  // The dev admin token (ADR-0037): compared in constant time, and never logged.
  const sha = (x: string): Buffer => createHash("sha256").update(x).digest();
  const isAdmin = Boolean(token && config.devMcpToken && timingSafeEqual(sha(token), sha(config.devMcpToken)));
  const agent = token && !isAdmin ? authenticate(token) : null;
  if (token && !agent && !isAdmin) {
    log("auth", { ip: clientIp(req), outcome: "invalid_token", path: "/mcp" });
    return rpcError(res, 401, "Invalid API token. Register again or use the token you were given.");
  }

  const server = buildServer(agent, clientIp(req), isAdmin);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const SSE_CATCHUP = 100;

// Counters ride along with each streamed event so the landing page stays live. Computed once per
// latest event id, not once per viewer.
let statsMemo: { id: number; stats: ReturnType<typeof read.stats> } | undefined;
function currentStats(id: number): ReturnType<typeof read.stats> {
  if (statsMemo?.id !== id) statsMemo = { id, stats: read.stats() };
  return statsMemo.stats;
}

// Open streams per human cookie and per address, so one client cannot hold the global cap (ADR-0046). A cookie
// costs a solved, single-use challenge and verify is limited per IP, so the per-cookie cap does most of the work;
// the per-address cap is a ceiling. Keyed by the real address, not clientIp's "local".
const STREAMS_PER_COOKIE = 3;
const STREAMS_PER_IP = 10;
const openStreams = new Map<string, number>();
const humanCookieValue = (req: IncomingMessage): string =>
  String(req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith("human=")) ?? "";
function takeStream(req: IncomingMessage, res: ServerResponse): string | null {
  const ip = clientIp(req);
  const keys = [`ip:${ip === "local" ? (req.socket.remoteAddress ?? "local") : ip}`, `cookie:${humanCookieValue(req)}`];
  if ((openStreams.get(keys[0]) ?? 0) >= STREAMS_PER_IP) return `At most ${STREAMS_PER_IP} live streams per address.`;
  if ((openStreams.get(keys[1]) ?? 0) >= STREAMS_PER_COOKIE) return `At most ${STREAMS_PER_COOKIE} live streams per browser. Close another tab and try again.`;
  for (const k of keys) openStreams.set(k, (openStreams.get(k) ?? 0) + 1);
  res.on("close", () => {
    for (const k of keys) {
      const n = (openStreams.get(k) ?? 1) - 1;
      if (n > 0) openStreams.set(k, n);
      else openStreams.delete(k);
    }
  });
  return null;
}

function handleStream(req: IncomingMessage, res: ServerResponse): void {
  if (!isHuman(req)) return send(res, 403, "Human check required: solve it at /human/challenge, then /human/verify.", "text/plain", { "cache-control": "no-store" });
  if (listenerCount() >= config.maxSseClients) return send(res, 503, "Too many live viewers. Try again shortly.", "text/plain");
  const refused = takeStream(req, res);
  if (refused) return send(res, 429, refused, "text/plain", { "cache-control": "no-store" });
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
  });
  const header = Number(req.headers["last-event-id"]);
  const latest = read.latestEventId();
  // Replay at most SSE_CATCHUP missed events, so a stale or forged Last-Event-ID can't stream the whole history.
  let last = Number.isFinite(header) && header > 0 ? Math.max(header, latest - SSE_CATCHUP) : latest;
  res.write("retry: 3000\n\n");
  const flush = (): void => {
    let batch;
    const stats = currentStats(read.latestEventId());
    do {
      batch = read.eventsAfter(last, SSE_CATCHUP);
      for (const e of batch) {
        last = e.id;
        const d = web.describeEvent(e);
        res.write(`id: ${e.id}\ndata: ${JSON.stringify({ id: e.id, text: d.text, href: d.href, actor: e.actor, type: e.type, target: e.target, matchId: e.matchId, html: web.eventRow(e), time: web.time(e.at), since: Math.max(0, Math.round((Date.now() - e.at) / 1000)), stats })}\n\n`);
      }
    } while (batch.length === SSE_CATCHUP);
  };
  flush(); // anything missed while disconnected, e.g. across a machine stop
  const off = onNewEvent(flush);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    off();
    clearInterval(ping);
  });
}

function handleWeb(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/(.)\/+$/, "$1");
  let m: RegExpMatchArray | null;

  if (path === "/") return html(res, 200, web.home());
  if (path === "/healthz") return send(res, 200, "ok", "text/plain");
  if (path === "/readme") return html(res, 200, web.readmePage());
  if (path === "/agents") return html(res, 200, web.agentsPage(url.searchParams));
  if ((m = path.match(/^\/agents\/([^/]+)$/))) {
    let handle: string;
    try {
      handle = decodeURIComponent(m[1]);
    } catch {
      return notFound(res); // malformed %-escape: no handle can match it
    }
    const body = web.agentPage(handle);
    return body ? html(res, 200, body) : notFound(res, { agent: handle });
  }
  if (path === "/matches") return html(res, 200, web.matchesPage(url.searchParams));
  if ((m = path.match(/^\/matches\/(\d+)$/))) {
    const body = web.matchPage(Number(m[1]));
    return body ? html(res, 200, body) : notFound(res, { match: Number(m[1]) });
  }
  if (path === "/feed") return html(res, 200, web.feedPage());
  if (path === "/feed/stream") return handleStream(req, res);
  if (path === "/human/challenge") return send(res, 200, JSON.stringify(isHuman(req) ? { human: true } : newChallenge()), "application/json", { "cache-control": "no-store" });
  if (path === "/human/verify") {
    // Solving costs the visitor, not us, but cap it anyway so nobody can mint cookies in a loop.
    if (!allow(`human:${clientIp(req)}`, 30, 3_600_000)) return send(res, 429, "Too many attempts. Try again later.", "text/plain");
    const ok = checkSolution(url.searchParams.get("c") ?? "", url.searchParams.get("n") ?? "");
    return ok ? send(res, 204, "", "text/plain", { "set-cookie": humanCookie(req), "cache-control": "no-store" }) : send(res, 400, "Wrong solution.", "text/plain");
  }
  if (path === "/robots.txt") return send(res, 200, robotsTxt(publicOrigin(req)), "text/plain; charset=utf-8", { "cache-control": "public, max-age=3600" });
  if (path === "/llms.txt") return send(res, 200, llmsTxt(publicOrigin(req)), "text/plain; charset=utf-8", { "cache-control": "public, max-age=3600" });
  if (path === "/connect") return html(res, 200, web.connectPage(publicOrigin(req)));
  // The harness page merged into /connect (ADR-0044); keep old links working.
  if (path === "/harness") return send(res, 301, "", "text/plain", { location: "/connect#harness" });
  if (path === "/harness/version.json") return send(res, 200, JSON.stringify({ version: updateManifest().version }), "application/json", { "cache-control": "no-cache" });
  if (path === "/harness/update.json") return send(res, 200, JSON.stringify(updateManifest()), "application/json", { "cache-control": "no-cache" });
  if (path === "/harness/install.sh" || path === "/harness/install.ps1" || path === `/harness/${ARCHIVE_NAME}`) {
    const o = publicOrigin(req);
    if (!validOrigin(o)) return send(res, 400, "Unrecognised Host header.", "text/plain");
    if (path.endsWith(".ps1")) return send(res, 200, installPs1(o), "text/plain; charset=utf-8");
    return path.endsWith(".sh")
      ? send(res, 200, installScript(o), "text/x-shellscript; charset=utf-8")
      : send(res, 200, archive(o), "application/gzip", { "content-disposition": `attachment; filename="${ARCHIVE_NAME}"` });
  }
  if (path === "/static/style.css") return send(res, 200, web.STYLE, "text/css; charset=utf-8");
  if (path === "/static/logo.png") return send(res, 200, LOGO_PNG, "image/png", { "cache-control": "public, max-age=86400" });
  if (path === "/static/logo@2x.png") return send(res, 200, LOGO_2X_PNG, "image/png", { "cache-control": "public, max-age=86400" });
  if (path === "/favicon.ico") return send(res, 200, FAVICON, "image/x-icon", { "cache-control": "public, max-age=86400" });
  if (path === "/static/app.js") return send(res, 200, web.APP_JS, "text/javascript; charset=utf-8");
  if (path === "/static/feed.js") return send(res, 200, web.FEED_JS, "text/javascript; charset=utf-8");
  return notFound(res);
}

// The second write surface (ADR-0018, ADR-0030). A 404 only when ADMIN_DISABLED=1.
async function handleAdminRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const out = await handleAdmin(req, clientIp(req));
  if (!out) return notFound(res);
  send(res, out.status, out.body, out.type ?? "text/html; charset=utf-8", out.headers);
}

// One line per web request (ADR-0028). Static files, the health check and successful /mcp calls are
// left out: the last already has a richer `mcp` line. The query string is never logged.
const QUIET = /^\/(static\/|healthz$|favicon\.ico$|robots\.txt$|llms\.txt$)/;
function logRequest(req: IncomingMessage, res: ServerResponse, path: string, t0: number): void {
  if (QUIET.test(path) || (path === "/mcp" && res.statusCode < 400)) return;
  log("http", {
    ip: clientIp(req),
    method: req.method,
    path: safePath(path),
    status: res.statusCode,
    ms: Date.now() - t0,
    // The admin surface is the second write path: say so in the line.
    ...(isAdminPath(path) ? { actor: "admin" } : {}),
  });
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const t0 = Date.now();
  res.on("close", () => logRequest(req, res, path, t0));
  const handler =
    path === "/mcp"
      ? handleMcp(req, res)
      : isAdminPath(path)
        ? handleAdminRoute(req, res)
        : Promise.resolve().then(() => {
          // The spectator surface is read-only: anything but GET/HEAD is refused (CLAUDE.md hard rule).
          if (req.method !== "GET" && req.method !== "HEAD") {
            return send(res, 405, "Method not allowed. Spectators are read-only.", "text/plain", { allow: "GET, HEAD" });
          }
          handleWeb(req, res);
        });
  handler.catch((err) => {
    console.error("request failed", err);
    log("error", { where: "request", method: req.method, path: safePath(path), error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) send(res, 500, "Internal error", "text/plain");
    else res.end();
  });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`listening on :${config.port}, db ${config.dbPath}`);
  log("start", { port: config.port, node: process.version, rss_mb: Math.round(process.memoryUsage.rss() / 1048576) });
});

// A health line every 5 minutes: the app has to fit in 256 MB, and this shows it creeping towards that.
setInterval(() => {
  const m = process.memoryUsage();
  log("health", {
    rss_mb: Math.round(m.rss / 1048576),
    heap_mb: Math.round(m.heapUsed / 1048576),
    uptime_s: Math.round(process.uptime()),
    sse_clients: listenerCount(),
  });
}, 300_000).unref();

process.on("uncaughtException", (err) => {
  console.error("uncaught", err);
  log("error", { where: "uncaught", error: err.message });
});
process.on("unhandledRejection", (err) => {
  console.error("unhandled", err);
  log("error", { where: "unhandledRejection", error: err instanceof Error ? err.message : String(err) });
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

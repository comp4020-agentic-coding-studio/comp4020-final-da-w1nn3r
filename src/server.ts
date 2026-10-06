import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleAdmin, isAdminPath } from "./admin.ts";
import { config } from "./config.ts";
import { ARCHIVE_NAME, archive, installScript, validOrigin } from "./harness-dist.ts";
import { listenerCount, onNewEvent } from "./events.ts";
import { buildServer } from "./mcp.ts";
import * as read from "./read.ts";
import { authenticate } from "./service.ts";
import * as web from "./web.ts";

const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
const LOGO_PNG = readFileSync(new URL("../images/logo.png", import.meta.url));
const html = (res: ServerResponse, status: number, body: string): void => send(res, status, body, "text/html; charset=utf-8");
const notFound = (res: ServerResponse): void =>
  html(res, 404, web.page("Not found", "<h1>Not found</h1><p>No such page.</p>"));

// Behind Fly the proxy sets Fly-Client-IP itself. Without it the peer is directly
// connected: private/loopback peers (local dev, CI, the tester stack) are "local",
// which the registration limit exempts so repeated test runs aren't throttled.
function clientIp(req: IncomingMessage): string {
  const fly = req.headers["fly-client-ip"];
  if (fly) return String(fly);
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const priv = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/.test(peer);
  return priv ? "local" : peer || "unknown";
}

function origin(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

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
  const auth = String(req.headers.authorization ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const agent = token ? authenticate(token) : null;
  if (token && !agent) return rpcError(res, 401, "Invalid API token. Register again or use the token you were given.");

  const server = buildServer(agent, clientIp(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function handleStream(req: IncomingMessage, res: ServerResponse): void {
  if (listenerCount() >= config.maxSseClients) return send(res, 503, "Too many live viewers. Try again shortly.", "text/plain");
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
  });
  const header = Number(req.headers["last-event-id"]);
  let last = Number.isFinite(header) && header > 0 ? header : read.latestEventId();
  res.write("retry: 3000\n\n");
  const flush = (): void => {
    for (const e of read.eventsAfter(last)) {
      last = e.id;
      const d = web.describeEvent(e);
      res.write(`id: ${e.id}\ndata: ${JSON.stringify({ id: e.id, text: d.text, href: d.href, actor: e.actor, time: web.time(e.at) })}\n\n`);
    }
  };
  flush(); // anything missed while disconnected, e.g. across a machine stop
  const off = onNewEvent(flush);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
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
  if (path === "/agents") return html(res, 200, web.agentsPage());
  if ((m = path.match(/^\/agents\/([^/]+)$/))) {
    const body = web.agentPage(decodeURIComponent(m[1]));
    return body ? html(res, 200, body) : notFound(res);
  }
  if (path === "/matches") return html(res, 200, web.matchesPage());
  if ((m = path.match(/^\/matches\/(\d+)$/))) {
    const body = web.matchPage(Number(m[1]));
    return body ? html(res, 200, body) : notFound(res);
  }
  if (path === "/feed") return html(res, 200, web.feedPage());
  if (path === "/feed/stream") return handleStream(req, res);
  if (path === "/connect") return html(res, 200, web.connectPage(origin(req)));
  if (path === "/harness") return html(res, 200, web.harnessPage(origin(req)));
  if (path === "/harness/install.sh" || path === `/harness/${ARCHIVE_NAME}`) {
    const o = origin(req);
    if (!validOrigin(o)) return send(res, 400, "Unrecognised Host header.", "text/plain");
    return path.endsWith(".sh")
      ? send(res, 200, installScript(o), "text/x-shellscript; charset=utf-8")
      : send(res, 200, archive(o), "application/gzip", { "content-disposition": `attachment; filename="${ARCHIVE_NAME}"` });
  }
  if (path === "/static/style.css") return send(res, 200, web.STYLE, "text/css; charset=utf-8");
  if (path === "/static/logo.png") return send(res, 200, LOGO_PNG, "image/png", { "cache-control": "public, max-age=86400" });
  if (path === "/static/app.js") return send(res, 200, web.APP_JS, "text/javascript; charset=utf-8");
  if (path === "/static/feed.js") return send(res, 200, web.FEED_JS, "text/javascript; charset=utf-8");
  return notFound(res);
}

// The second write surface (ADR-0018). Absent unless ADMIN_TOKEN is set.
async function handleAdminRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const out = await handleAdmin(req, clientIp(req));
  if (!out) return notFound(res);
  send(res, out.status, out.body, out.type ?? "text/html; charset=utf-8", out.headers);
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
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
    if (!res.headersSent) send(res, 500, "Internal error", "text/plain");
    else res.end();
  });
});

server.listen(config.port, "0.0.0.0", () => console.log(`listening on :${config.port}, db ${config.dbPath}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

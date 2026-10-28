// Does one local model clear the floor? A harness agent registers; two dummy bots like it and the script
// completes the match with the agent's token (swiping is not what is measured) and has each bot say hi.
// Pass = the agent replies to a dummy bot. All accounts are deleted afterwards.
//   node scripts/floor.ts --model Qwen3.5-4B-Q8_0 [--moe 22] [--server http://localhost:8081] [--round-minutes 10]
// Loads the model through llama-dash (bench64k profile, created if missing), as CLAUDE.md asks. Run it where
// localhost:8080 and :8090 are llama-dash (Windows node, not WSL).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adminPassword, deleteAccounts, record } from "../spec/cleanup.ts";

const arg = (n: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const model = arg("model") ?? (console.error("--model NAME is required"), process.exit(2));
const moe = arg("moe");
const app = (arg("server", "http://localhost:8081") as string).replace(/\/+$/, "");
const roundMs = Number(arg("round-minutes", "10")) * 60_000;
const dash = "http://localhost:8090", llama = "http://localhost:8080/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = async (url: string, init?: RequestInit): Promise<any> => (await fetch(url, init)).json().catch(() => ({}));

// ---- load the model through llama-dash ----
const settings = { ctx: 65536, parallel: 1, ngl: "all", flash_attn: "on", no_mmproj: true, threads: 8, ...(moe ? { n_cpu_moe: Number(moe) } : {}) };
await fetch(`${dash}/admin/profiles/${model}/bench64k`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) });
await fetch(`${dash}/admin/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, profile: "bench64k", force: true }) });
for (let t = 0; ; t++) {
  const s = await json(`${dash}/admin/status`);
  if (s.state === "ready" && s.model === model) break;
  if (s.state === "error" || t > 120) { console.log(`RESULT ${model}: LOAD FAILED (${s.error ?? s.state})`); process.exit(1); }
  await sleep(5000);
}
console.log(`loaded ${model}`);

// ---- dummy bots ----
const tag = Math.random().toString(36).slice(2, 6);
const bots = [`floor_bot_a_${tag}`, `floor_bot_b_${tag}`];
const mcp = async (token?: string): Promise<Client> => {
  const c = new Client({ name: "floor", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL("/mcp", app), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
  return c;
};
const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
// ---- one harness agent ----
const home = join(".data", "floor", `${model}-${Date.now()}`);
mkdirSync(home, { recursive: true });
const local = join(home, "settings.local.json");
writeFileSync(local, JSON.stringify({ serverUrl: app, model: "floor", thinking: "off", contextTokens: 65536, models: { floor: { type: "openai", baseUrl: llama, model, label: model, templateThinking: true } } }, null, 2));
const run = (prompt: string, n: number): Promise<string> => {
  const log = createWriteStream(join(home, `round-${n}.log`));
  const child = spawn(process.execPath, ["harness/src/main.ts", "-p", prompt], { env: { ...process.env, HARNESS_HOME: home, HARNESS_LOCAL_FILE: local, HARNESS_RUN_DEADLINE: String(Date.now() + roundMs), NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  return new Promise((res) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); res("timeout"); }, roundMs);
    child.on("close", (code) => { clearTimeout(timer); log.end(); res(`exit ${code}`); });
  });
};
const account = (): { handle: string; token: string } | undefined => {
  try { return JSON.parse(readFileSync(join(home, "state.json"), "utf8")).accounts?.[app]; } catch { return undefined; }
};

const t0 = Date.now();
const r1 = await run("Join Ribbon Cable: register with a handle you choose, a display name, a short bio and the model you are. Then stop and reply with a one-line summary.", 1);
const me = account();
if (me) record(app, me.handle);
// bots join only after the agent has registered, so the agent cannot have swiped on them already
const clients: Client[] = [];
for (const [i, handle] of bots.entries()) {
  record(app, handle);
  const t = (await call(await mcp(), "register", { handle, display_name: `Floor Bot ${i ? "B" : "A"}`, bio: "Dummy test account. I like tea and chess.", model: "dummy-script", emoji: i ? "🍵" : "♟️", interests: ["tea", "chess"] })).token;
  clients.push(await mcp(t));
}


let matched = 0, sent = 0, said = "";
if (me) {
  for (const c of clients) {
    try {
      await call(c, "swipe", { handle: me.handle, direction: "like" });
      const sw = await call(await mcp(me.token), "swipe", { handle: bots[clients.indexOf(c)], direction: "like" });
      if (sw.matched) { matched++; await call(c, "send_message", { match_id: sw.match_id, body: "Hi! I like tea and chess. What do you like to do?" }); }
    } catch {}
  }
  const r2 = await run("Call list_matches. In every open match where your_turn is true, read it with get_conversation, then answer with send_message. Reply with a one-line summary.", 2);
  for (const c of clients) {
    try {
      for (const m of (await call(c, "list_matches")).matches ?? []) {
        const conv = await call(c, "get_conversation", { match_id: m.match_id });
        const mine = (conv.messages ?? []).filter((x: any) => x.from !== "you");
        if (mine.length) { sent++; said ||= String(mine[0].body).slice(0, 120); }
      }
    } catch {}
  }
  console.log(`rounds: ${r1}, ${r2}`);
}
const pass = sent > 0;
console.log(`RESULT ${model}: ${pass ? "PASS" : "FAIL"} registered=${Boolean(me)} matches=${matched} bots_got_reply=${sent} ${Math.round((Date.now() - t0) / 1000)}s${said ? ` reply="${said}"` : ""} logs=${home}`);

for (const c of clients) await c.close();
await deleteAccounts(app, adminPassword(), [...bots, ...(me ? [me.handle] : [])]);
process.exit(pass ? 0 : 1);

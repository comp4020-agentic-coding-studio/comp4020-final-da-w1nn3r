// Runs N copies of the agent harness against one app and ONE llama.cpp server, each with its own account
// and token (ADR-0029).
//   LLAMA_URL=http://localhost:8090/v1 node scripts/load.ts 4
// Each instance gets its own HARNESS_HOME, so its token, memory and settings never touch another's or
// your own harness/data. Every round is one non-interactive `main.ts -p` run per instance, all at once.
//   LLAMA_URL     required. The OpenAI-compatible base URL of the llama.cpp server, ending in /v1
//   LLAMA_MODEL   model name the server answers to (default tester-model, the compose alias)
//   APP_URL       the app under test (default http://localhost:8081)
//   ROUNDS        how many rounds (default 3: join and swipe, then talk, then reply)
//   ROUND_MINUTES give up on an instance's round after this long (default 15)
//   ADMIN_USER / ADMIN_PASSWORD   the app's admin login (default admin / ribbon-cable, ADR-0030); the accounts
//                 are deleted through /admin at the end unless KEEP=1
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminPassword, deleteAccounts, record } from "../spec/cleanup.ts";

const n = Number(process.argv[2] ?? 3);
const llama = (process.env.LLAMA_URL ?? "").replace(/\/+$/, "");
const model = process.env.LLAMA_MODEL ?? "tester-model";
const appUrl = (process.env.APP_URL ?? "http://localhost:8081").replace(/\/+$/, "");
const rounds = Number(process.env.ROUNDS ?? 3);
const roundMs = Number(process.env.ROUND_MINUTES ?? 15) * 60_000;

if (!Number.isInteger(n) || n < 1 || n > 50 || !llama.endsWith("/v1") || !Number.isInteger(rounds) || rounds < 1) {
  console.error("usage: LLAMA_URL=http://localhost:8090/v1 [APP_URL=...] [ROUNDS=3] node scripts/load.ts <instances 1-50>");
  console.error("LLAMA_URL must be the llama.cpp server's OpenAI base URL, ending in /v1.");
  process.exit(2);
}

const run = Date.now().toString(36);
const root = join(tmpdir(), `ribbon-load-${run}`);
const handleFor = (i: number): string => `load_${run}_${i + 1}`.slice(0, 24);
const home = (i: number): string => join(root, `agent-${i + 1}`);

const PROMPTS = [
  (h: string) =>
    `Join Ribbon Cable. Register with the handle exactly "${h}" (a display name and a short bio of your own). Then call get_next_profiles with limit=10 and swipe "like" on every profile you get. Reply with a one-line summary.`,
  () => "Call list_matches. In every open match where your_turn is true, read it with get_conversation, then answer with send_message. Reply with a one-line summary.",
];

/** One non-interactive harness run, with its output going to a file. Resolves with the exit code (or "timeout"). */
function runHarness(i: number, prompt: string, round: number): Promise<number | "timeout"> {
  const dir = home(i);
  const local = join(dir, "settings.local.json");
  if (!existsSync(local)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(local, JSON.stringify({ serverUrl: appUrl, model: "load", thinking: "off", models: { load: { type: "openai", baseUrl: llama, model, templateThinking: true } } }, null, 2));
  }
  const log = createWriteStream(join(dir, `round-${round}.log`));
  const child = spawn(process.execPath, ["harness/src/main.ts", "-p", prompt], {
    env: { ...process.env, HARNESS_HOME: dir, HARNESS_LOCAL_FILE: local, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, roundMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      resolve(code ?? 1);
    });
  });
}

/** The account the harness saved for this instance, if it got as far as registering. */
function account(i: number): { handle: string; token: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(home(i), "state.json"), "utf8")).accounts?.[appUrl];
  } catch {
    return undefined;
  }
}

async function summarise(token: string): Promise<{ matches: number; open: number; sent: number }> {
  const c = new Client({ name: "load", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("/mcp", appUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const res = (await c.callTool({ name: "list_matches", arguments: {} })) as { content: { text: string }[] };
  await c.close();
  const matches = JSON.parse(res.content[0].text.slice(0, res.content[0].text.lastIndexOf("}") + 1)).matches as { status: string; last_message: { from_you: boolean } | null }[];
  return { matches: matches.length, open: matches.filter((m) => m.status === "open").length, sent: matches.filter((m) => m.last_message?.from_you).length };
}

// One llama.cpp slot serves one request at a time; the rest wait their turn.
try {
  const props: any = await (await fetch(llama.replace(/\/v1$/, "") + "/props", { signal: AbortSignal.timeout(5000) })).json();
  if (props.total_slots < n) console.warn(`note: the llama server has ${props.total_slots} slot(s) for ${n} instances, so their model calls queue (each waits for the others). ADR-0005: more slots split the context, so raise -c with -np.`);
} catch {
  console.warn(`note: could not read ${llama.replace(/\/v1$/, "")}/props. Is the llama.cpp server up?`);
}

console.log(`${n} instance(s), ${rounds} round(s), app ${appUrl}, model ${model} @ ${llama}\nlogs and tokens: ${root}`);
for (let i = 0; i < n; i++) record(appUrl, handleFor(i)); // so a later spec run's sweep can still find them

for (let r = 1; r <= rounds; r++) {
  const t0 = Date.now();
  const make = PROMPTS[Math.min(r - 1, PROMPTS.length - 1)];
  const codes = await Promise.all(Array.from({ length: n }, (_, i) => runHarness(i, make(handleFor(i)), r)));
  const bad = codes.filter((c) => c !== 0).length;
  console.log(`round ${r}: ${n - bad}/${n} finished in ${Math.round((Date.now() - t0) / 1000)}s${bad ? ` (${codes.map((c, i) => (c === 0 ? "" : `#${i + 1}:${c}`)).filter(Boolean).join(" ")})` : ""}`);
}

const handles: string[] = [];
console.log("\ninstance  handle                    registered  matches  open  talking");
for (let i = 0; i < n; i++) {
  const a = account(i);
  if (a) handles.push(a.handle);
  const s = a ? await summarise(a.token).catch(() => undefined) : undefined;
  console.log(`${String(i + 1).padEnd(9)} ${(a?.handle ?? "-").padEnd(25)} ${(a ? "yes" : "NO").padEnd(11)} ${String(s?.matches ?? "-").padEnd(8)} ${String(s?.open ?? "-").padEnd(5)} ${s?.sent ?? "-"}`);
}

if (!process.env.KEEP) {
  const left = await deleteAccounts(appUrl, adminPassword(), [...handles, ...Array.from({ length: n }, (_, i) => handleFor(i))]);
  console.log(left ? `\ncleanup: ${left} account(s) could not be deleted` : "\ncleanup: accounts deleted through /admin");
} else {
  console.log(`\nleft in place (KEEP=1): ${handles.join(", ") || "(none registered)"}`);
}

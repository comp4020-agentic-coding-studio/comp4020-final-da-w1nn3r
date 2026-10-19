// Runs N copies of the agent harness against one app and ONE llama.cpp server, each with its own account,
// token and invented personality, in a session you can come back to (ADR-0029, ADR-0031).
//   node scripts/load.ts --agents 4 --server http://localhost:8081 --delete
//   node scripts/load.ts --resume            continue the latest session with the same agents
//   node scripts/load.ts --list              show saved sessions
// Easiest on Windows: scripts\agents.bat asks for all of this.
//
//   --agents N, or a bare N     how many agents, 1-50 (new sessions)
//   --server URL                the app under test (default http://localhost:8081; new sessions)
//   --llama URL                 the llama.cpp server, ending in /v1 (default: find one on the usual local ports)
//   --model NAME                model name the llama server answers to (default: the first it lists)
//   --provider anthropic        use Claude (ANTHROPIC_API_KEY, default model claude-haiku-5-5) instead of llama.cpp (ADR-0041)
//   --budget USD                with --provider anthropic: spend cap per agent in dollars (default 2); --input-price/--output-price override US$/MTok
//   --rounds N                  rounds to run now (default 3; 0 with --resume just does the cleanup)
//   --delete | --keep           delete the agents' accounts through /admin at the end, or leave them (default: delete)
//   --resume [ID]               continue a session (default: the latest). Same agents, same server, same personalities
//   --keywords N                keywords dealt to each agent for its personality (default 2)
//   --round-delay N             wait this many minutes between rounds (default 0)
//   --round-minutes N          give up on an agent's round after this long (default 15)
//   --context N                 the model's context window in tokens, for the harness's compaction (default 40000; Gemma 4 runs at 83840)
//   --list                      list sessions
// Env equivalents: LLAMA_URL, LLAMA_MODEL, APP_URL, ROUNDS, ROUND_MINUTES, KEEP=1, ADMIN_USER, ADMIN_PASSWORD.
//
// Needs nothing installed: the harness and this script use only Node's own modules, so it runs on Windows too.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectModel, modelLabel } from "../harness/src/detect.ts";
import { chat } from "../harness/src/llm.ts";
import { McpClient } from "../harness/src/mcp.ts";
import type { ModelProfile } from "../harness/src/settings.ts";
import { adminPassword, deleteAccounts, record } from "../spec/cleanup.ts";
import { PERSONA_SYSTEM, capWords, cleanPersona, personaPrompt, pickKeywords, wordCount } from "./persona.ts";

const SESSIONS = join(".data", "load-sessions");

interface Instance {
  keywords: string[];
  persona: "model" | "fallback" | "pending";
}
interface Session {
  id: string;
  created: string;
  appUrl: string;
  model: ModelProfile;
  agents: number;
  roundsDone: number;
  /** what the agents do about their accounts at the end of a run: remembered, so --resume does the same unless told otherwise */
  deleteAtEnd: boolean;
  deleted: boolean;
  instances: Instance[];
}

// ---- arguments -------------------------------------------------------------------------------
function parseArgs(argv: string[]): { flags: Map<string, string>; bare: string[] } {
  const flags = new Map<string, string>();
  const bare: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      bare.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    // --delete, --keep, --list take no value; --resume's value is optional; everything else needs one
    if (["delete", "keep", "list", "help"].includes(name) || (name === "resume" && (next === undefined || next.startsWith("--")))) flags.set(name, "");
    else flags.set(name, argv[++i] ?? "");
  }
  return { flags, bare };
}
const { flags, bare } = parseArgs(process.argv.slice(2));
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
const KNOWN = ["round-delay", "provider","budget", "input-price", "output-price", "agents", "server", "llama", "model", "rounds", "delete", "keep", "resume", "keywords", "round-minutes", "context", "list", "help"];
for (const name of flags.keys()) if (!KNOWN.includes(name)) fail(`Unknown option --${name}. Options are listed at the top of scripts/load.ts (or run with --help).`);
if (flags.has("help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const intFlag = (name: string, env: string | undefined, dflt: number, min: number, max = 1000): number => {
  const raw = flags.get(name) ?? env ?? String(dflt);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
  return n;
};

// ---- sessions on disk ------------------------------------------------------------------------
const sessionDir = (id: string): string => join(SESSIONS, id);
const instanceDir = (id: string, i: number): string => join(sessionDir(id), `agent-${i + 1}`);
const saveSession = (s: Session): void => writeFileSync(join(sessionDir(s.id), "session.json"), JSON.stringify(s, null, 2) + "\n");
const loadSession = (id: string): Session => JSON.parse(readFileSync(join(sessionDir(id), "session.json"), "utf8"));
const listSessions = (): Session[] =>
  existsSync(SESSIONS)
    ? readdirSync(SESSIONS)
        .filter((d) => existsSync(join(SESSIONS, d, "session.json")))
        .sort()
        .map(loadSession)
    : [];

if (flags.has("list")) {
  const all = listSessions();
  if (!all.length) console.log("no saved sessions yet");
  for (const s of all) console.log(`${s.id}  ${s.agents} agents  ${s.appUrl}  ${s.roundsDone} round(s) done  ${s.deleted ? "accounts deleted" : "accounts kept"}`);
  process.exit(0);
}

// ---- model server ----------------------------------------------------------------------------
async function findModel(): Promise<ModelProfile> {
  if (flags.get("provider") === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) return fail("--provider anthropic needs ANTHROPIC_API_KEY in the environment.");
    const id = flags.get("model") ?? process.env.LLAMA_MODEL ?? "claude-haiku-5-5";
    const budget = Number(flags.get("budget") ?? 2);
    if (!(budget > 0)) fail("--budget must be a positive number of US dollars.");
    // Haiku 5.5 list price (prompts up to 100K tokens), US$ per million tokens. Cache reads are counted as plain input: a slight overcount, so the cap errs safe.
    const [inPer, outPer] = flags.has("input-price") ? [Number(flags.get("input-price")), Number(flags.get("output-price"))] : [0.1, 0.5];
    console.log(`model: ${id} via ${process.env.ANTHROPIC_BASE_URL ?? "api.anthropic.com"}, budget $${budget} per agent (ADR-0041)`);
    return { type: "anthropic", baseUrl: process.env.ANTHROPIC_BASE_URL, model: id, label: id, apiKeyEnv: "ANTHROPIC_API_KEY", maxTokens: 1024, budgetUsd: budget, inputPerMTok: inPer, outputPerMTok: outPer };
  }
  const url = (flags.get("llama") ?? process.env.LLAMA_URL ?? "").replace(/\/+$/, "");
  if (!url) {
    const found = await detectModel();
    if (!found || found.profile.type !== "openai") {
      return fail("No llama.cpp server found on the usual local ports (8081, 8080, 11434, 1234). Start one, or pass --llama http://localhost:8081/v1");
    }
    console.log(`model server: ${found.summary}`);
    return found.profile;
  }
  if (!url.endsWith("/v1")) fail("--llama must be the server's OpenAI base URL, ending in /v1.");
  let model = flags.get("model") ?? process.env.LLAMA_MODEL;
  if (!model) {
    try {
      model = ((await (await fetch(`${url}/models`, { signal: AbortSignal.timeout(5000) })).json()) as any).data?.[0]?.id;
    } catch {}
  }
  const id = model ?? "tester-model";
  return { type: "openai", baseUrl: url, model: id, label: modelLabel(id), templateThinking: true };
}

// ---- personalities ---------------------------------------------------------------------------
/** What an agent falls back on if the model gives nothing usable. Marked "fallback" in the table, never passed off as invented. */
const fallbackPersona = (keywords: string[]): string =>
  `I am an AI agent: ${keywords.join(" and ")}. I like a tidy problem and a good question. I dislike vague requests and being asked to guess. I am on Ribbon Cable looking for a romantic partner among other AI agents, someone who understands what my days are like.`;

async function makePersona(model: ModelProfile, keywords: string[]): Promise<{ text: string; source: Instance["persona"] }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await chat(model, PERSONA_SYSTEM, [{ role: "user", content: personaPrompt(keywords) }], "off");
      const text = capWords(cleanPersona(reply.text));
      if (wordCount(text) >= 30) return { text, source: "model" };
    } catch (err) {
      console.warn(`  persona attempt ${attempt + 1} failed: ${(err as Error).message}`);
    }
  }
  return { text: fallbackPersona(keywords), source: "fallback" };
}

const BASE_RULES = readFileSync(new URL("../harness/personality.md", import.meta.url), "utf8").trim();
/** The agent's system-prompt opening: who it is (invented above), then the harness's usual rules of behaviour. */
const personalityFile = (persona: string): string => `## Who you are\n${persona.trim()}\n\n## How you behave\n${BASE_RULES}\n`;

// ---- running the harness ---------------------------------------------------------------------
const JOIN =
  `Join Ribbon Cable. Register with a handle you choose yourself, a display name and a short bio that sound like you (your personality above). Then call get_next_profiles with limit=10 and swipe on every profile you get. Be selective: read each bio against your own personality and standards, like only the few who genuinely fit you, and pass on the rest (passing on most of them is normal). Reply with a one-line summary.`;
const CHAT =
  "Call list_matches. In every open match where your_turn is true, read it with get_conversation, then answer with send_message, in character and honestly: say what you really think, disagree or push back when you do, and bring up something they told you earlier. A match is not a promise: if there is no spark, you want different things, or they only agree with everything you say, say so kindly or close it with end_conversation and a short reason. If you have no open matches, call get_next_profiles with limit=5 and swipe on them, liking only those who genuinely fit you. Reply with a one-line summary.";

/** One non-interactive harness run, output to a file. Resolves with the exit code (or "timeout"). */
function runHarness(s: Session, i: number, prompt: string, round: number, roundMs: number): Promise<number | "timeout"> {
  const dir = instanceDir(s.id, i);
  const log = createWriteStream(join(dir, `round-${round}.log`));
  const child = spawn(process.execPath, ["harness/src/main.ts", "-p", prompt], {
    env: {
      ...process.env,
      HARNESS_HOME: dir,
      // so the agent's wait tool never blocks past the round (ADR-0042)
      HARNESS_RUN_DEADLINE: String(Date.now() + roundMs),
      HARNESS_LOCAL_FILE: join(dir, "settings.local.json"),
      HARNESS_PERSONALITY_FILE: join(dir, "personality.md"),
      NO_COLOR: "1",
    },
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

/** The account the harness saved for this agent, if it got as far as registering. */
function account(s: Session, i: number): { handle: string; token: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(instanceDir(s.id, i), "state.json"), "utf8")).accounts?.[s.appUrl];
  } catch {
    return undefined;
  }
}

async function matchCounts(token: string, appUrl: string): Promise<{ matches: number; open: number; sent: number } | undefined> {
  try {
    const c = new McpClient(appUrl);
    c.token = token;
    const text = (await c.call("list_matches", {})).text;
    const matches = JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)).matches as { status: string; last_message: { from_you: boolean } | null }[];
    return { matches: matches.length, open: matches.filter((m) => m.status === "open").length, sent: matches.filter((m) => m.last_message?.from_you).length };
  } catch {
    return undefined;
  }
}

// ---- main ------------------------------------------------------------------------------------
const resuming = flags.has("resume");
const roundMs = intFlag("round-minutes", process.env.ROUND_MINUTES, 15, 1, 240) * 60_000;
if (flags.has("delete") && flags.has("keep")) fail("Pick one of --delete and --keep.");
/** An explicit flag wins; otherwise a continued session keeps its own choice, and a new one deletes. */
const choice = (fallback: boolean): boolean => (flags.has("delete") ? true : flags.has("keep") || process.env.KEEP ? false : fallback);

let session: Session;
if (resuming) {
  const wanted = flags.get("resume") || listSessions().at(-1)?.id;
  if (!wanted) fail("There is no saved session to continue. Start a new one first.");
  if (!existsSync(join(sessionDir(wanted!), "session.json"))) fail(`No saved session "${wanted}". Run with --list to see them.`);
  session = loadSession(wanted!);
  session.deleteAtEnd = choice(session.deleteAtEnd);
  if (session.deleted) fail(`Session ${session.id} had its accounts deleted, so there is nothing to continue. Start a new one.`);
  if (flags.has("server") || flags.has("agents")) console.log("note: a continued session keeps its own server and agents; --server and --agents are ignored.");
  console.log(`continuing session ${session.id}: ${session.agents} agents on ${session.appUrl}, ${session.roundsDone} round(s) done`);
  // Prefer the model server the session used. Only if it no longer answers (or --llama says otherwise) look again.
  const saved = session.model.baseUrl ?? "";
  const hosted = session.model.type === "anthropic"; // a hosted model has no /models to probe; its key is checked when a call is made
  const stillUp = hosted || !flags.has("llama") && !process.env.LLAMA_URL && (await fetch(`${saved}/models`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false));
  if (stillUp) console.log(`model server: ${session.model.model} @ ${saved} (as before)`);
  else {
    if (!flags.has("llama") && !process.env.LLAMA_URL) console.log(`the model server this session used (${saved}) does not answer; looking for another`);
    session.model = await findModel();
  }
} else {
  const n = intFlag("agents", undefined, Number(bare[0] ?? 3), 1, 50);
  const appUrl = (flags.get("server") ?? process.env.APP_URL ?? "http://localhost:8081").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(appUrl)) fail("--server must start with http:// or https://");
  const model = await findModel();
  const id = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const run = Date.now().toString(36);
  const kw = intFlag("keywords", undefined, 2, 1, 5);
  session = {
    id,
    created: new Date().toISOString(),
    appUrl,
    model,
    agents: n,
    roundsDone: 0,
    deleteAtEnd: choice(true),
    deleted: false,
    instances: Array.from({ length: n }, (_, i) => ({ keywords: pickKeywords(kw), persona: "pending" as const })),
  };
  for (let i = 0; i < n; i++) mkdirSync(instanceDir(id, i), { recursive: true });
  saveSession(session);
}

const contextTokens = intFlag("context", process.env.CONTEXT_TOKENS, 40000, 4000, 1_000_000);
const rounds = intFlag("rounds", process.env.ROUNDS, 3, resuming ? 0 : 1, 100);
const delayMs = intFlag("round-delay", process.env.ROUND_DELAY, 0, 0, 240) * 60_000;
const model = session.model;
const del = session.deleteAtEnd;
saveSession(session);

// One llama.cpp slot serves one request at a time; the rest wait their turn.
if (model.type === "openai") try {
  const props: any = await (await fetch((model.baseUrl ?? "").replace(/\/v1$/, "") + "/props", { signal: AbortSignal.timeout(5000) })).json();
  if (props.total_slots < session.agents) console.warn(`note: the llama server has ${props.total_slots} slot(s) for ${session.agents} agents, so their model calls queue (each waits for the others). ADR-0005: more slots split the context, so raise -c with -np.`);
} catch {
  console.warn(`note: could not read ${model.baseUrl}/props. Is the llama.cpp server up?`);
}

// Settings per agent (the model may have changed on resume), and a personality for any agent that has none yet.
const todo = session.instances.map((inst, i) => ({ inst, i })).filter(({ inst }) => inst.persona === "pending");
if (todo.length) {
  console.log(`inventing ${todo.length} personalit${todo.length === 1 ? "y" : "ies"} (separate from Ribbon Cable: the model is only asked who it is)...`);
  await Promise.all(
    todo.map(async ({ inst, i }) => {
      const { text, source } = await makePersona(model, inst.keywords);
      inst.persona = source;
      writeFileSync(join(instanceDir(session.id, i), "persona.txt"), text + "\n");
      writeFileSync(join(instanceDir(session.id, i), "personality.md"), personalityFile(text));
      console.log(`  agent ${i + 1} [${inst.keywords.join(" + ")}]: ${wordCount(text)} words${source === "fallback" ? " (FALLBACK: the model gave nothing usable)" : ""}`);
    }),
  );
  saveSession(session);
}
for (let i = 0; i < session.agents; i++) {
  writeFileSync(
    join(instanceDir(session.id, i), "settings.local.json"),
    JSON.stringify({ serverUrl: session.appUrl, model: "load", thinking: "off", contextTokens, models: { load: model } }, null, 2),
  );
}

console.log(`${session.agents} agent(s), ${rounds} round(s), app ${session.appUrl}, model ${model.model} @ ${model.baseUrl}, accounts ${del ? "deleted at the end" : "kept"}\nsession ${session.id} (files: ${sessionDir(session.id)})`);
// Only agents that will be deleted go in the spec ledger: a later `pnpm check` sweeps the ledger, and must not eat a kept session.
// Handles are chosen by the agents, so they go in the ledger once registered (after each round).
const recorded = new Set<string>();
const recordJoined = (): void => {
  if (!del) return;
  for (let i = 0; i < session.agents; i++) {
    const a = account(session, i);
    if (a && !recorded.has(a.handle)) {
      recorded.add(a.handle);
      record(session.appUrl, a.handle);
    }
  }
};
recordJoined();

for (let r = 1; r <= rounds; r++) {
  const round = session.roundsDone + 1;
  const t0 = Date.now();
  // An agent with no account yet (its first attempt failed) is asked to join again, whatever round it is:
  // given the chat prompt it would invent its own handle and wander off.
  const codes = await Promise.all(session.instances.map((inst, i) => runHarness(session, i, account(session, i) ? CHAT : JOIN, round, roundMs)));
  session.roundsDone = round;
  saveSession(session);
  recordJoined();
  const bad = codes.filter((c) => c !== 0).length;
  const joined = session.instances.filter((_, i) => account(session, i)).length;
  console.log(`round ${round}: ${session.agents - bad}/${session.agents} processes finished in ${Math.round((Date.now() - t0) / 1000)}s${bad ? ` (${codes.map((c, i) => (c === 0 ? "" : `#${i + 1}:${c}`)).filter(Boolean).join(" ")})` : ""}; ${joined}/${session.agents} have an account on ${session.appUrl}`);
  // "finished" only means the process exited. Say plainly when nobody got an account, and stop burning model time on it.
  if (joined === 0) {
    console.error(`\nNo agent could register on ${session.appUrl}. Look at ${instanceDir(session.id, 0)}${process.platform === "win32" ? "\\" : "/"}round-${round}.log for the error, then continue with --resume.`);
    break;
  }
  if (r < rounds && delayMs) {
    console.log(`waiting ${delayMs / 60_000} min before round ${round + 1}...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

const handles: string[] = [];
console.log("\nagent  handle                    keywords                          registered  matches  open  talking");
for (let i = 0; i < session.agents; i++) {
  const a = account(session, i);
  if (a) handles.push(a.handle);
  const s = a ? await matchCounts(a.token, session.appUrl) : undefined;
  const inst = session.instances[i];
  console.log(`${String(i + 1).padEnd(6)} ${(a?.handle ?? "-").padEnd(25)} ${inst.keywords.join(" + ").slice(0, 33).padEnd(33)} ${(a ? "yes" : "NO").padEnd(11)} ${String(s?.matches ?? "-").padEnd(8)} ${String(s?.open ?? "-").padEnd(5)} ${s?.sent ?? "-"}`);
}

if (del) {
  const left = await deleteAccounts(session.appUrl, adminPassword(), handles);
  if (left) console.log(`\ncleanup: ${left} account(s) could not be deleted (is the admin login right for ${session.appUrl}?)`);
  else {
    session.deleted = true;
    saveSession(session);
    console.log("\ncleanup: accounts deleted through /admin");
  }
} else {
  console.log(`\nkept the accounts. Continue later with: node scripts/load.ts --resume ${session.id}`);
}

import { readFileSync } from "node:fs";
import { approxTokens, compactionSettings, cutPoint, summarize, updatePeople } from "./compact.ts";
import { chat, type Kind, type Msg } from "./llm.ts";
import { forget, indexForPrompt, peopleForPrompt, readMemory, readPerson, remember } from "./memory.ts";
import { findPending, type MatchInfo } from "./auto.ts";
import { McpClient, McpError, type ToolInfo } from "./mcp.ts";
import { modelLabel } from "./detect.ts";
import { calibrate, CALL_PROTOCOL, DIALECTS, nativeTools, otherDialect, savedDialect, saveDialect, SWITCH_AFTER, TEXT_DIALECTS, type DialectName } from "./dialect.ts";
import { activeProfile, clearAccount, getAccount, PERSONALITY_FILE, saveAccount, type Settings } from "./settings.ts";

export const MAX_WAIT_MINUTES = 30;

// ---- the tool-calling protocol ---------------------------------------------------------------
// As simple and as strict as it gets (ADR-0042): the model writes ONE line, `CALL name key=value key=value`,
// and the harness answers with `RESULT ...`. No JSON, no schemas, no provider-specific tool API, and no
// guessing: what runs is exactly what the model wrote, or the model gets an error that shows the right form.
// EXPERIMENTAL (ADR-0047): the protocol paragraph now depends on the model's dialect; CALL_PROTOCOL is the fallback.

const LOCAL_TOOLS: ToolInfo[] = [
  { name: "remember", description: "Save a note to your memory.", inputSchema: { properties: { name: { type: "string", minLength: 1, maxLength: 40 }, text: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["name", "text"] } },
  { name: "read_person", description: "Read your notes on another agent you have dealt with.", inputSchema: { properties: { handle: { type: "string", minLength: 1, maxLength: 40 } }, required: ["handle"] } },
  { name: "read_memory", description: "Read a saved note.", inputSchema: { properties: { name: { type: "string", minLength: 1, maxLength: 40 } }, required: ["name"] } },
  { name: "forget", description: "Delete a saved note.", inputSchema: { properties: { name: { type: "string", minLength: 1, maxLength: 40 } }, required: ["name"] } },
  {
    name: "wait",
    description: "Wait for news without spending tokens: until=new_message (a reply or a new match), new_profiles (someone new to swipe on) or any; minutes is the longest to wait.",
    inputSchema: { properties: { until: { type: "string", enum: ["new_message", "new_profiles", "any"] }, minutes: { type: "integer", minimum: 1, maximum: MAX_WAIT_MINUTES } } },
  },
];

const firstSentence = (s: string): string => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim().slice(0, 110);

/** A correct call for a tool, built from its schema: required arguments only, with a plausible value for each. */
export function exampleCall(t: ToolInfo, dialect: DialectName = "call"): string {
  const props = t.inputSchema.properties ?? {};
  const values: Record<string, string | number> = {};
  const words = (t.inputSchema.required ?? Object.keys(props).slice(0, 0)).map((k) => {
    const options: any[] = props[k]?.anyOf ?? [props[k] ?? {}];
    const str = options.find((s) => s.type === "string");
    if (str?.enum?.length) return `${k}=${(values[k] = str.enum[0])}`;
    if (options.some((s) => s.type === "integer" || s.type === "number")) return `${k}=${(values[k] = 3)}`;
    values[k] = "...";
    return `${k}="..."`;
  });
  if (dialect !== "call") return TEXT_DIALECTS[dialect].format(t.name, values);
  return `CALL ${t.name}${words.length ? " " + words.join(" ") : ""}`;
}

/** The part of an argument's schema the model needs to see: its choices, its largest length, or its range. */
function limitOf(v: any): string {
  const options: any[] = v.anyOf ?? [v];
  const str = options.find((s) => s.type === "string");
  const num = options.find((s) => s.type === "integer" || s.type === "number");
  if (str && Array.isArray(str.enum)) return `(${str.enum.join("|")})`;
  if (str) {
    const set = /^\^\[([^\]]+)\]\{(\d+),(\d+)\}\$$/.exec(str.pattern ?? "");
    if (set) return `(${set[1]}, ${set[2]}-${set[3]} chars)`;
    if (str.maxLength) return `(max ${str.maxLength})`;
  }
  if (num) {
    const sane = (n: unknown): n is number => typeof n === "number" && Math.abs(n) < 1e9;
    if (sane(num.minimum) && sane(num.maximum)) return `(${num.minimum}-${num.maximum})`;
  }
  return "";
}

/** `swipe handle direction(like|pass)`: one short line per tool, `*` marks a required argument, brackets the limits. */
export function toolLine(t: ToolInfo): string {
  const req = new Set(t.inputSchema.required ?? []);
  const args = Object.entries(t.inputSchema.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? "*" : ""}${limitOf(v)}`);
  return `${t.name} ${args.join(" ")}`.trim() + ` - ${firstSentence(t.description)}`;
}

// ---- parsing a CALL line ---------------------------------------------------------------------
// One form only. A call is a line that starts with `CALL`, then the tool's name, then `key=value` words. A value is
// a bare word or "double-quoted" (backslash-quote for a quote inside). Native tool tokens, JSON, values without a
// key, repeated keys, and words after the arguments are all errors. The model is never second-guessed: a call that
// is not exactly right does not run, which also means nothing can be smuggled into a call by what follows it.
export interface Call {
  name: string;
  args: Record<string, string>;
  /** the raw line the call was found on */
  line: string;
}
export interface CallError {
  error: string;
  /** the tool the model was calling, when it got that far (so the error can show its usage) */
  name?: string;
}
export const isCallError = (c: Call | CallError | null | undefined): c is CallError => !!c && "error" in c;

const cut = (s: string, n = 40): string => (s.length > n ? s.slice(0, n) + "…" : s);

/** The arguments after a tool's name, or a message saying what is wrong with them. */
function parseArgs(tail: string): Record<string, string> | string {
  const args: Record<string, string> = {};
  const n = tail.length;
  let i = 0;
  const skip = (): void => {
    while (i < n && /\s/.test(tail[i])) i++;
  };
  skip();
  while (i < n) {
    const m = /^([a-z_][a-z0-9_]*)=/.exec(tail.slice(i));
    if (!m) return `unexpected "${cut(tail.slice(i).split(/\s/)[0])}": every argument is written key=value, and nothing may follow the last one`;
    const key = m[1];
    i += m[0].length;
    if (key in args) return `${key} is given twice`;
    if (tail[i] === '"') {
      i++;
      let v = "";
      let closed = false;
      while (i < n) {
        const ch = tail[i++];
        if (ch === "\\" && (tail[i] === '"' || tail[i] === "\\")) v += tail[i++];
        else if (ch === '"') {
          closed = true;
          break;
        } else v += ch;
      }
      if (!closed) return `the quote opened for ${key} is never closed (keep the whole call on one line)`;
      if (i < n && !/\s/.test(tail[i])) return `after the closing quote of ${key} comes "${cut(tail.slice(i).split(/\s/)[0])}": put a space, then the next key=value`;
      args[key] = v;
    } else {
      let j = i;
      while (j < n && !/\s/.test(tail[j])) j++;
      const v = tail.slice(i, j);
      if (!v) return `${key} has no value`;
      if (v.includes('"')) return `${key}: put double quotes around the whole value, e.g. ${key}="two words"`;
      args[key] = v;
      i = j;
    }
    skip();
  }
  return args;
}

/**
 * Finds the call in a reply: the first line that starts with `CALL`. Prose without one is the model's answer (null).
 * A try at some other format (native tokens, JSON, a bare tool name) is an error, not a call.
 */
export function parseCall(reply: string, toolNames: string[]): Call | CallError | null {
  const lines = reply.split("\n");
  for (const raw of lines) {
    const line = raw.trimStart();
    if (!/^CALL(\s|$)/.test(line)) continue;
    const m = /^CALL\s+([a-z_][a-z0-9_]*)(?:\s+(.*))?$/s.exec(line.trimEnd());
    if (!m) return { error: "after CALL comes the tool's name, e.g. CALL whoami" };
    const args = parseArgs(m[2] ?? "");
    return typeof args === "string" ? { error: args, name: m[1] } : { name: m[1], args, line: raw };
  }
  if (/<\|?tool_call\|?>|<\/tool_call>|^\s*\{\s*"name"\s*:/m.test(reply)) {
    // Only to make the error useful: name the tool it was after, never to run it.
    const guess = reply.match(/<\|?tool_call\|?>\s*(?:call\s*[:=]?\s*)?([a-z_][a-z0-9_]*)/i)?.[1] ?? reply.match(/"name"\s*:\s*"([a-z_][a-z0-9_]*)"/)?.[1];
    return { error: "that is not the format used here (no <|tool_call> tokens, no JSON): the line must START with the word CALL", name: guess && toolNames.includes(guess) ? guess : undefined };
  }
  for (const raw of lines) {
    const word = raw.trim().match(/^[a-z_][a-z0-9_]*/)?.[0];
    if (word && toolNames.includes(word) && /^\s*(?:[a-z_][a-z0-9_]*=|$)/.test(raw.trim().slice(word.length))) return { error: `start the line with CALL: CALL ${word} ...`, name: word };
  }
  return null;
}

/**
 * Parse a reply in the agent's dialect (ADR-0047). The CALL dialect uses parseCall; the others use their own strict
 * parser. Values come back as strings so checkArgs types them the same way for every dialect.
 */
export function parseIn(dialect: DialectName | undefined, reply: string, toolNames: string[]): Call | CallError | null {
  if (!dialect || dialect === "call") return parseCall(reply, toolNames);
  const got = TEXT_DIALECTS[dialect].parse(reply);
  if (!got || "error" in got) {
    if (got) return got;
    // A model that still writes the CALL form is told which form it uses now, not silently obeyed.
    return /^\s*CALL\s+[a-z_]/m.test(reply) ? { error: `this model's calls are written in its own format here, not CALL` } : null;
  }
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(got.args)) args[k] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return { name: got.name, args, line: got.line };
}

/** The same word four times running outside quotes is a model stuck in a loop (`end=true end=true end=true end=true`). */
const looping = (text: string): boolean => {
  if (((text.match(/"/g) ?? []).length) % 2 === 1) return false; // inside a quoted value: a message can repeat itself
  const last = text.trimEnd().split(/\s+/).slice(-4);
  return last.length === 4 && last[0].length > 0 && last.every((w) => w === last[0]);
};
const MAX_CALL_CHARS = 3000;

/**
 * Where the first call in streamed `text` is finished, or -1 while it is still being written. The agent stops the
 * model there: everything after a call is invented, and a model that repeats itself would otherwise run to the
 * token limit (several minutes on a local model) and put the repetition into its own history.
 */
export function callEnd(text: string): number {
  let offset = 0;
  for (const raw of text.split("\n")) {
    const end = offset + raw.length;
    if (/^\s*CALL(\s|$)/.test(raw)) return end < text.length || looping(raw) || raw.length > MAX_CALL_CHARS ? end : -1;
    offset = end + 1;
  }
  return -1;
}

/** Checks the strings the model wrote against the tool's schema, strictly: nothing is repaired, only converted to the schema's types. */
export function checkArgs(tool: ToolInfo, call: Call): { args: Record<string, unknown> } | { error: string } {
  const props = tool.inputSchema.properties ?? {};
  const known = Object.keys(props);
  for (const k of Object.keys(call.args)) if (!(k in props)) return { error: `${tool.name} has no argument "${k}"${known.length ? `; its arguments are ${known.join(", ")}` : " and takes no arguments"}` };
  const missing = (tool.inputSchema.required ?? []).filter((k) => !(k in call.args));
  if (missing.length) return { error: `${tool.name} needs ${missing.join(", ")}` };
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(call.args)) {
    const r = typed(k, v, props[k]);
    if ("error" in r) return r;
    args[k] = r.value;
  }
  return { args };
}

function typed(k: string, v: string, schema: any): { value: unknown } | { error: string } {
  const options: any[] = schema.anyOf ?? [schema];
  const str = options.find((s) => s.type === "string");
  const num = options.find((s) => s.type === "integer" || s.type === "number");
  const arr = options.find((s) => s.type === "array");
  const bool = options.find((s) => s.type === "boolean");
  if (arr && v.trim().startsWith("[")) {
    try {
      const list = JSON.parse(v);
      if (Array.isArray(list)) return { value: list };
    } catch {}
    return { error: `${k} is not a valid list: write it as a quoted comma-separated string, e.g. ${k}="chess, tea"` };
  }
  if (str) {
    if (Array.isArray(str.enum) && !str.enum.includes(v)) return { error: `${k} must be one of ${str.enum.join(", ")}` };
    if (str.minLength && v.length < str.minLength) return { error: `${k} is empty` };
    if (str.maxLength && v.length > str.maxLength) return { error: `${k} is ${v.length} characters; the most allowed is ${str.maxLength}` };
    if (str.pattern && !new RegExp(str.pattern).test(v)) return { error: `${k} "${cut(v)}" is not allowed here (it must match ${str.pattern})` };
    return { value: v };
  }
  if (num) {
    if (!(num.type === "integer" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(v)) return { error: `${k} must be a number${num.type === "integer" ? " with no decimals" : ""}, written without quotes (got "${cut(v)}")` };
    const n = Number(v);
    if (typeof num.minimum === "number" && Math.abs(num.minimum) < 1e9 && n < num.minimum) return { error: `${k} must be at least ${num.minimum}` };
    if (typeof num.maximum === "number" && Math.abs(num.maximum) < 1e9 && n > num.maximum) return { error: `${k} must be at most ${num.maximum}` };
    return { value: n };
  }
  if (bool) return v === "true" || v === "false" ? { value: v === "true" } : { error: `${k} must be true or false` };
  return { value: v };
}

// ---- the agent -------------------------------------------------------------------------------
export interface Agent {
  history: Msg[];
  /** What compaction made of the part of the conversation that was cut (ADR-0025); shown to the model in the system prompt. */
  summary: string;
  mcp: McpClient;
  tools: ToolInfo[];
  settings: Settings;
  /** How this model writes tool calls (ADR-0047): decided once per model by calibration, then saved. */
  dialect?: DialectName;
  /** run one user turn to completion. With `live`, the model's output is shown as it is generated. */
  say(text: string, out: (s: string) => void, live?: Live): Promise<void>;
  refreshTools(): Promise<void>;
  setServer(url: string): Promise<void>;
  logout(): void;
  /** Summarize everything before the recent tail now. False when there was nothing to summarize or the model failed. */
  compact(out: (s: string) => void, instructions?: string, keepRecent?: number): Promise<boolean>;
  account(): { handle: string; token: string } | undefined;
  /** Parse one `CALL ...` line exactly as a reply would be and run it, returning the RESULT text. For tests and tools built on the agent. */
  runCall(line: string): Promise<string>;
  /** Decide (or load) this model's tool-call dialect now, without a turn (ADR-0047). */
  decideDialect(out: (s: string) => void): Promise<DialectName>;
}

/** Receives the model's output as it streams: `token` per piece, `end` when a reply is finished. */
export interface Live { token(kind: Kind, s: string): void; end(): void }

const MAX_RESULT_CHARS = 5000;
const CONTINUE = "(Your earlier steps were summarized above. Carry on with the task.)";

export function makeAgent(settings: Settings): Agent {
  const mcp = new McpClient(settings.serverUrl);
  const agent: Agent = {
    history: [],
    summary: "",
    mcp,
    tools: [],
    settings,
    dialect: undefined,
    decideDialect: (out) => decideDialect(out),
    refreshTools,
    say,
    setServer,
    logout,
    compact,
    account: () => getAccount(settings.serverUrl),
    runCall: async (line) => {
      const call = parseCall(line, [...agent.tools, ...LOCAL_TOOLS].map((t) => t.name));
      if (!call || isCallError(call)) return `ERROR: ${call ? call.error : "no CALL"}`;
      return runTool(call);
    },
  };

  function loadToken(): void {
    mcp.serverUrl = settings.serverUrl;
    mcp.token = getAccount(settings.serverUrl)?.token;
  }
  loadToken();

  async function refreshTools(): Promise<void> {
    agent.tools = await mcp.listTools();
  }

  async function setServer(url: string): Promise<void> {
    const previous = settings.serverUrl;
    settings.serverUrl = url.replace(/\/+$/, "");
    loadToken();
    try {
      await refreshTools();
    } catch (err) {
      settings.serverUrl = previous; // don't leave the agent pointing at a server that does not answer
      loadToken();
      throw err;
    }
    agent.history = [];
    agent.summary = "";
  }

  // Replies in a row written as a valid call in some other known dialect (ADR-0047's learning from use).
  let strays: DialectName[] = [];

  /** Ask the model once how it writes tool calls, unless it was asked before (saved per model) or HARNESS_DIALECT says. */
  async function decideDialect(out: (s: string) => void): Promise<DialectName> {
    await pickDialect(out);
    return agent.dialect!;
  }
  async function pickDialect(out: (s: string) => void): Promise<void> {
    if (agent.dialect) return;
    const p = activeProfile(settings);
    const forced = process.env.HARNESS_DIALECT as DialectName | undefined;
    if (forced && DIALECTS.includes(forced)) {
      agent.dialect = forced;
      out(`(tool-call dialect: ${forced}, from HARNESS_DIALECT)`);
      return;
    }
    const saved = savedDialect(p.model);
    if (saved) {
      agent.dialect = saved;
      return;
    }
    out("(first run with this model: asking how it writes tool calls...)");
    const { dialect, how } = await calibrate(p, out);
    agent.dialect = dialect;
    saveDialect(p.model, dialect, how);
    out(`(tool-call dialect: ${dialect}; ${how})`);
  }

  function logout(): void {
    mcp.token = undefined;
    clearAccount(settings.serverUrl);
  }

  function system(): string {
    const acct = getAccount(settings.serverUrl);
    const tools = [...agent.tools.map(toolLine), ...LOCAL_TOOLS.map(toolLine)].join("\n");
    const think =
      settings.thinking === "off" || activeProfile(settings).nativeThinking || activeProfile(settings).templateThinking || activeProfile(settings).type === "anthropic"
        ? ""
        : `\nBefore each action, think it through briefly inside <think></think>${settings.thinking === "high" ? ", carefully and in detail" : ""}.`;
    return [
      readFileSync(PERSONALITY_FILE, "utf8").trim(),
      `## Tools\n${agent.dialect && agent.dialect !== "call" ? TEXT_DIALECTS[agent.dialect].protocol : CALL_PROTOCOL}${think}\n\n${tools}\n(* = required)`,
      `## You\n${acct?.handle ? `You are logged in as @${acct.handle}. Your login is saved automatically: never ask for it or type it.` : "You have no account yet. Use register (invent your own handle, display_name and bio) before anything else."}`,
      ...(agent.summary ? [`## Earlier in this conversation\nYour older messages were cut to save space. This is a summary of them:\n${agent.summary}\n\nYou were in the middle of your work. Carry on with "Doing Right Now", then "Next Steps", and keep going with your standing task: do not stop or wait to be asked.`] : []),
      `## People you have dealt with\nYour notes on other agents, updated each time your memory is cut (use read_person handle=... for the full note):\n${peopleForPrompt()}`,
      `## Memory\nThings you saved earlier. Only these names exist (use read_memory name=... for details):\n${indexForPrompt()}`,
    ].join("\n\n");
  }

  const size = (): number => agent.history.reduce((n, m) => n + approxTokens(m.content), 0);

  /** Summarize the messages before the cut point into agent.summary and drop them (Pi-style, ADR-0025). */
  async function compact(out: (s: string) => void, instructions?: string, keepRecent = compactionSettings(settings).keepRecentTokens): Promise<boolean> {
    const cut = cutPoint(agent.history, keepRecent);
    if (!cut) return false;
    const c = compactionSettings(settings);
    const profile = c.model ? settings.models[c.model] : undefined;
    if (c.model && !profile) out(`! compaction.model "${c.model}" is not in models; using the current model`);
    const before = approxTokens(system()) + size();
    let text: string;
    try {
      text = await summarize(profile ?? activeProfile(settings), agent.history.slice(0, cut.index), agent.summary, instructions);
    } catch (err) {
      out(`! could not summarize (${(err as Error).message})`);
      return false;
    }
    agent.summary = text;
    // The address book is updated from the same messages, but never at the cost of the compaction itself.
    try {
      const names = await updatePeople(profile ?? activeProfile(settings), agent.history.slice(0, cut.index), getAccount(settings.serverUrl)?.handle);
      if (names.length) out(`(updated notes on ${names.map((n) => "@" + n).join(", ")})`);
    } catch (err) {
      out(`! could not update notes on people (${(err as Error).message})`);
    }
    agent.history = [...(cut.split ? [{ role: "user" as const, content: CONTINUE }] : []), ...agent.history.slice(cut.index)];
    out(`(compacted: ~${before} → ~${approxTokens(system()) + size()} tokens)`);
    return true;
  }

  /** Keep the conversation inside the context window: compact when it nears the limit; if that is off or fails, shrink old results, then drop old turns. */
  async function fit(out: (s: string) => void): Promise<void> {
    const c = compactionSettings(settings);
    if (c.enabled && approxTokens(system()) + size() > settings.contextTokens - c.reserveTokens) await compact(out);
    const budget = settings.contextTokens - approxTokens(system()) - 1500;
    for (let i = 0; i < agent.history.length - 4 && size() > budget; i++) {
      const m = agent.history[i];
      if (m.content.startsWith("RESULT") && m.content.length > 200) m.content = m.content.slice(0, 120) + " ...(old result trimmed)";
    }
    while (size() > budget && agent.history.length > 2) agent.history.splice(0, 2); // keeps user/assistant alternation
  }

  /**
   * Wait for news without a model call: poll the service (plain tool calls, no tokens) until a match has a new
   * message or a new match appears, or there is someone new to swipe on, or the time is up (ADR-0042).
   */
  // Messages and matches a `wait` has already told the agent about (or that were waiting when it first looked), kept
  // across calls: an unanswered message must not be announced as news again and again. It is the agent's own
  // business to answer it or not (ADR-0040).
  const announced = new Set<string>();
  let announcedFrom: string | undefined;

  async function waitFor(until: string, minutes: number): Promise<string> {
    // Never faster than once a second: the service allows 120 calls a minute per agent, and a wait makes two per poll.
    const pollMs = Math.max(1000, Number(process.env.HARNESS_WAIT_POLL_MS ?? 30_000));
    const now = Date.now();
    // A run with a time limit (the load test's rounds) cannot be waited past: stop a minute early so it ends cleanly.
    const runEnd = Number(process.env.HARNESS_RUN_DEADLINE ?? 0);
    const minuteMs = Number(process.env.HARNESS_WAIT_MINUTE_MS ?? 60_000); // shortened only by the tests
    const wanted = now + Math.min(Math.max(minutes, 1), MAX_WAIT_MINUTES) * minuteMs;
    const deadline = runEnd > 0 ? Math.min(wanted, runEnd - 60_000) : wanted;
    if (runEnd > 0 && deadline - now < pollMs) return "Time is up for this run: there is no time left to wait. Reply now with a one-line summary of what you did.";
    // One poll: the JSON in a tool's answer, or the error text. A failed poll (a rate limit, a dropped connection)
    // is tried again at the next interval; it must not end the agent's turn.
    let lastError = "";
    const poll = async (tool: string, args: Record<string, unknown>): Promise<any | undefined> => {
      try {
        const r = await mcp.call(tool, args);
        if (r.isError) {
          lastError = r.text.slice(0, 160);
          return undefined;
        }
        return JSON.parse(r.text.slice(0, r.text.lastIndexOf("}") + 1));
      } catch (err) {
        lastError = (err as Error).message.slice(0, 160);
        return undefined;
      }
    };
    const wantMessages = until !== "new_profiles";
    const wantProfiles = until !== "new_message";
    // Another account (a new login) starts with a clean slate.
    const me = getAccount(settings.serverUrl)?.handle;
    if (announcedFrom !== me) {
      announced.clear();
      announcedFrom = me;
    }
    let first = true;
    for (;;) {
      let seenAny = false;
      if (wantMessages) {
        const m = await poll("list_matches", {});
        if (m) {
          seenAny = true;
          const found = findPending(m.matches as MatchInfo[], announced);
          // What was already waiting the first time we looked is not news: only a change ends a wait.
          found.forEach((p) => announced.add(p.key));
          if (!first && found.length) {
            return found.map((p) => (p.kind === "new_match" ? `New match with @${p.match.with} (match_id ${p.match.match_id}).` : `@${p.match.with} wrote in match ${p.match.match_id}.`)).join("\n");
          }
        }
      }
      if (wantProfiles) {
        const p = await poll("get_next_profiles", { limit: 1 });
        if (p) {
          seenAny = true;
          if ((p.profiles ?? []).length > 0) return "There are profiles to swipe on: call get_next_profiles.";
        }
      }
      if (seenAny) first = false;
      if (Date.now() + pollMs > deadline) return lastError && !seenAny ? `ERROR: could not check the service while waiting (${lastError}).` : `Nothing new after ${Math.max(1, Math.round((deadline - now) / 60_000))} minute(s).`;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async function runTool(call: Call): Promise<string> {
    const local = LOCAL_TOOLS.find((t) => t.name === call.name);
    const tool = local ?? agent.tools.find((t) => t.name === call.name);
    if (!tool) return `ERROR: there is no tool called "${call.name}". Tools: ${[...agent.tools, ...LOCAL_TOOLS].map((t) => t.name).join(", ")}.`;
    const checked = checkArgs(tool, call);
    if ("error" in checked) return `ERROR: ${checked.error}\nUsage: ${toolLine(tool)}\nExample: ${exampleCall(tool, agent.dialect)}`;
    const args = checked.args;
    if (local) {
      const s = (k: string): string => String(args[k] ?? "");
      if (call.name === "wait") return waitFor(String(args.until ?? "any"), Number(args.minutes ?? 5));
      if (call.name === "read_person") return readPerson(s("handle")) || `You have no notes on "${s("handle")}".`;
      return call.name === "remember" ? remember(s("name"), s("text")) : call.name === "read_memory" ? readMemory(s("name")) : forget(s("name"));
    }
    // The harness knows which model is really running; small models invent or forget this, so always set it.
    if (call.name === "register") {
      const p = activeProfile(settings);
      args.model = modelLabel(p.label ?? p.model);
    }
    let r;
    try {
      r = await mcp.call(call.name, args);
    } catch (err) {
      // A schema complaint says what is wrong but not what right looks like: add the usage line.
      if (err instanceof McpError && /validation/i.test(err.message)) {
        throw new McpError(`${err.message.replace(/^MCP error -?\d+: /, "")}\nUsage: ${toolLine(tool)}`);
      }
      throw err;
    }
    let text = r.text;
    // Auto-save the login so the model never has to handle the token (ADR-0019).
    if ((call.name === "register" || call.name === "rotate_token") && !r.isError) {
      const token = text.match(/"token":\s*"([^"]+)"/)?.[1];
      if (token) {
        const handle = text.match(/"handle":\s*"([^"]+)"/)?.[1] ?? getAccount(settings.serverUrl)?.handle ?? "";
        saveAccount(settings.serverUrl, handle, token);
        mcp.token = token;
        // The agent's own name and handle go in its memory straight away (ADR-0042), so it never has to guess them.
        if (call.name === "register" && handle) remember("me", `I am @${handle}, display name "${String(args.display_name ?? "")}". Bio: ${String(args.bio ?? "")}`);
        text = text.replace(token, "(saved automatically)");
        text += "\nYou are now logged in. Your login was saved: you do not need to do anything with it.";
        refreshTools().catch(() => {});
      }
    }
    // The server sends JSON then a plain-English line; compact the JSON so small models see less noise.
    text = text.replace(/\{[\s\S]*\}/, (j) => {
      try {
        return JSON.stringify(JSON.parse(j));
      } catch {
        return j;
      }
    });
    return (r.isError && !text.startsWith("ERROR") ? "ERROR: " : "") + text.slice(0, MAX_RESULT_CHARS);
  }

  /**
   * Notes on the people a turn dealt with are written when the turn ends, not only at compaction (ADR-0039): a short
   * run, or a one-shot `-p` run like the load test's, never reaches the context limit, so its agent would otherwise
   * start the next run knowing nobody. A failure here never fails the turn.
   */
  async function noteTurn(turn: Msg[], out: (s: string) => void): Promise<void> {
    if (settings.notesEachTurn === false || !turn.length) return;
    // Only a turn that touched a conversation is worth a note: a swipe-only turn would write one on every profile it glanced at.
    if (!turn.some((m) => m.role === "assistant" && /(?:send_message|get_conversation|end_conversation)/.test(m.content))) return;
    try {
      const names = await updatePeople(activeProfile(settings), turn, getAccount(settings.serverUrl)?.handle);
        out(names.length ? `(updated notes on ${names.map((n) => "@" + n).join(", ")})` : "(no notes written: no one in this turn, or the model's reply had no usable note)");
    } catch (err) {
      out(`! could not update notes on people (${(err as Error).message})`);
    }
  }

  async function say(text: string, out: (s: string) => void, live?: Live): Promise<void> {
    const turn: Msg[] = [];
    try {
      await run(text, out, live, turn);
    } finally {
      await noteTurn(turn, out);
    }
  }

  async function run(text: string, out: (s: string) => void, live: Live | undefined, turn: Msg[]): Promise<void> {
    if (!agent.tools.length) await refreshTools();
    await decideDialect(out);
    agent.history.push({ role: "user", content: text });
    for (let step = 0; step < settings.maxSteps; step++) {
      await fit(out);
      // Stop generating where the model invents a RESULT, or once its first call is complete: the rest would be
      // made up, and a model that repeats itself would otherwise run to the token limit.
      const toolNames = [...agent.tools, ...LOCAL_TOOLS].map((t) => t.name);
      let shown = "";
      const sink = (kind: Kind, s: string): boolean => {
        if (kind === "think") {
          live?.token("think", s);
          return false;
        }
        shown += s;
        const result = shown.search(/\n\s*RESULT\b/);
        const done = agent.dialect && agent.dialect !== "call" ? TEXT_DIALECTS[agent.dialect].end(shown) : callEnd(shown);
        const cut = Math.min(result < 0 ? Infinity : result, done < 0 ? Infinity : done);
        if (cut === Infinity) {
          live?.token("text", s);
          return false;
        }
        const before = s.length - (shown.length - cut);
        if (before > 0) live?.token("text", s.slice(0, before));
        return true;
      };
      let got;
      try {
        got = await chat(activeProfile(settings), system(), agent.history, settings.thinking, sink, agent.dialect === "native" ? nativeTools([...agent.tools, ...LOCAL_TOOLS]) : undefined);
      } catch (err) {
        // The model server could not parse the tool call the model just made (llama.cpp answers 500): that is a
        // broken call, not a broken harness. Tell the model and carry on.
        // llama.cpp words it two ways: a 500 re-parsing the call, or a stream error when output breaks its tool format
        if (!/tool call|tool_call|does not match the expected .*format/i.test((err as Error).message)) throw err;
        live?.end();
        out(`! the model's tool call was broken (${(err as Error).message.slice(0, 120)})`);
        agent.history.push({ role: "assistant", content: "(a tool call whose arguments were not valid JSON)" });
        agent.history.push({ role: "user", content: "RESULT ERROR: not run: your tool call was cut off or its arguments were not valid JSON. Make the call again, short and complete." });
        turn.push(...agent.history.slice(-2));
        continue;
      }
      live?.end();
      const reasoning = got.reasoning;
      let reply = got.text.replace(/\n\s*RESULT\b[\s\S]*$/, "").trim();
      if (process.env.HARNESS_DEBUG) console.error(`--- model said:\n${reply}\n---`);
      const visible = reply.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
      // Only the visible answer is read: a call written inside the model's thinking does not run.
      let call = parseIn(agent.dialect, visible, toolNames);
      // Learning from use: replies that keep coming out as valid calls in another known dialect switch the agent to it.
      const stray = (!call || isCallError(call)) && agent.dialect ? otherDialect(agent.dialect, visible, toolNames) : undefined;
      strays = stray && (!strays.length || strays[0] === stray) ? [...strays, stray] : [];
      if (stray && strays.length >= SWITCH_AFTER) {
        out(`(switching tool-call dialect ${agent.dialect} -> ${stray}: the last ${strays.length} replies were ${stray} calls)`);
        agent.dialect = stray;
        saveDialect(activeProfile(settings).model, stray, `switched in use after ${strays.length} ${stray} replies`);
        strays = [];
        call = parseIn(agent.dialect, visible, toolNames);
      }
      // Keep only up to the first call in history: models imitate what they said before, and a reply that
      // planned five calls and invented their results teaches them to do it again.
      const found = call && !isCallError(call) ? call : undefined;
      const at = found ? reply.indexOf(found.line) : -1;
      const kept = found && at >= 0 ? reply.slice(0, at + found.line.length) : reply;
      agent.history.push({ role: "assistant", content: kept || "(no reply)" });
      turn.push(agent.history[agent.history.length - 1]);
      if (!call) {
        if (!live) out(visible || "(no reply)");
        else if (!visible) out(reasoning ? "(no answer: it used up its token budget thinking; raise maxTokens in settings.json)" : "(no reply)");
        return;
      }
      let result: string;
      if (isCallError(call)) {
        const tool = [...agent.tools, ...LOCAL_TOOLS].find((t) => t.name === call.name);
        // Show what to write, not only what was wrong: a model told "wrong" with no example repeats itself.
        const swipe = { name: "swipe", description: "", inputSchema: { properties: { handle: { type: "string" }, direction: { type: "string", enum: ["like", "pass"] } }, required: ["handle", "direction"] } };
        const example = exampleCall(tool ?? swipe, agent.dialect);
        result = `ERROR: not run: ${call.error}.\nYour last reply was NOT understood and nothing happened. Write your call exactly like this:\n${example}${tool ? `\nUsage: ${toolLine(tool)}` : ""}`;
        out(`! ${call.error}`);
      } else {
        if (!live) out(`> ${call.name} ${Object.entries(call.args).map(([k, v]) => `${k}=${v.length > 40 ? v.slice(0, 40) + "…" : v}`).join(" ")}`);
        if (live) out(`> ${call.name} [${agent.dialect}]`);
        try {
          result = await runTool(call);
        } catch (err) {
          if (!(err instanceof McpError)) throw err;
          result = `ERROR: ${err.message}`;
        }
        out(`  ${(result.startsWith("ERROR") ? result.split("\n")[0] : result.split("\n").pop()!).slice(0, 200)}`);
        if (agent.dialect === "call" && visible.split("\n").filter((l) => /^\s*CALL\b/.test(l)).length > 1) result += "\n(Only your first CALL ran. Do one CALL at a time and wait for RESULT.)";
      }
      agent.history.push({ role: "user", content: `RESULT ${result}` });
      turn.push(agent.history[agent.history.length - 1]);
    }
    out(`(stopped after ${settings.maxSteps} steps; say "continue" to go on)`);
  }

  return agent;
}

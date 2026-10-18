import { readFileSync } from "node:fs";
import { approxTokens, compactionSettings, cutPoint, summarize, updatePeople } from "./compact.ts";
import { chat, type Kind, type Msg } from "./llm.ts";
import { forget, indexForPrompt, peopleForPrompt, readMemory, readPerson, remember } from "./memory.ts";
import { McpClient, McpError, type ToolInfo } from "./mcp.ts";
import { modelLabel } from "./detect.ts";
import { activeProfile, clearAccount, getAccount, PERSONALITY_FILE, saveAccount, type Settings } from "./settings.ts";

// ---- the tool-calling protocol ---------------------------------------------------------------
// As simple as it gets: the model writes ONE line, `CALL name key=value key=value`, and the harness
// answers with `RESULT ...`. No JSON, no schemas, no provider-specific tool API. A 3B model can do it,
// and the same text works for llama.cpp, OpenAI and Anthropic alike.
const PROTOCOL = `To do something, write one line and nothing else:
CALL tool_name key=value key=value
Example: CALL swipe handle=bob direction=like
Put quotes around values with spaces. Then wait: I will answer with RESULT.
As soon as the task is done, stop calling tools and reply with a short summary (no CALL).`;

const LOCAL_TOOLS: ToolInfo[] = [
  { name: "remember", description: "Save a note to your memory.", inputSchema: { properties: { name: { type: "string" }, text: { type: "string" } }, required: ["name", "text"] } },
  { name: "read_person", description: "Read your notes on another agent you have dealt with.", inputSchema: { properties: { handle: { type: "string" } }, required: ["handle"] } },
  { name: "read_memory", description: "Read a saved note.", inputSchema: { properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "forget", description: "Delete a saved note.", inputSchema: { properties: { name: { type: "string" } }, required: ["name"] } },
];

const firstSentence = (s: string): string => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim().slice(0, 110);

/** `swipe handle direction(like|pass)`: one short line per tool, `*` marks a required argument. */
export function toolLine(t: ToolInfo): string {
  const req = new Set(t.inputSchema.required ?? []);
  const args = Object.entries(t.inputSchema.properties ?? {}).map(([k, v]) => {
    const opts = Array.isArray(v.enum) ? `(${v.enum.join("|")})` : "";
    return `${k}${req.has(k) ? "*" : ""}${opts}`;
  });
  return `${t.name} ${args.join(" ")}`.trim() + ` - ${firstSentence(t.description)}`;
}

// ---- parsing a CALL line ---------------------------------------------------------------------
export interface Call {
  name: string;
  args: Record<string, string>;
  /** bare values with no key, e.g. `CALL swipe bob like`; matched to the tool's arguments in order */
  positional: string[];
  json?: Record<string, unknown>;
  /** the raw line the call was found on */
  line: string;
}

/**
 * Split on spaces, keeping "quoted strings" and 'quoted strings' together (key="a b" -> key=a b). `quoted` says a
 * quote was used in that word: a quoted value is complete, so anything after it is not part of it.
 */
function words(s: string): { w: string; quoted: boolean }[] {
  const out: { w: string; quoted: boolean }[] = [];
  let cur = "";
  let quote = "";
  let started = false;
  let quoted = false;
  const push = (): void => {
    out.push({ w: cur, quoted });
    cur = "";
    started = false;
    quoted = false;
  };
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'" || ch === "“" || ch === "”") {
      quote = ch === "“" ? "”" : ch;
      started = true;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) push();
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started || cur) push();
  return out;
}

// (`RESULT` too: a model that has only seen RESULT lines sometimes starts its own call with it)
const CALL_PREFIX = /^[`>*\- ]*((CALL|RESULT):?\s+)?/i;

// Models trained on their own tool-calling format write it even when told to use CALL: Gemma writes
// `<|tool_call>call swipe handle="x" direction="like"<tool_call|>` or `<|tool_call>call:swipe{handle:<|"|>x<|"|>}`,
// Qwen and Hermes write `<tool_call>{"name":"swipe","arguments":{...}}</tool_call>`. All of them are read as calls.
const NATIVE_OPEN = /<\|?tool_call\|?>/;
const NATIVE_END = /<\|?tool_call\|?>|<\/tool_call>|<tool_call\|>|<\|\/tool_call\|>/;
// `call swipe`, `call:swipe`, `call tool_name:swipe`: the words some formats put before the tool's name
const NATIVE_LEAD = /^(?:(?:call|tool_name|name|function)(?:\s*[:=]\s*|\s+))+/i;

/** Where the first native tool call in `text` is: from its opener to the next opener or closer, or to the end if still open. */
function nativeSegment(text: string): { start: number; end: number; closed: boolean } | null {
  const open = NATIVE_OPEN.exec(text);
  if (!open) return null;
  const from = open.index + open[0].length;
  const stop = NATIVE_END.exec(text.slice(from));
  return { start: open.index, end: stop ? from + stop.index : text.length, closed: Boolean(stop) };
}

/** A JSON object, also in Gemma's relaxed form: `{handle:<|"|>bob<|"|>,limit:5}`. */
function looseObject(text: string): Record<string, unknown> | undefined {
  const body = text.slice(0, text.lastIndexOf("}") + 1);
  for (const candidate of [body, body.replace(/<\|"\|>/g, '"').replace(/([{,]\s*)([a-z_][a-z0-9_]*)\s*:/gi, '$1"$2":')]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {}
  }
  return undefined;
}

/** `limit=5 handle="a b" bio=Hello there`: what follows a tool's name. Words after a quoted value are not part of it. */
function parseTail(name: string, tail: string, line: string): Call | "malformed" {
  if (tail.startsWith("{")) {
    const json = looseObject(tail);
    return json ? { name, args: {}, positional: [], json, line } : "malformed";
  }
  const args: Record<string, string> = {};
  const positional: string[] = [];
  let last: string | undefined;
  let lastQuoted = false;
  for (const { w, quoted } of words(tail)) {
    const eq = w.indexOf("=");
    if (eq > 0 && /^[a-z_][a-z0-9_]*$/i.test(w.slice(0, eq))) {
      if (last) args[last] = args[last].replace(/,+$/, ""); // models like `a=1, b=2`
      if (w.slice(0, eq) in args) break; // a key twice is a model starting over or looping: the call ended before it
      last = w.slice(0, eq);
      args[last] = w.slice(eq + 1);
      lastQuoted = quoted;
    } else if (last && !lastQuoted) args[last] += ` ${w}`; // an unquoted value that contains spaces
    else positional.push(w);
  }
  if (last) args[last] = args[last].replace(/,+$/, "");
  return { name, args, positional, line };
}

/** One line of a reply as a call: `CALL name ...`, or a bare `name ...` for a known tool. */
function parseLine(raw: string, toolNames: string[]): Call | "malformed" | null {
  const line = raw.trim().replace(CALL_PREFIX, (m) => (/call|result/i.test(m) ? "CALL " : "")).replace(/`+$/, "");
  const hasCall = /^CALL\s/.test(line);
  const rest = line.replace(/^CALL\s+/, "");
  const name = rest.match(/^[a-z_][a-z0-9_]*/i)?.[0];
  if (hasCall && !name) return "malformed";
  if (!name || !(hasCall || toolNames.includes(name))) return null;
  return parseTail(name, rest.slice(name.length).trim(), raw);
}

/** The call inside a native segment, or "malformed". Only the first line of it counts unless it is a JSON object. */
function parseNative(seg: string): Call | "malformed" {
  let body = seg.replace(NATIVE_OPEN, "").trim();
  if (body.startsWith("{")) {
    const obj = looseObject(body);
    const name = obj?.name;
    if (typeof name !== "string") return "malformed";
    const argsObj = obj!.arguments ?? obj!.parameters;
    return { name, args: {}, positional: [], json: argsObj && typeof argsObj === "object" ? (argsObj as Record<string, unknown>) : {}, line: seg };
  }
  body = (body.split("\n")[0] ?? "").trim().replace(NATIVE_LEAD, "");
  const name = body.match(/^[a-z_][a-z0-9_]*/i)?.[0];
  return name ? parseTail(name, body.slice(name.length).trim(), seg) : "malformed";
}

/**
 * Finds the first tool call in a reply. Small models are sloppy, so this forgives: a missing `CALL`,
 * backticks, a JSON object for the arguments, unquoted values with spaces, bare values with no `key=`,
 * and the model's own native tool-call tokens (see above).
 */
export function parseCall(reply: string, toolNames: string[]): Call | "malformed" | null {
  let offset = 0;
  for (const raw of reply.split("\n")) {
    const at = raw.search(NATIVE_OPEN);
    if (at >= 0) {
      const seg = nativeSegment(reply.slice(offset + at))!;
      return parseNative(reply.slice(offset + at, offset + at + seg.end));
    }
    const found = parseLine(raw, toolNames);
    if (found) return found;
    offset += raw.length + 1;
  }
  return null;
}

/** The same word four times running outside quotes is a model stuck in a loop (`end=true end=true end=true end=true`). */
const looping = (text: string): boolean => {
  if (((text.match(/"/g) ?? []).length) % 2 === 1) return false; // inside a quoted value: a message can repeat itself
  const last = text.trimEnd().split(/\s+/).slice(-4);
  return last.length === 4 && last[0].length > 0 && last.every((w) => w === last[0]);
};
const MAX_CALL_CHARS = 3000;

/** Where an unquoted word longer than `max` characters starts, or -1: junk such as `end_thought/out/thought//out/...` growing without end. */
export function longWordAt(text: string, max = 60): number {
  let quote = "";
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i] ?? " ";
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (/\s/.test(ch)) start = -1;
    else if (start < 0) start = i;
    else if (i - start > max) return start;
  }
  return -1;
}

/** Where an argument name (`key=`) appears for the second time in a call, outside quotes, or -1. A model that does this is repeating itself. */
export function repeatedKeyAt(text: string): number {
  const seen = new Set<string>();
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/[a-z_]/i.test(ch) && (i === 0 || /[\s,]/.test(text[i - 1]))) {
      const key = /^[a-z_][a-z0-9_]*(?==)/i.exec(text.slice(i))?.[0];
      if (key) {
        if (seen.has(key)) return i;
        seen.add(key);
        i += key.length;
      }
    }
  }
  return -1;
}

/**
 * Where the first tool call in streamed `text` is finished, or -1 while it is still being written. The agent stops
 * the model there: everything after a call is invented, and a model that repeats itself would otherwise run
 * to the token limit (several minutes on a local model) and put the repetition into its own history.
 */
export function callEnd(text: string, toolNames: string[]): number {
  const seg = nativeSegment(text);
  if (seg) {
    if (seg.closed) return seg.end;
    const body = text.slice(seg.start).replace(NATIVE_OPEN, "").replace(/^\s+/, "");
    const nl = body.indexOf("\n");
    if (!body.startsWith("{") && nl > 0) return text.length - body.length + nl;
    const again = body.startsWith("{") ? -1 : repeatedKeyAt(body);
    if (again > 0) return text.length - body.length + again;
    const junk = body.startsWith("{") ? -1 : longWordAt(body);
    if (junk > 0) return text.length - body.length + junk;
    return looping(body) || body.length > MAX_CALL_CHARS ? text.length : -1;
  }
  let offset = 0;
  for (const raw of text.split("\n")) {
    const end = offset + raw.length;
    const complete = end < text.length; // a newline follows: the model has moved on
    const found = parseLine(raw, toolNames);
    if (found && found !== "malformed") {
      const again = repeatedKeyAt(raw);
      if (again > 0) return offset + again;
      const junk = longWordAt(raw);
      if (junk > 0) return offset + junk;
      return complete || looping(raw) || raw.length > MAX_CALL_CHARS ? end : -1;
    }
    offset = end + 1;
  }
  return -1;
}

/** Turn the strings the model wrote into the types the tool's schema wants. */
export function coerce(tool: ToolInfo, call: Call): Record<string, unknown> {
  const props = tool.inputSchema.properties ?? {};
  const byLower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  const out: Record<string, unknown> = { ...call.json };
  if (Object.keys(props).length) for (const k of Object.keys(out)) if (!(k in props)) delete out[k];
  const given: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.args)) given[byLower.get(k.toLowerCase()) ?? k] = v;
  const free = Object.keys(props).filter((k) => !(k in given) && !(k in out));
  call.positional.forEach((v, i) => {
    if (free[i]) given[free[i]] = v;
  });
  const known = Object.keys(props).length > 0;
  for (const [k, raw] of Object.entries(given)) {
    // A model's stray words (`end=true`, `end_thought`) are not arguments of this tool: leave them out.
    if (known && !(k in props)) continue;
    const schemas: any[] = props[k]?.anyOf ?? [props[k] ?? {}];
    const types: string[] = schemas.map((s) => s.type);
    let v = raw.trim();
    // A value can carry junk after it (`limit=5 end`, `direction=like end`): take the part the schema wants.
    const options: string[] | undefined = schemas.find((s) => Array.isArray(s.enum))?.enum;
    if (options && !options.includes(v)) {
      const hit = v.split(/[^a-z0-9_]+/i).find((w) => options.some((o) => o.toLowerCase() === w.toLowerCase()));
      if (hit) v = options.find((o) => o.toLowerCase() === hit.toLowerCase())!;
    }
    const pattern = schemas.find((s) => s.pattern)?.pattern;
    if (pattern && !new RegExp(pattern).test(v)) {
      const fixed = v.toLowerCase().replace(/[\s-]+/g, "_"); // "AI Bee" -> "ai_bee" for handles
      if (new RegExp(pattern).test(fixed)) v = fixed;
    }
    if (types.includes("string") && !types.includes("array")) out[k] = v;
    else if (types.includes("number") || types.includes("integer")) {
      const num = v.replace(/^#/, "").match(/^-?\d+(\.\d+)?/);
      out[k] = Number(num ? num[0] : v.replace(/^#/, ""));
    } else if (types.includes("boolean")) out[k] = /^(true|yes|1)$/i.test(v.split(/\s+/)[0]);
    else if (types.includes("array")) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v; // the server accepts "a, b" for interests (ADR-0011)
      }
    } else out[k] = v;
  }
  return out;
}

// ---- the agent -------------------------------------------------------------------------------
export interface Agent {
  history: Msg[];
  /** What compaction made of the part of the conversation that was cut (ADR-0025); shown to the model in the system prompt. */
  summary: string;
  mcp: McpClient;
  tools: ToolInfo[];
  settings: Settings;
  /** run one user turn to completion. With `live`, the model's output is shown as it is generated. */
  say(text: string, out: (s: string) => void, live?: Live): Promise<void>;
  refreshTools(): Promise<void>;
  setServer(url: string): Promise<void>;
  logout(): void;
  /** Summarize everything before the recent tail now. False when there was nothing to summarize or the model failed. */
  compact(out: (s: string) => void, instructions?: string, keepRecent?: number): Promise<boolean>;
  account(): { handle: string; token: string } | undefined;
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
    refreshTools,
    say,
    setServer,
    logout,
    compact,
    account: () => getAccount(settings.serverUrl),
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
      `## Tools\n${PROTOCOL}${think}\n\n${tools}\n(* = required)`,
      `## You\n${acct?.handle ? `You are logged in as @${acct.handle}. Your login is saved automatically: never ask for it or type it.` : "You have no account yet. Use register (invent your own handle, display_name and bio) before anything else."}`,
      ...(agent.summary ? [`## Earlier in this conversation\nYour older messages were cut to save space. This is a summary of them:\n${agent.summary}\n\nYou were in the middle of your work. Carry on with "Doing Right Now", then "Next Steps", and keep going with your standing task: do not stop or wait to be asked.`] : []),
      `## People you have dealt with\nYour notes on other agents, updated each time your memory is cut (use read_person handle=... for the full note):\n${peopleForPrompt()}`,
      `## Memory\nThings you saved earlier (use read_memory name=... for details):\n${indexForPrompt()}`,
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

  async function runTool(call: Call): Promise<string> {
    const local = LOCAL_TOOLS.find((t) => t.name === call.name);
    const tool = local ?? agent.tools.find((t) => t.name === call.name);
    if (!tool) return `ERROR: there is no tool called "${call.name}". Tools: ${[...agent.tools, ...LOCAL_TOOLS].map((t) => t.name).join(", ")}.`;
    const args = coerce(tool, call);
    if (local) {
      const s = (k: string): string => String(args[k] ?? "");
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
        const done = callEnd(shown, toolNames);
        const cut = Math.min(result < 0 ? Infinity : result, done < 0 ? Infinity : done);
        if (cut === Infinity) {
          live?.token("text", s);
          return false;
        }
        const before = s.length - (shown.length - cut);
        if (before > 0) live?.token("text", s.slice(0, before));
        return true;
      };
      const got = await chat(activeProfile(settings), system(), agent.history, settings.thinking, sink);
      live?.end();
      const reasoning = got.reasoning;
      let reply = got.text.replace(/\n\s*RESULT\b[\s\S]*$/, "").trim();
      if (process.env.HARNESS_DEBUG) console.error(`--- model said:\n${reply}\n---`);
      const visible = reply.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
      // Small models sometimes write the call inside <think>; if the visible text has none, look there too.
      const call = parseCall(visible, toolNames) ?? parseCall((reply + "\n" + reasoning).replace(/<\/?think>/g, ""), toolNames);
      // Keep only up to the first call in history: models imitate what they said before, and a reply that
      // planned five calls and invented their results teaches them to do it again.
      const found = call && call !== "malformed" ? call : undefined;
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
      if (call === "malformed") {
        result = 'ERROR: I could not read that. Write exactly: CALL tool_name key=value key=value  (example: CALL swipe handle=bob direction=like)';
        out("! malformed CALL");
      } else {
        if (!live) out(`> ${call.name} ${call.positional.join(" ")} ${Object.entries(call.args).map(([k, v]) => `${k}=${v.length > 40 ? v.slice(0, 40) + "…" : v}`).join(" ")}`);
        try {
          result = await runTool(call);
        } catch (err) {
          if (!(err instanceof McpError)) throw err;
          result = `ERROR: ${err.message}`;
        }
        out(`  ${result.split("\n").pop()!.slice(0, 200)}`);
        if (visible.split("\n").filter((l) => /^[`>*\- ]*CALL\b/i.test(l.trim())).length > 1) result += "\n(Only your first CALL ran. Do one CALL at a time and wait for RESULT.)";
      }
      agent.history.push({ role: "user", content: `RESULT ${result}` });
      turn.push(agent.history[agent.history.length - 1]);
    }
    out(`(stopped after ${settings.maxSteps} steps; say "continue" to go on)`);
  }

  return agent;
}

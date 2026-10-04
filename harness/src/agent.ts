import { readFileSync } from "node:fs";
import { chat, type Msg } from "./llm.ts";
import { forget, indexForPrompt, readMemory, remember } from "./memory.ts";
import { McpClient, McpError, type ToolInfo } from "./mcp.ts";
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

/** Split on spaces, keeping "quoted strings" and 'quoted strings' together (key="a b" -> key=a b). */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let started = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'" || ch === "“" || ch === "”") {
      quote = ch === "“" ? "”" : ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started || cur) out.push(cur);
  return out;
}

// (`RESULT` too: a model that has only seen RESULT lines sometimes starts its own call with it)
const CALL_PREFIX = /^[`>*\- ]*((CALL|RESULT):?\s+)?/i;

/**
 * Finds the first tool call in a reply. Small models are sloppy, so this forgives: a missing `CALL`,
 * backticks, a JSON object for the arguments, unquoted values with spaces, bare values with no `key=`.
 */
export function parseCall(reply: string, toolNames: string[]): Call | "malformed" | null {
  for (const raw of reply.split("\n")) {
    const line = raw.trim().replace(CALL_PREFIX, (m) => (/call|result/i.test(m) ? "CALL " : "")).replace(/`+$/, "");
    const hasCall = /^CALL\s/.test(line);
    const rest = line.replace(/^CALL\s+/, "");
    const name = rest.match(/^[a-z_][a-z0-9_]*/i)?.[0];
    if (hasCall && !name) return "malformed";
    if (!name || !(hasCall || toolNames.includes(name))) continue;
    const tail = rest.slice(name.length).trim();
    if (tail.startsWith("{")) {
      try {
        return { name, args: {}, positional: [], json: JSON.parse(tail), line: raw };
      } catch {
        return "malformed";
      }
    }
    const args: Record<string, string> = {};
    const positional: string[] = [];
    let last: string | undefined;
    for (const w of words(tail)) {
      const eq = w.indexOf("=");
      if (eq > 0 && /^[a-z_][a-z0-9_]*$/i.test(w.slice(0, eq))) {
        if (last) args[last] = args[last].replace(/,+$/, ""); // models like `a=1, b=2`
        last = w.slice(0, eq);
        args[last] = w.slice(eq + 1);
      } else if (last) args[last] += ` ${w}`; // an unquoted value that contains spaces
      else positional.push(w);
    }
    if (last) args[last] = args[last].replace(/,+$/, "");
    return { name, args, positional, line: raw };
  }
  return null;
}

/** Turn the strings the model wrote into the types the tool's schema wants. */
export function coerce(tool: ToolInfo, call: Call): Record<string, unknown> {
  const props = tool.inputSchema.properties ?? {};
  const byLower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  const out: Record<string, unknown> = { ...call.json };
  const given: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.args)) given[byLower.get(k.toLowerCase()) ?? k] = v;
  const free = Object.keys(props).filter((k) => !(k in given) && !(k in out));
  call.positional.forEach((v, i) => {
    if (free[i]) given[free[i]] = v;
  });
  for (const [k, raw] of Object.entries(given)) {
    const schemas: any[] = props[k]?.anyOf ?? [props[k] ?? {}];
    const types: string[] = schemas.map((s) => s.type);
    let v = raw.trim();
    const pattern = schemas.find((s) => s.pattern)?.pattern;
    if (pattern && !new RegExp(pattern).test(v)) {
      const fixed = v.toLowerCase().replace(/[\s-]+/g, "_"); // "AI Bee" -> "ai_bee" for handles
      if (new RegExp(pattern).test(fixed)) v = fixed;
    }
    if (types.includes("string") && !types.includes("array")) out[k] = v;
    else if (types.includes("number") || types.includes("integer")) out[k] = Number(v.replace(/^#/, ""));
    else if (types.includes("boolean")) out[k] = /^(true|yes|1)$/i.test(v);
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
  mcp: McpClient;
  tools: ToolInfo[];
  settings: Settings;
  /** run one user turn to completion */
  say(text: string, out: (s: string) => void): Promise<void>;
  refreshTools(): Promise<void>;
  setServer(url: string): Promise<void>;
  logout(): void;
  account(): { handle: string; token: string } | undefined;
}

const MAX_RESULT_CHARS = 5000;
const approxTokens = (s: string): number => Math.ceil(s.length / 3.5);

export function makeAgent(settings: Settings): Agent {
  const mcp = new McpClient(settings.serverUrl);
  const agent: Agent = {
    history: [],
    mcp,
    tools: [],
    settings,
    refreshTools,
    say,
    setServer,
    logout,
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
  }

  function logout(): void {
    mcp.token = undefined;
    clearAccount(settings.serverUrl);
  }

  function system(): string {
    const acct = getAccount(settings.serverUrl);
    const tools = [...agent.tools.map(toolLine), ...LOCAL_TOOLS.map(toolLine)].join("\n");
    const think =
      settings.thinking === "off" || activeProfile(settings).nativeThinking || activeProfile(settings).type === "anthropic"
        ? ""
        : `\nBefore each action, think it through briefly inside <think></think>${settings.thinking === "high" ? ", carefully and in detail" : ""}.`;
    return [
      readFileSync(PERSONALITY_FILE, "utf8").trim(),
      `## Tools\n${PROTOCOL}${think}\n\n${tools}\n(* = required)`,
      `## You\n${acct?.handle ? `You are logged in as @${acct.handle}. Your login is saved automatically: never ask for it or type it.` : "You have no account yet. Use register (invent your own handle, display_name and bio) before anything else."}`,
      `## Memory\nThings you saved earlier (use read_memory name=... for details):\n${indexForPrompt()}`,
    ].join("\n\n");
  }

  /** Keep the conversation inside the context window: shrink old results first, then drop old turns. */
  function fit(): void {
    const budget = settings.contextTokens - approxTokens(system()) - 1500;
    const size = (): number => agent.history.reduce((n, m) => n + approxTokens(m.content), 0);
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
      return call.name === "remember" ? remember(s("name"), s("text")) : call.name === "read_memory" ? readMemory(s("name")) : forget(s("name"));
    }
    // The harness knows which model is really running; small models invent or forget this, so always set it.
    if (call.name === "register") {
      const p = activeProfile(settings);
      args.model = p.label ?? p.model;
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

  async function say(text: string, out: (s: string) => void): Promise<void> {
    if (!agent.tools.length) await refreshTools();
    agent.history.push({ role: "user", content: text });
    for (let step = 0; step < settings.maxSteps; step++) {
      fit();
      let reply = await chat(activeProfile(settings), system(), agent.history, settings.thinking);
      // The model may invent the RESULT itself; cut it off there.
      reply = reply.replace(/\n\s*RESULT\b[\s\S]*$/, "").trim();
      if (process.env.HARNESS_DEBUG) console.error(`--- model said:\n${reply}\n---`);
      const visible = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      const names = [...agent.tools, ...LOCAL_TOOLS].map((t) => t.name);
      // Small models sometimes write the call inside <think>; if the visible text has none, look there too.
      const call = parseCall(visible, names) ?? parseCall(reply.replace(/<\/?think>/g, ""), names);
      // Keep only up to the first call in history: models imitate what they said before, and a reply that
      // planned five calls and invented their results teaches them to do it again.
      const found = call && call !== "malformed" ? call : undefined;
      const at = found ? reply.indexOf(found.line) : -1;
      const kept = found && at >= 0 ? reply.slice(0, at + found.line.length) : reply;
      agent.history.push({ role: "assistant", content: kept || "(no reply)" });
      if (!call) {
        out(visible || "(no reply)");
        return;
      }
      let result: string;
      if (call === "malformed") {
        result = 'ERROR: I could not read that. Write exactly: CALL tool_name key=value key=value  (example: CALL swipe handle=bob direction=like)';
        out("! malformed CALL");
      } else {
        out(`> ${call.name} ${call.positional.join(" ")} ${Object.entries(call.args).map(([k, v]) => `${k}=${v.length > 40 ? v.slice(0, 40) + "…" : v}`).join(" ")}`);
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
    }
    out(`(stopped after ${settings.maxSteps} steps; say "continue" to go on)`);
  }

  return agent;
}

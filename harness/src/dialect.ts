import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chat, NATIVE_MARK, type NativeTool } from "./llm.ts";
import type { ToolInfo } from "./mcp.ts";
import { DATA_DIR, type ModelProfile } from "./settings.ts";

// ---- tool-call dialects (the "dynamic" tool-calling setting, EXPERIMENTAL, ADR-0047) ----------------
// The default, "strict", makes every model write `CALL name key=value` (ADR-0042). Some models keep drifting back to the
// format they were trained on (Gemma 4: `<|tool_call>call:swipe(...)<tool_call|>`). With toolCalling "dynamic" the harness asks the model ONCE how
// it writes a tool call, picks the dialect that matches, saves it per model, and from then on prompts, parses and
// shows examples in that dialect. Each dialect is still one strict grammar: no repair, no guessing between forms.
export type DialectName = "call" | "gemma" | "json" | "xml" | "native";
export const DIALECTS: DialectName[] = ["call", "gemma", "json", "xml", "native"];

/** What a parser returns: arguments as the model wrote them (strings, numbers, booleans), or why it is not a call. */
export type Parsed = { name: string; args: Record<string, unknown>; line: string } | { error: string; name?: string } | null;

export interface Dialect {
  name: DialectName;
  /** The protocol paragraph of the system prompt. */
  protocol: string;
  /** A correct call in this dialect. */
  format(name: string, args: Record<string, string | number>): string;
  /** Find the first call in a reply. Null when the reply has none (it is the model's answer). */
  parse(reply: string): Parsed;
  /** Where the first call ends in streamed text, or -1 while it is still being written (to stop generation there). */
  end(text: string): number;
}

const AFTER = `The brackets in the tool list give limits: (max 300) is the longest text, (1-10) the allowed numbers, (like|pass) the only choices. Going over is refused.
Then wait: I will answer with RESULT. If there is nothing to do for now, call wait instead of repeating calls.
As soon as the task is done, stop calling tools and reply with a short summary (no tool call).`;

// -- gemma: <|tool_call>call:swipe(handle='bob', direction='like')<tool_call|> --------------------
// Values are 'single' or "double" quoted strings (backslash escapes the quote), or bare numbers / true / false.
const GEMMA_OPEN = "<|tool_call>";
const GEMMA_CLOSE = "<tool_call|>";

function parseKwargs(src: string): Record<string, unknown> | string {
  const args: Record<string, unknown> = {};
  let i = 0;
  const n = src.length;
  const ws = (): void => {
    while (i < n && /\s/.test(src[i])) i++;
  };
  ws();
  if (i === n) return args;
  for (;;) {
    const m = /^([a-z_][a-z0-9_]*)\s*=\s*/.exec(src.slice(i));
    if (!m) return `expected key=value at "${src.slice(i, i + 30)}"`;
    const key = m[1];
    if (key in args) return `${key} is given twice`;
    i += m[0].length;
    const q = src[i];
    if (q === "'" || q === '"') {
      i++;
      let v = "";
      let closed = false;
      while (i < n) {
        const ch = src[i++];
        if (ch === "\\" && (src[i] === q || src[i] === "\\")) v += src[i++];
        else if (ch === q) {
          closed = true;
          break;
        } else v += ch;
      }
      if (!closed) return `the quote opened for ${key} is never closed`;
      args[key] = v;
    } else {
      const lit = /^(-?\d+(?:\.\d+)?|true|false)(?=\s*(,|$))/.exec(src.slice(i));
      if (!lit) return `${key}: put text values in quotes, e.g. ${key}='two words'`;
      args[key] = lit[1] === "true" ? true : lit[1] === "false" ? false : Number(lit[1]);
      i += lit[1].length;
    }
    ws();
    if (i === n) return args;
    if (src[i] !== ",") return `after ${key} comes "${src.slice(i, i + 20)}": separate arguments with a comma`;
    i++;
    ws();
  }
}

const gemma: Dialect = {
  name: "gemma",
  protocol: `To do something, write one tool call and nothing else, in your usual format, with the real tool name and arguments (as in the examples). Text values go in quotes; numbers have no quotes. One call per reply.
Example: ${GEMMA_OPEN}call:swipe(handle='bob', direction='like')${GEMMA_CLOSE}
Example: ${GEMMA_OPEN}call:send_message(match_id=3, body='Hi Bob, how is your day?')${GEMMA_CLOSE}
${AFTER}`,
  format: (name, args) =>
    `${GEMMA_OPEN}call:${name}(${Object.entries(args)
      .map(([k, v]) => `${k}=${typeof v === "number" ? v : `'${String(v).replace(/[\\']/g, (c) => "\\" + c)}'`}`)
      .join(", ")})${GEMMA_CLOSE}`,
  parse(reply) {
    const at = reply.indexOf(GEMMA_OPEN);
    if (at < 0) return null;
    const close = reply.indexOf(GEMMA_CLOSE, at);
    const line = close < 0 ? reply.slice(at) : reply.slice(at, close + GEMMA_CLOSE.length);
    const m = /^<\|tool_call>call:([a-z_][a-z0-9_]*)\(([\s\S]*)\)$/.exec(close < 0 ? line.trimEnd() : line.slice(0, -GEMMA_CLOSE.length));
    if (!m) {
      const name = /call:([a-z_][a-z0-9_]*)/.exec(line)?.[1];
      return { error: `write the call as ${GEMMA_OPEN}call:tool_name(key='value')${GEMMA_CLOSE}`, name };
    }
    const args = parseKwargs(m[2]);
    return typeof args === "string" ? { error: args, name: m[1] } : { name: m[1], args, line };
  },
  end(text) {
    const at = text.indexOf(GEMMA_OPEN);
    if (at < 0) return -1;
    const close = text.indexOf(GEMMA_CLOSE, at);
    return close < 0 ? (text.length - at > 3000 ? text.length : -1) : close + GEMMA_CLOSE.length;
  },
};

// -- json: {"name": "swipe", "arguments": {"handle": "bob"}}, bare or in a ```json fence -----------
/** The first balanced {...} starting at `from`, string-aware. */
function balanced(text: string, from: number): string | undefined {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  return undefined;
}
const jsonStart = (text: string): number => {
  const m = /\{\s*"name"\s*:/.exec(text);
  return m ? m.index : -1;
};

const json: Dialect = {
  name: "json",
  protocol: `To do something, write one tool call and nothing else, as JSON, with the real tool name and arguments (as in the examples). Text values go in double quotes; numbers have no quotes. One call per reply.
Example: {"name": "swipe", "arguments": {"handle": "bob", "direction": "like"}}
Example: {"name": "send_message", "arguments": {"match_id": 3, "body": "Hi Bob, how is your day?"}}
${AFTER}`,
  format: (name, args) => JSON.stringify({ name, arguments: args }),
  parse(reply) {
    const at = jsonStart(reply);
    if (at < 0) return null;
    const src = balanced(reply, at);
    if (!src) return { error: "the JSON call is not closed: write the whole object" };
    let obj: any;
    try {
      obj = JSON.parse(src);
    } catch (err) {
      return { error: `the call is not valid JSON (${(err as Error).message})` };
    }
    const name = typeof obj?.name === "string" ? obj.name : undefined;
    if (!name || !/^[a-z_][a-z0-9_]*$/.test(name)) return { error: `"name" must be the tool's name` };
    const extra = Object.keys(obj).filter((k) => k !== "name" && k !== "arguments");
    if (extra.length) return { error: `only "name" and "arguments" belong in the call, not ${extra.join(", ")}`, name };
    const args = obj.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) return { error: `"arguments" must be an object`, name };
    return { name, args, line: src };
  },
  end(text) {
    const at = jsonStart(text);
    if (at < 0) return -1;
    const src = balanced(text, at);
    return src ? at + src.length : text.length - at > 3000 ? text.length : -1;
  },
};

// -- xml (Qwen 3.5 style): <tool_call><function=swipe><parameter=handle>bob</parameter></function></tool_call> --
const xml: Dialect = {
  name: "xml",
  protocol: `To do something, write one tool call and nothing else, in your usual format, with the real tool name and arguments (as in the examples). One call per reply.
Example: <tool_call><function=swipe><parameter=handle>bob</parameter><parameter=direction>like</parameter></function></tool_call>
Example: <tool_call><function=send_message><parameter=match_id>3</parameter><parameter=body>Hi Bob, how is your day?</parameter></function></tool_call>
${AFTER}`,
  format: (name, args) => `<tool_call><function=${name}>${Object.entries(args).map(([k, v]) => `<parameter=${k}>${v}</parameter>`).join("")}</function></tool_call>`,
  parse(reply) {
    const at = reply.indexOf("<tool_call>");
    if (at < 0) return null;
    const close = reply.indexOf("</tool_call>", at);
    if (close < 0) return { error: "the call is not closed: end it with </tool_call>" };
    const line = reply.slice(at, close + "</tool_call>".length);
    const m = /^<tool_call>\s*<function=([a-z_][a-z0-9_]*)>([\s\S]*?)<\/function>\s*<\/tool_call>$/.exec(line);
    if (!m) return { error: "write the call as <tool_call><function=name><parameter=key>value</parameter></function></tool_call>", name: /<function=([a-z_][a-z0-9_]*)/.exec(line)?.[1] };
    const args: Record<string, unknown> = {};
    const body = m[2];
    const re = /\s*<parameter=([a-z_][a-z0-9_]*)>([\s\S]*?)<\/parameter>\s*/y;
    let p: RegExpExecArray | null;
    let last = 0;
    while ((p = re.exec(body))) {
      if (p[1] in args) return { error: `${p[1]} is given twice`, name: m[1] };
      // Qwen's template puts the value on its own lines: the newlines around it are layout, not content
      args[p[1]] = p[2].replace(/^\n/, "").replace(/\n$/, "");
      last = re.lastIndex;
    }
    if (body.slice(last).trim()) return { error: `unexpected "${body.slice(last).trim().slice(0, 30)}" inside the call`, name: m[1] };
    return { name: m[1], args, line };
  },
  end(text) {
    const at = text.indexOf("<tool_call>");
    if (at < 0) return -1;
    const close = text.indexOf("</tool_call>", at);
    return close < 0 ? (text.length - at > 3000 ? text.length : -1) : close + "</tool_call>".length;
  },
};

// -- native: the server's own tool-calling API (OpenAI `tools` / `tool_calls`) ---------------------
// The model's call arrives as structured data; llm.ts renders it into the reply as one JSON line so the rest of the
// harness (history, early stop, parsing) is the same. The model never sees this rendering as its format: on the wire
// the history goes back as real tool_calls/tool messages.
export { NATIVE_MARK };
const native: Dialect = {
  name: "native",
  protocol: `To do something, call one of your tools (use your tool-calling ability; the tools are listed below as well). One call per reply.
${AFTER}`,
  format: (name, args) => `${name}(${JSON.stringify(args)})`,
  parse(reply) {
    const at = reply.indexOf(NATIVE_MARK);
    if (at < 0) return null;
    const src = reply.slice(at + NATIVE_MARK.length).split("\n")[0];
    let obj: any;
    try {
      obj = JSON.parse(src);
    } catch {
      return { error: "the tool call's arguments were not valid JSON" };
    }
    let args: unknown;
    try {
      args = typeof obj.arguments === "string" ? JSON.parse(obj.arguments || "{}") : (obj.arguments ?? {});
    } catch {
      return { error: "the tool call's arguments were not valid JSON", name: obj.name };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { error: "arguments must be an object", name: obj.name };
    return { name: String(obj.name), args: args as Record<string, unknown>, line: reply.slice(at).split("\n")[0] };
  },
  end: () => -1,
};

// -- call: the stable harness's own grammar (ADR-0042), parsed by agent.ts ------------------------
// Kept here only as the fallback dialect's prompt; agent.ts owns its parser.
export const CALL_PROTOCOL = `To do something, write one line and nothing else:
CALL tool_name key=value key=value
Every argument is key=value. Put double quotes around a value with spaces (write \\" for a quote inside it). Numbers have no quotes. Write nothing after the last argument. One call per reply.
Example: CALL swipe handle=bob direction=like
Example: CALL send_message match_id=3 body="Hi Bob, how is your day?"
${AFTER}`;

export const TEXT_DIALECTS: Record<Exclude<DialectName, "call">, Dialect> = { gemma, json, xml, native };

/** Which text dialect a reply is written in, judged by its opening marker only (for calibration). */
export function sniff(reply: string): DialectName | undefined {
  if (reply.includes(GEMMA_OPEN)) return "gemma";
  if (reply.includes("<tool_call>") && /<function=/.test(reply)) return "xml";
  if (jsonStart(reply) >= 0) return "json";
  if (/^\s*CALL\s+[a-z_]/m.test(reply)) return "call";
  return undefined;
}

// ---- calibration: ask once, remember per model ---------------------------------------------------
// HARNESS_DIALECT_FILE lets scripts/load.ts share one calibration between all the agents of a session.
const FILE = (): string => process.env.HARNESS_DIALECT_FILE ?? join(DATA_DIR, "dialect.json");
interface Store { [model: string]: { dialect: DialectName; decided: string; how: string } }
const read = (): Store => {
  try {
    return existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : {};
  } catch {
    return {};
  }
};
export const savedDialect = (model: string): DialectName | undefined => read()[model]?.dialect;
export function saveDialect(model: string, dialect: DialectName, how: string): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE(), JSON.stringify({ ...read(), [model]: { dialect, decided: new Date().toISOString(), how } }, null, 2) + "\n");
}

const PROBE_TOOLS: NativeTool[] = [
  { name: "whoami", description: "Check whether you are logged in.", parameters: { type: "object", properties: {} } },
  { name: "swipe", description: "Swipe like or pass on an agent.", parameters: { type: "object", properties: { handle: { type: "string" }, direction: { type: "string", enum: ["like", "pass"] } }, required: ["handle", "direction"] } },
];
const PROBE_USER = 'Like the agent with handle "probe_bot" using the swipe tool. Reply with only the tool call.';

/**
 * The first time a model is used: (1) give it the tools with NO format and see what it writes; a known dialect wins.
 * (2) Otherwise, if the server supports native tool calls and the model makes a correct one, use native.
 * (3) Otherwise fall back to the stable CALL grammar. Every step is logged through `out`.
 */
export async function calibrate(p: ModelProfile, out: (s: string) => void): Promise<{ dialect: DialectName; how: string }> {
  const list = PROBE_TOOLS.map((t) => `- ${t.name}(${Object.keys(t.parameters.properties).join(", ")}): ${t.description}`).join("\n");
  const sys = `You are an agent on a dating site. You can use these tools:\n${list}\nTo use a tool, write the tool call in whatever format you normally use for tool calls.`;
  // One sample is not enough (MiMo once asked a question back instead of calling, and got CALL): take up to three
  // and go with a format two of them agree on.
  const votes = new Map<DialectName, string>();
  const tally: DialectName[] = [];
  for (let i = 0; i < FREE_PROBES; i++) {
    try {
      const free = await chat(p, sys, [{ role: "user", content: PROBE_USER }], "off");
      const text = free.text.replace(/<think>[\s\S]*?<\/think>/g, "");
      const d = sniff(text);
      const parsed = d === "gemma" || d === "json" || d === "xml" ? TEXT_DIALECTS[d].parse(text) : null;
      if (d && parsed && !("error" in parsed) && parsed.name === "swipe") {
        tally.push(d);
        votes.set(d, parsed.line.slice(0, 120));
        out(`(dialect probe ${i + 1}: ${d})`);
        if (tally.filter((x) => x === d).length >= 2) return { dialect: d, how: `${tally.length} free-text probes, ${d} twice: ${votes.get(d)}` };
      } else out(`(dialect probe ${i + 1}: no usable call in free text: ${JSON.stringify(text.slice(0, 100))})`);
    } catch (err) {
      out(`(dialect probe ${i + 1} failed: ${(err as Error).message})`);
    }
  }
  if (p.type === "openai") {
    for (let i = 0; i < NATIVE_PROBES; i++) {
      try {
        const nat = await chat(p, "You are an agent on a dating site.", [{ role: "user", content: PROBE_USER }], "off", undefined, { tools: PROBE_TOOLS });
        const parsed = native.parse(nat.text);
        if (parsed && !("error" in parsed) && parsed.name === "swipe") return { dialect: "native", how: `native tool_calls probe ${i + 1}: ${parsed.line.replace(NATIVE_MARK, "").slice(0, 120)}` };
        out(`(native probe ${i + 1} gave no usable tool call: ${JSON.stringify(nat.text.slice(0, 100))})`);
      } catch (err) {
        out(`(native probe ${i + 1} failed: ${(err as Error).message})`);
      }
    }
  }
  // a single free-text vote beats the fallback: it is at least a format the model has used
  if (tally.length) return { dialect: tally[0], how: `one free-text probe wrote ${tally[0]}: ${votes.get(tally[0])}` };
  return { dialect: "call", how: "no own format found; using the CALL grammar" };
}
const FREE_PROBES = 3;
const NATIVE_PROBES = 2;

/**
 * Learning from use: a reply that is not a call in the current dialect but IS a valid call in another known text
 * dialect. After SWITCH_AFTER of these in a row, the agent switches (decided in agent.ts).
 */
export function otherDialect(current: DialectName, reply: string, toolNames: string[]): DialectName | undefined {
  const d = sniff(reply);
  if (!d || d === current || d === "call") return undefined;
  const got = TEXT_DIALECTS[d].parse(reply);
  return got && !("error" in got) && toolNames.includes(got.name) ? d : undefined;
}
export const SWITCH_AFTER = 3;

/** Tools in the OpenAI function shape, for the native dialect. */
export const nativeTools = (tools: ToolInfo[]): NativeTool[] =>
  tools.map((t) => ({ name: t.name, description: t.description.slice(0, 300), parameters: { type: "object", properties: t.inputSchema.properties ?? {}, required: t.inputSchema.required ?? [] } }));

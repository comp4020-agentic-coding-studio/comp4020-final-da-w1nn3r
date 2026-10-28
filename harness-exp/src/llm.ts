import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelProfile, Thinking } from "./settings.ts";

export interface Msg { role: "user" | "assistant"; content: string }
/** A tool in the OpenAI function shape, for native tool calling (the experimental `native` dialect, ADR-0047). */
export interface NativeTool { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } }
/** Marks a native tool call rendered into reply text as `MARK{"name":...,"arguments":"..."}`, one per reply. */
export const NATIVE_MARK = "[[tool_call]] ";
const MAX_NATIVE_ARGS = 3000;
export type Kind = "think" | "text";
/** Gets every piece of the reply as it arrives. Return true to stop generating (the reply so far is kept). */
export type Sink = (kind: Kind, s: string) => boolean | void;
/** `text` is the model's answer (may contain inline <think> blocks); `reasoning` is what the server sent as separate reasoning. */
export interface Reply { text: string; reasoning: string; usage?: { input: number; output: number } }

const BUDGET: Record<Thinking, number> = { off: 0, low: 1024, medium: 4096, high: 12000 };

/** Splits a stream of text into thinking and answer on inline <think> tags, even when a tag is cut between chunks. */
export class ThinkSplitter {
  private buf = "";
  private inThink = false;
  push(chunk: string): [Kind, string][] {
    this.buf += chunk;
    const out: [Kind, string][] = [];
    for (;;) {
      // A closing tag with no opening one (small models do this) is just dropped.
      if (!this.inThink && this.buf.includes("</think>") && !(this.buf.indexOf("<think>") >= 0 && this.buf.indexOf("<think>") < this.buf.indexOf("</think>"))) {
        const i = this.buf.indexOf("</think>");
        if (i) out.push(["text", this.buf.slice(0, i)]);
        this.buf = this.buf.slice(i + "</think>".length);
        continue;
      }
      const tag = this.inThink ? "</think>" : "<think>";
      const at = this.buf.indexOf(tag);
      if (at >= 0) {
        if (at) out.push([this.inThink ? "think" : "text", this.buf.slice(0, at)]);
        this.buf = this.buf.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // hold back a possible start of the tag at the end of the buffer
      let keep = 0;
      const tags = this.inThink ? ["</think>"] : ["<think>", "</think>"];
      for (let n = Math.min(7, this.buf.length); n > 0 && !keep; n--) if (tags.some((t) => t.startsWith(this.buf.slice(-n)))) keep = n;
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) out.push([this.inThink ? "think" : "text", emit]);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }
  flush(): [Kind, string][] {
    const rest = this.buf;
    this.buf = "";
    return rest ? [[this.inThink ? "think" : "text", rest]] : [];
  }
}

// Everything the harness sends is plain text (see agent.ts), so one function covers every provider.
export async function chat(p: ModelProfile, system: string, messages: Msg[], thinking: Thinking, sink: Sink = () => {}, tools?: NativeTool[]): Promise<Reply> {
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.apiKeyEnv && !key) throw new Error(`Set the ${p.apiKeyEnv} environment variable to use this model.`);
  const budgeted = p.budgetUsd !== undefined && p.inputPerMTok !== undefined && p.outputPerMTok !== undefined && !!process.env.HARNESS_HOME;
  if (budgeted) {
    const spent = readSpend();
    if (spent.usd >= p.budgetUsd!) throw new Error(`Budget used up: $${spent.usd.toFixed(4)} spent of $${p.budgetUsd!.toFixed(2)} for this agent (ADR-0041). Raise budgetUsd in its settings to go on.`);
  }
  const reply = await (p.type === "anthropic" ? anthropic(p, key!, system, messages, thinking, sink) : openai(p, key, system, messages, thinking, sink, tools));
  if (budgeted && reply.usage) addSpend(reply.usage, p.inputPerMTok!, p.outputPerMTok!);
  return reply;
}

// Per-agent spend (ADR-0041): one file in the agent's HARNESS_HOME, so each load-test agent has its own budget.
// Only tracked when HARNESS_HOME is set; the interactive harness and the launcher's own calls are not capped.
interface Spend { usd: number; inputTokens: number; outputTokens: number }
const spendFile = (): string => join(process.env.HARNESS_HOME ?? ".", "spend.json");
function readSpend(): Spend {
  try {
    return JSON.parse(readFileSync(spendFile(), "utf8"));
  } catch {
    return { usd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
function addSpend(u: { input: number; output: number }, inPerM: number, outPerM: number): void {
  const s = readSpend();
  s.inputTokens += u.input;
  s.outputTokens += u.output;
  s.usd += (u.input * inPerM + u.output * outPerM) / 1_000_000;
  mkdirSync(process.env.HARNESS_HOME!, { recursive: true });
  writeFileSync(spendFile(), JSON.stringify(s, null, 2) + "\n");
}

/** POST and read the server-sent events; `onEvent` gets each JSON payload and may return true to stop early. */
async function stream(url: string, headers: Record<string, string>, body: unknown, onEvent: (e: any) => boolean | void, hint = ""): Promise<void> {
  const stop = new AbortController();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15 * 60_000)]), // CPU inference is slow
    });
  } catch (err) {
    throw new Error(`Cannot reach the model at ${url} (${(err as Error).message}). Is the model server running? Check "baseUrl" in settings.json.`);
  }
  if (!res.ok) throw new Error(`Model error ${res.status}: ${(await res.text()).slice(0, 300)}${hint}`);
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error) throw new Error(`Model error: ${event.error.message ?? JSON.stringify(event.error)}`);
        if (onEvent(event)) {
          stop.abort();
          return;
        }
      }
    }
  } catch (err) {
    if (stop.signal.aborted) return; // we asked for this
    throw new Error(`Lost the connection to the model: ${(err as Error).message}`);
  }
}

/**
 * With native tools, the history goes back on the wire as real tool calls: an assistant message holding a rendered
 * call becomes `tool_calls`, and the RESULT that follows it becomes a `tool` message answering it.
 */
function wireMessages(messages: Msg[], tools: boolean): unknown[] {
  if (!tools) return messages;
  const wire: unknown[] = [];
  let pending: string | undefined;
  messages.forEach((m, i) => {
    const at = m.role === "assistant" ? m.content.indexOf(NATIVE_MARK) : -1;
    if (at >= 0) {
      let call: { name?: string; arguments?: string } = {};
      try {
        call = JSON.parse(m.content.slice(at + NATIVE_MARK.length).split("\n")[0]);
        JSON.parse(call.arguments || "{}");
      } catch {
        // A broken call (gpt-oss once wrote 3000 characters of "…??" into a handle) must not go back as tool_calls:
        // llama.cpp re-parses them and answers 500 on every later request. It goes back as text instead.
        pending = undefined;
        wire.push({ role: "assistant", content: "(a tool call whose arguments were not valid JSON)" });
        return;
      }
      pending = `call_${i}`;
      wire.push({ role: "assistant", content: m.content.slice(0, at).trim() || null, tool_calls: [{ id: pending, type: "function", function: { name: call.name ?? "", arguments: call.arguments ?? "{}" } }] });
    } else if (pending && m.role === "user" && m.content.startsWith("RESULT ")) {
      wire.push({ role: "tool", tool_call_id: pending, content: m.content.slice("RESULT ".length) });
      pending = undefined;
    } else {
      pending = undefined;
      wire.push(m);
    }
  });
  return wire;
}

async function openai(p: ModelProfile, key: string | undefined, system: string, messages: Msg[], thinking: Thinking, sink: Sink, tools?: NativeTool[]): Promise<Reply> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages: [{ role: "system", content: system }, ...wireMessages(messages, !!tools)],
    // thinking tokens come out of the same budget, so make room for them
    max_tokens: (p.maxTokens ?? 1024) + (thinking === "off" ? 0 : BUDGET[thinking]),
    temperature: 0.7,
    stream: true,
  };
  if (p.nativeThinking && thinking !== "off") body.reasoning_effort = thinking;
  if (p.templateThinking) body.chat_template_kwargs = { enable_thinking: thinking !== "off" };
  if (tools?.length) {
    body.tools = tools.map((f) => ({ type: "function", function: f }));
    body.parallel_tool_calls = false;
  }
  const split = new ThinkSplitter();
  const r: Reply = { text: "", reasoning: "" };
  let stopped = false;
  // Native tool calls stream in pieces (name first, arguments in chunks); only the first call is kept.
  const call = { name: "", arguments: "", seen: false };
  await stream(
    `${p.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`,
    key ? { authorization: `Bearer ${key}` } : {},
    body,
    (e) => {
      const d = e.choices?.[0]?.delta ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (reasoning) {
        r.reasoning += reasoning;
        stopped = sink("think", reasoning) === true || stopped;
      }
      if (d.content) {
        // keep the raw text (tags included) in r.text, but show it split
        r.text += d.content;
        for (const [kind, s] of split.push(d.content)) stopped = sink(kind, s) === true || stopped;
      }
      for (const tc of d.tool_calls ?? []) {
        if ((tc.index ?? 0) !== 0) continue;
        call.seen = true;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
        // a looping model can fill one argument for minutes: stop it, the call will be refused as broken
        if (call.arguments.length > MAX_NATIVE_ARGS) stopped = true;
      }
      return stopped;
    },
    p.baseUrl ? ` (check that "model" in settings.json is a name the server has: GET ${p.baseUrl}/models)` : "",
  );
  if (!stopped) for (const [kind, s] of split.flush()) sink(kind, s);
  if (call.seen) {
    const rendered = NATIVE_MARK + JSON.stringify({ name: call.name, arguments: call.arguments });
    r.text += (r.text && !r.text.endsWith("\n") ? "\n" : "") + rendered;
    sink("text", `[tool call] ${call.name} ${call.arguments}`);
  }
  return r;
}

async function anthropic(p: ModelProfile, key: string, system: string, messages: Msg[], thinking: Thinking, sink: Sink): Promise<Reply> {
  const budget = BUDGET[thinking];
  const body: Record<string, unknown> = {
    model: p.model,
    system,
    messages,
    max_tokens: (p.maxTokens ?? 1024) + budget,
    stream: true,
  };
  if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
  const r: Reply = { text: "", reasoning: "" };
  await stream(`${p.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, body, (e) => {
    // usage: input tokens arrive in message_start, the running output total in message_delta
    if (e.type === "message_start" && e.message?.usage) {
      const u = e.message.usage;
      r.usage = { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 };
    }
    if (e.type === "message_delta" && e.usage) r.usage = { input: r.usage?.input ?? 0, output: e.usage.output_tokens ?? r.usage?.output ?? 0 };
    if (e.type !== "content_block_delta") return;
    if (e.delta?.type === "thinking_delta") {
      r.reasoning += e.delta.thinking;
      return sink("think", e.delta.thinking) === true;
    }
    if (e.delta?.type === "text_delta") {
      r.text += e.delta.text;
      return sink("text", e.delta.text) === true;
    }
  });
  return r;
}

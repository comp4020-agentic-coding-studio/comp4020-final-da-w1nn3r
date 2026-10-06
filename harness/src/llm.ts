import type { ModelProfile, Thinking } from "./settings.ts";

export interface Msg { role: "user" | "assistant"; content: string }
export type Kind = "think" | "text";
/** Gets every piece of the reply as it arrives. Return true to stop generating (the reply so far is kept). */
export type Sink = (kind: Kind, s: string) => boolean | void;
/** `text` is the model's answer (may contain inline <think> blocks); `reasoning` is what the server sent as separate reasoning. */
export interface Reply { text: string; reasoning: string }

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
export async function chat(p: ModelProfile, system: string, messages: Msg[], thinking: Thinking, sink: Sink = () => {}): Promise<Reply> {
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.apiKeyEnv && !key) throw new Error(`Set the ${p.apiKeyEnv} environment variable to use this model.`);
  return p.type === "anthropic" ? anthropic(p, key!, system, messages, thinking, sink) : openai(p, key, system, messages, thinking, sink);
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

async function openai(p: ModelProfile, key: string | undefined, system: string, messages: Msg[], thinking: Thinking, sink: Sink): Promise<Reply> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages: [{ role: "system", content: system }, ...messages],
    // thinking tokens come out of the same budget, so make room for them
    max_tokens: (p.maxTokens ?? 1024) + (thinking === "off" ? 0 : BUDGET[thinking]),
    temperature: 0.7,
    stream: true,
  };
  if (p.nativeThinking && thinking !== "off") body.reasoning_effort = thinking;
  if (p.templateThinking) body.chat_template_kwargs = { enable_thinking: thinking !== "off" };
  const split = new ThinkSplitter();
  const r: Reply = { text: "", reasoning: "" };
  let stopped = false;
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
      return stopped;
    },
    p.baseUrl ? ` (check that "model" in settings.json is a name the server has: GET ${p.baseUrl}/models)` : "",
  );
  if (!stopped) for (const [kind, s] of split.flush()) sink(kind, s);
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

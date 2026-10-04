import type { ModelProfile, Thinking } from "./settings.ts";

export interface Msg { role: "user" | "assistant"; content: string }

const BUDGET: Record<Thinking, number> = { off: 0, low: 1024, medium: 4096, high: 12000 };

// Everything the harness sends is plain text (see agent.ts), so one function covers every provider.
export async function chat(p: ModelProfile, system: string, messages: Msg[], thinking: Thinking): Promise<string> {
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.apiKeyEnv && !key) throw new Error(`Set the ${p.apiKeyEnv} environment variable to use this model.`);
  return p.type === "anthropic" ? anthropic(p, key!, system, messages, thinking) : openai(p, key, system, messages, thinking);
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15 * 60_000), // CPU inference is slow
    });
  } catch (err) {
    throw new Error(`Cannot reach the model at ${url} (${(err as Error).message}). Is the model server running? Check "baseUrl" in harness/settings.json.`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Model error ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function openai(p: ModelProfile, key: string | undefined, system: string, messages: Msg[], thinking: Thinking): Promise<string> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: p.maxTokens ?? 1024,
    temperature: 0.7,
  };
  if (p.nativeThinking && thinking !== "off") body.reasoning_effort = thinking;
  const r = await post(`${p.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, body);
  return r.choices?.[0]?.message?.content ?? "";
}

async function anthropic(p: ModelProfile, key: string, system: string, messages: Msg[], thinking: Thinking): Promise<string> {
  const budget = BUDGET[thinking];
  const body: Record<string, unknown> = {
    model: p.model,
    system,
    messages,
    max_tokens: (p.maxTokens ?? 1024) + budget,
  };
  if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
  const r = await post(`${p.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, body);
  return (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}

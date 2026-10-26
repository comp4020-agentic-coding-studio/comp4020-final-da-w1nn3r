import type { ModelProfile } from "./settings.ts";

// The model server's real context window (ADR-0055). A history sized to a number in settings.json that the server
// does not have is cut by the server, silently (Ollama) or with an error (llama.cpp), so the harness asks.

/** Used when nothing can be asked (a hosted API) and settings give no number. */
export const FALLBACK_CONTEXT = 40000;
/** Ollama's own default when neither the model nor the server sets num_ctx (it has been 2048, now 4096). */
export const OLLAMA_DEFAULT_CTX = 4096;

export interface ContextProbe {
  /** tokens the server will actually hold for one conversation */
  tokens: number;
  /** what answered: "llama.cpp", "Ollama", "LM Studio" */
  server: string;
  /** something the user should know (Ollama's small default, a model that could take more) */
  warning?: string;
  /** the server did not say; `tokens` is its usual default (Ollama), so a number in settings wins over it */
  guessed?: boolean;
}

const HOSTED = /(^|\.)(openai\.com|openrouter\.ai|anthropic\.com|googleapis\.com|groq\.com|together\.xyz|mistral\.ai|deepseek\.com|x\.ai)$/i;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

async function getJson(url: string, timeoutMs: number, init?: RequestInit): Promise<any | undefined> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** llama.cpp: GET /props gives the context of one slot (the window divides between slots, ADR-0005). */
async function llamacpp(root: string, model: string, t: number): Promise<ContextProbe | undefined> {
  // A router (several models behind one server) wants the model named.
  for (const url of [`${root}/props`, `${root}/props?model=${encodeURIComponent(model)}`]) {
    const p = await getJson(url, t);
    const n = num(p?.default_generation_settings?.n_ctx) ?? num(p?.n_ctx);
    if (n) return { tokens: n, server: "llama.cpp" };
  }
  const slots = await getJson(`${root}/slots`, t);
  const n = Array.isArray(slots) ? num(slots[0]?.n_ctx) : undefined;
  return n ? { tokens: n, server: "llama.cpp" } : undefined;
}

/**
 * Ollama: the model's own limit is in /api/show's model_info (`<arch>.context_length`), but what it runs with is
 * num_ctx: from the model's parameters, from a loaded model in /api/ps, or else Ollama's small default. Its
 * OpenAI-compatible endpoint takes no num_ctx, and a longer prompt is cut from the front without an error.
 */
async function ollama(root: string, model: string, t: number): Promise<ContextProbe | undefined> {
  const show = await getJson(`${root}/api/show`, t, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
  if (!show || typeof show !== "object" || !("model_info" in show || "parameters" in show || "modelfile" in show)) return undefined;
  const info: Record<string, unknown> = show.model_info ?? {};
  const max = num(Object.entries(info).find(([k]) => k.endsWith(".context_length"))?.[1]);
  const fromParams = num(Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(show.parameters ?? ""))?.[1]));
  const ps = await getJson(`${root}/api/ps`, t);
  const loaded = num((ps?.models ?? []).find((m: any) => m?.name === model || m?.model === model)?.context_length);
  const tokens = fromParams ?? loaded;
  if (tokens) return { tokens, server: "Ollama" };
  return {
    tokens: OLLAMA_DEFAULT_CTX,
    server: "Ollama",
    guessed: true,
    warning: `Ollama did not say what context ${model} runs with, so it is probably its default (about ${OLLAMA_DEFAULT_CTX} tokens${max ? `; the model can take ${max}` : ""}), and Ollama cuts longer prompts without saying so. Start Ollama with OLLAMA_CONTEXT_LENGTH=32768 (or more), or make a model with "PARAMETER num_ctx 32768". If you already did, set contextTokens in settings.json to that number.`,
  };
}

/** LM Studio: /api/v0/models lists each model with the context it was loaded with. */
async function lmstudio(root: string, model: string, t: number): Promise<ContextProbe | undefined> {
  const list = await getJson(`${root}/api/v0/models`, t);
  if (!Array.isArray(list?.data)) return undefined;
  const m = list.data.find((x: any) => x?.id === model) ?? list.data.find((x: any) => x?.state === "loaded");
  const n = num(m?.loaded_context_length) ?? num(m?.max_context_length);
  return n ? { tokens: n, server: "LM Studio", ...(num(m?.loaded_context_length) ? {} : { warning: `LM Studio did not say what context ${model} is loaded with; assuming its maximum (${n}).` }) } : undefined;
}

/**
 * Ask the model server how much context it really has: llama.cpp (`/props`), Ollama (`/api/show`, `/api/ps`) or
 * LM Studio (`/api/v0/models`). Undefined for a hosted API, a non-OpenAI profile, or a server that answers none.
 */
export async function probeContextTokens(profile: ModelProfile, timeoutMs = 2000): Promise<ContextProbe | undefined> {
  if (profile.type !== "openai" || !profile.baseUrl) return undefined;
  let root: string;
  try {
    const u = new URL(profile.baseUrl);
    if (HOSTED.test(u.hostname)) return undefined;
    root = `${u.origin}${u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
  } catch {
    return undefined;
  }
  const [a, b, c] = await Promise.all([llamacpp(root, profile.model, timeoutMs), ollama(root, profile.model, timeoutMs), lmstudio(root, profile.model, timeoutMs)]);
  return a ?? b ?? c;
}

/** What the harness will size its history to, and what to tell the user about it. */
export interface ContextChoice { tokens: number; source: string; warnings: string[] }

/**
 * The window to use: the smaller of what the server reports and a number in settings; "auto" (or no number) takes
 * the server's, and with no answer the setting or 40000. Settings claiming more than the server has get a warning.
 */
export function chooseContext(setting: number | "auto" | undefined, probe: ContextProbe | undefined): ContextChoice {
  const configured = typeof setting === "number" && setting > 0 ? Math.floor(setting) : undefined;
  const warnings: string[] = probe?.warning ? [probe.warning] : [];
  if (!probe || (probe.guessed && configured)) return { tokens: configured ?? FALLBACK_CONTEXT, source: configured ? "contextTokens in settings" : probe ? `${probe.server}'s default` : "default (the server did not say)", warnings: probe?.guessed && configured ? [] : warnings };
  if (configured && configured > probe.tokens) warnings.push(`contextTokens is ${configured} in your settings but ${probe.server} only has ${probe.tokens}: using ${probe.tokens}. Set contextTokens to "auto" (or raise the server's context).`);
  const tokens = configured ? Math.min(configured, probe.tokens) : probe.tokens;
  if (tokens < 16000) warnings.push(`A ${tokens}-token context is small for this harness: the instructions alone take a few thousand, so it will compact very often. 32K or more works well.`);
  return { tokens, source: configured && configured < probe.tokens ? "contextTokens in settings" : probe.server, warnings };
}

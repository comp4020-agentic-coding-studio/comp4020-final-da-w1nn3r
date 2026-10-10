import { execFileSync } from "node:child_process";
import type { ModelProfile, Settings } from "./settings.ts";

// Auto-detection: find something to run the agent on without editing settings.json (ADR-0023).
// Local servers first (free), then API keys already in the environment.

/** Where local OpenAI-compatible servers usually live. 8081 is the tester's llama.cpp (compose.yaml). */
export const LOCAL_PORTS: [port: number, name: string][] = [
  [8081, "llama.cpp"],
  [8080, "llama.cpp"],
  [11434, "Ollama"],
  [1234, "LM Studio"],
];

/** Hosts to probe: this machine, anything in HARNESS_LOCAL_HOST (comma separated), and under WSL the Windows host, where Ollama / LM Studio often run. */
export function localHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = ["localhost", ...(env.HARNESS_LOCAL_HOST ?? "").split(",").map((h) => h.trim()).filter(Boolean)];
  if (env.WSL_DISTRO_NAME) {
    try {
      const gw = /^default via (\S+)/m.exec(execFileSync("ip", ["route"], { encoding: "utf8", timeout: 1000 }))?.[1];
      if (gw) hosts.push(gw);
    } catch {}
  }
  return [...new Set(hosts)];
}

const CLAUDE_DEFAULT = "claude-haiku-4-5-20251001";
const OPENAI_DEFAULT = "gpt-4.1-mini";
const OPENROUTER_DEFAULT = "anthropic/claude-haiku-4.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export interface Found {
  /** one line for the user: what was picked and where from */
  summary: string;
  profile: ModelProfile;
}

function localProfile(host: string, port: number, name: string, item: any): Found {
  const baseUrl = `http://${host}:${port}/v1`;
  const id: string = item.id;
  const llamacpp = item.owned_by === "llamacpp";
  return {
    summary: `${id} on ${llamacpp ? "llama.cpp" : name} (${host}:${port})`,
    profile: {
      type: "openai",
      baseUrl,
      model: id,
      label: id.replace(/\.gguf$/i, ""),
      // llama.cpp needs this for /thinking to work; other servers reject or ignore it
      ...(llamacpp ? { templateThinking: true } : {}),
    },
  };
}

/** Every model a local server lists; empty if nothing (or something that is not a model server) answers. */
async function probeAll(host: string, port: number, name: string): Promise<Found[]> {
  try {
    const res = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return [];
    const body: any = await res.json();
    // anything else listening on the port (the web app, say) will not answer in this shape
    if (!Array.isArray(body?.data)) return [];
    return body.data.filter((m: any) => typeof m?.id === "string").map((m: any) => localProfile(host, port, name, m));
  } catch {
    return [];
  }
}

/** The first thing that works, or null. Probes the local ports in parallel but keeps their order. */
export async function detectModel(env: NodeJS.ProcessEnv = process.env, ports = LOCAL_PORTS, hosts = localHosts(env)): Promise<Found | null> {
  const local = (await Promise.all(hosts.flatMap((host) => ports.map(([port, name]) => probeAll(host, port, name))))).find((f) => f.length)?.[0];
  if (local) return local;
  if (env.ANTHROPIC_API_KEY)
    return { summary: `${CLAUDE_DEFAULT} (ANTHROPIC_API_KEY)`, profile: { type: "anthropic", model: CLAUDE_DEFAULT, apiKeyEnv: "ANTHROPIC_API_KEY" } };
  if (env.OPENAI_API_KEY)
    return {
      summary: `${OPENAI_DEFAULT} (OPENAI_API_KEY)`,
      profile: { type: "openai", baseUrl: "https://api.openai.com/v1", model: OPENAI_DEFAULT, apiKeyEnv: "OPENAI_API_KEY" },
    };
  if (env.OPENROUTER_API_KEY)
    return {
      summary: `${OPENROUTER_DEFAULT} (OPENROUTER_API_KEY)`,
      profile: { type: "openai", baseUrl: OPENROUTER_URL, model: OPENROUTER_DEFAULT, apiKeyEnv: "OPENROUTER_API_KEY" },
    };
  return null;
}

/** A model you can pick. `spec` is what `/model` and `--model` accept to choose it again later. */
export interface Choice extends Found {
  spec: string;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// hosted lists include embeddings, speech, image models and so on; the agent needs chat models
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe|search|davinci|babbage/i;

/** Every model the user could pick: local servers, plus each hosted provider whose key is set. Errors come back as notes, not throws. */
export async function listChoices(env: NodeJS.ProcessEnv = process.env, ports = LOCAL_PORTS, hosts = localHosts(env)): Promise<{ choices: Choice[]; notes: string[] }> {
  const notes: string[] = [];
  const hosted = async (spec: string, keyEnv: string, run: () => Promise<Choice[]>): Promise<Choice[]> => {
    if (!env[keyEnv]) return [];
    try {
      return await run();
    } catch (err) {
      notes.push(`${spec}: could not list models (${(err as Error).message})`);
      return [];
    }
  };
  const mk = (provider: string, profile: ModelProfile): Choice => ({
    spec: `${provider}:${profile.model}`,
    summary: `${provider}:${profile.model}`,
    profile,
  });
  const [local, anthropic, openai, openrouter] = await Promise.all([
    Promise.all(hosts.flatMap((host) => ports.map(([port, name]) => probeAll(host, port, name).then((found) => found.map((f) => ({ ...f, spec: `local@${host === "localhost" ? "" : host + ":"}${port}:${f.profile.model}` })))))),
    hosted("anthropic", "ANTHROPIC_API_KEY", async () => {
      const body = await getJson("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" });
      return (body.data ?? []).map((m: any) => mk("anthropic", { type: "anthropic", model: m.id, apiKeyEnv: "ANTHROPIC_API_KEY" }));
    }),
    hosted("openai", "OPENAI_API_KEY", async () => {
      const body = await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${env.OPENAI_API_KEY}` });
      return (body.data ?? [])
        .filter((m: any) => !NOT_CHAT.test(m.id))
        .map((m: any) => mk("openai", { type: "openai", baseUrl: "https://api.openai.com/v1", model: m.id, apiKeyEnv: "OPENAI_API_KEY" }));
    }),
    hosted("openrouter", "OPENROUTER_API_KEY", async () => {
      const body = await getJson(`${OPENROUTER_URL}/models`);
      return (body.data ?? []).map((m: any) => mk("openrouter", { type: "openai", baseUrl: OPENROUTER_URL, model: m.id, apiKeyEnv: "OPENROUTER_API_KEY" }));
    }),
  ]);
  const localChoices = local.flat();
  const byName = (a: Choice, b: Choice) => a.spec.localeCompare(b.spec);
  return { choices: [...localChoices, ...anthropic.sort(byName), ...openai.sort(byName), ...openrouter.sort(byName)], notes };
}

/** Turn "provider:model-id" or "local@port:model-id" into a profile, without listing anything. Null if it is not that shape. */
function fromSpec(s: Settings, spec: string): Choice | null {
  const local = /^local@(?:([^:@]+):)?(\d+):(.+)$/.exec(spec);
  if (local) {
    const port = Number(local[2]);
    return { spec, ...localProfile(local[1] ?? "localhost", port, LOCAL_PORTS.find(([p]) => p === port)?.[1] ?? "local server", { id: local[3], owned_by: port === 8081 ? "llamacpp" : "" }) };
  }
  const i = spec.indexOf(":");
  if (i < 1) return null;
  const base = s.models[spec.slice(0, i)] ?? BUILTIN[spec.slice(0, i)];
  if (!base) return null;
  const model = spec.slice(i + 1);
  return { spec, summary: spec, profile: { ...base, model, label: undefined } };
}

/** Hosted providers that work with no settings.json entry. */
const BUILTIN: Record<string, ModelProfile> = {
  anthropic: { type: "anthropic", model: CLAUDE_DEFAULT, apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { type: "openai", baseUrl: "https://api.openai.com/v1", model: OPENAI_DEFAULT, apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: { type: "openai", baseUrl: OPENROUTER_URL, model: OPENROUTER_DEFAULT, apiKeyEnv: "OPENROUTER_API_KEY" },
};

/** If settings.model is "auto" or a "provider:model" spec, resolve it and register the profile under that name. Returns the summary, or undefined when not auto. */
export async function resolveAuto(s: Settings): Promise<string | undefined> {
  if (s.model !== "auto") {
    // "provider:model-id" picks one specific model, e.g. openrouter:anthropic/claude-sonnet-4.5
    if (s.models[s.model]) return undefined;
    const chosen = fromSpec(s, s.model);
    if (!chosen) return undefined;
    s.models[s.model] = chosen.profile;
    return chosen.summary;
  }
  const found = await detectModel();
  if (!found)
    throw new Error(
      `No model found. Start a local server (docker compose up -d llama; Ollama; LM Studio; set HARNESS_LOCAL_HOST for one on another machine), or set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, or pick one with --model.`,
    );
  s.models.auto = found.profile;
  return found.summary;
}

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

/** A short, readable model name for `register` (max 60 characters): llama.cpp reports the .gguf file path as the id. */
export function modelLabel(id: string): string {
  const file = id.split(/[\\/]/).pop() ?? id; // a Windows or Unix path: keep the file name
  const name = file.replace(/\.gguf$/i, "").trim() || id;
  return name.length <= 60 ? name : `${name.slice(0, 59)}…`;
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
      label: modelLabel(id),
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

/** Embedding and reranker models answer /v1/models too, but cannot chat. Matched on the model id. */
const EMBEDDING = /embed|rerank|(^|[\/_-])bge[-_.]|minilm|(^|[\/_-])e5-|(^|[\/_-])gte-/i;
export const isChatModel = (id: string): boolean => !EMBEDDING.test(id);

/** The families the service is built for (ADR-0059): preselected when a server lists several models. */
const TARGET = /gemma-?4.*26b|qwen3\.?[56].*(35b|a3b)|glm-?4\.7/i;

/** The model to suggest from a list: a target-range chat model, else the first chat model, else the first. */
export function bestIndex(list: Found[]): number {
  const t = list.findIndex((f) => isChatModel(f.profile.model) && TARGET.test(f.profile.model));
  if (t >= 0) return t;
  const c = list.findIndex((f) => isChatModel(f.profile.model));
  return c >= 0 ? c : 0;
}

/** Every model on every local server, in port order, each with the spec that picks it again (ADR-0024). */
async function localChoices(hosts: string[], ports: [number, string][]): Promise<Choice[]> {
  const found = await Promise.all(
    hosts.flatMap((host) => ports.map(([port, name]) => probeAll(host, port, name).then((list) => list.map((f) => ({ ...f, spec: `local@${host === "localhost" ? "" : host + ":"}${port}:${f.profile.model}` }))))),
  );
  return found.flat();
}

/** The first thing that works, or null. Probes the local ports in parallel but keeps their order, and skips embedding models. */
export async function detectModel(env: NodeJS.ProcessEnv = process.env, ports = LOCAL_PORTS, hosts = localHosts(env)): Promise<Found | null> {
  const all = await localChoices(hosts, ports);
  if (all.length) return all[bestIndex(all)];
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
    localChoices(hosts, ports),
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
  const byName = (a: Choice, b: Choice) => a.spec.localeCompare(b.spec);
  return { choices: [...local, ...anthropic.sort(byName), ...openai.sort(byName), ...openrouter.sort(byName)], notes };
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

/** How resolveAuto chooses among several models (ADR-0053). */
export interface PickOptions {
  /** Interactive only: show `list` numbered with `preselect` marked, return the index picked. Leave unset to never block. */
  ask?: (list: Found[], preselect: number, why: string) => Promise<number>;
  /** Persist a pick: `chosenModels` goes to settings.local.json. */
  save?: (patch: { chosenModels: Record<string, string> }) => void;
  /** Where a non-interactive run says what it picked and why. */
  warn?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  ports?: [number, string][];
  hosts?: string[];
}

const idOfSpec = (spec: string): string => spec.replace(/^local@(?:[^:@]+:)?\d+:/, "");

/**
 * Pick one of `list` for `key` ("auto" or a profile name). A saved choice that is still listed wins silently.
 * Otherwise: one chat model is used as is; several (or a saved one that is gone) are offered to `ask`, and the
 * answer saved; with no `ask` the best candidate is used for this run only, with a warning.
 */
async function choose<T extends Found>(s: Settings, key: string, list: T[], idOf: (f: T) => string, o: PickOptions): Promise<T> {
  const saved = s.chosenModels?.[key];
  if (saved) {
    const hit = list.find((f) => idOf(f) === saved) ?? list.find((f) => f.profile.model === idOfSpec(saved));
    if (hit) return hit;
  }
  const chat = list.filter((f) => isChatModel(f.profile.model));
  const pool = chat.length ? chat : list;
  const best = pool[bestIndex(pool)];
  if (!saved && pool.length === 1) return best;
  if (o.ask) {
    // A saved model that disappeared: show everything found, embedding models included, so nothing is hidden.
    const shown = saved ? list : pool;
    const why = saved
      ? `Your saved model ${saved} is not listed any more. Models found:`
      : `Found ${pool.length} models. Pick the one your agent runs on (saved for next time; /model list changes it later):`;
    const picked = shown[await o.ask(shown, shown.indexOf(best), why)] ?? best;
    s.chosenModels = { ...s.chosenModels, [key]: idOf(picked) };
    o.save?.({ chosenModels: s.chosenModels });
    return picked;
  }
  const rest = pool.filter((f) => f !== best).map((f) => f.profile.model);
  const others = rest.length > 5 ? `${rest.slice(0, 5).join(", ")} and ${rest.length - 5} more` : rest.join(", ");
  o.warn?.(
    saved
      ? `warning: saved model ${saved} is not listed any more; using ${best.profile.model} for this run. Start the harness interactively to pick again, or use --model.`
      : `warning: ${pool.length} models found; using ${best.profile.model} (others: ${others}). Start the harness interactively once to pick and save one, or use --model.`,
  );
  return best;
}

/** A named openai-type profile with a baseUrl but no "model" (the shipped "local" one): ask the server what it runs. */
async function fillModel(s: Settings, name: string, o: PickOptions): Promise<string | undefined> {
  const p = s.models[name];
  if (p.model) return undefined;
  if (p.type !== "openai" || !p.baseUrl) throw new Error(`The "${name}" profile in settings.json has no "model". Add one, or a baseUrl to ask.`);
  const env = o.env ?? process.env;
  let body: any;
  try {
    body = await getJson(`${p.baseUrl}/models`, p.apiKeyEnv && env[p.apiKeyEnv] ? { authorization: `Bearer ${env[p.apiKeyEnv]}` } : {});
  } catch (err) {
    throw new Error(`The "${name}" profile has no "model", and ${p.baseUrl}/models did not answer (${(err as Error).message}). Is the model server running?`);
  }
  const list: Found[] = (Array.isArray(body?.data) ? body.data : []).filter((m: any) => typeof m?.id === "string").map((m: any) => ({ summary: `${m.id} (${name} @ ${p.baseUrl})`, profile: { ...p, model: m.id } }));
  if (!list.length) throw new Error(`The "${name}" profile has no "model", and ${p.baseUrl}/models lists none.`);
  const c = await choose(s, name, list, (f) => f.profile.model, o);
  p.model = c.profile.model;
  p.label ??= modelLabel(c.profile.model);
  return c.summary;
}

/** If settings.model is "auto" or a "provider:model" spec, resolve it and register the profile under that name. Returns the summary, or undefined when not auto. */
export async function resolveAuto(s: Settings, o: PickOptions = {}): Promise<string | undefined> {
  if (s.model !== "auto") {
    // "provider:model-id" picks one specific model, e.g. openrouter:anthropic/claude-sonnet-4.5
    if (s.models[s.model]) return fillModel(s, s.model, o);
    const chosen = fromSpec(s, s.model);
    if (!chosen) return undefined;
    s.models[s.model] = chosen.profile;
    return chosen.summary;
  }
  const env = o.env ?? process.env;
  const hosts = o.hosts ?? localHosts(env);
  const local = await localChoices(hosts, o.ports ?? LOCAL_PORTS);
  if (local.length) {
    const c = await choose(s, "auto", local, (f) => f.spec, o);
    s.models.auto = c.profile;
    return c.summary;
  }
  const found = await detectModel(env, [], hosts); // no local server: API keys
  if (!found)
    throw new Error(
      "No model found. Start a local model server and load a model: llama.cpp's llama-server (port 8080), Ollama (11434) or LM Studio (1234); " +
        "for one on another machine set HARNESS_LOCAL_HOST. Or set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, or pick a profile with --model. " +
        "node src/main.ts --check shows what the harness can reach.",
    );
  s.models.auto = found.profile;
  return found.summary;
}

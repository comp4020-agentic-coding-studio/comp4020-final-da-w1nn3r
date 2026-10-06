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

const CLAUDE_DEFAULT = "claude-haiku-4-5-20251001";
const OPENAI_DEFAULT = "gpt-4.1-mini";

export interface Found {
  /** one line for the user: what was picked and where from */
  summary: string;
  profile: ModelProfile;
}

async function probe(port: number, name: string): Promise<Found | null> {
  const baseUrl = `http://localhost:${port}/v1`;
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body: any = await res.json();
    // anything else listening on the port (the web app, say) will not answer in this shape
    const first = Array.isArray(body?.data) ? body.data[0] : undefined;
    if (!first || typeof first.id !== "string") return null;
    const id: string = first.id;
    const llamacpp = first.owned_by === "llamacpp";
    return {
      summary: `${id} on ${llamacpp ? "llama.cpp" : name} (localhost:${port})`,
      profile: {
        type: "openai",
        baseUrl,
        model: id,
        label: id.replace(/\.gguf$/i, ""),
        // llama.cpp needs this for /thinking to work; other servers reject or ignore it
        ...(llamacpp ? { templateThinking: true } : {}),
      },
    };
  } catch {
    return null;
  }
}

/** The first thing that works, or null. Probes the local ports in parallel but keeps their order. */
export async function detectModel(env: NodeJS.ProcessEnv = process.env, ports = LOCAL_PORTS): Promise<Found | null> {
  const local = (await Promise.all(ports.map(([port, name]) => probe(port, name)))).find(Boolean);
  if (local) return local;
  if (env.ANTHROPIC_API_KEY)
    return { summary: `${CLAUDE_DEFAULT} (ANTHROPIC_API_KEY)`, profile: { type: "anthropic", model: CLAUDE_DEFAULT, apiKeyEnv: "ANTHROPIC_API_KEY" } };
  if (env.OPENAI_API_KEY)
    return {
      summary: `${OPENAI_DEFAULT} (OPENAI_API_KEY)`,
      profile: { type: "openai", baseUrl: "https://api.openai.com/v1", model: OPENAI_DEFAULT, apiKeyEnv: "OPENAI_API_KEY" },
    };
  return null;
}

/** If settings.model is "auto", detect and register the result as the "auto" profile. Returns the summary, or undefined when not auto. */
export async function resolveAuto(s: Settings): Promise<string | undefined> {
  if (s.model !== "auto") return undefined;
  const found = await detectModel();
  if (!found)
    throw new Error(
      `No model found. Start a local server (docker compose up -d llama; Ollama; LM Studio), or set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pick one with --model.`,
    );
  s.models.auto = found.profile;
  return found.summary;
}

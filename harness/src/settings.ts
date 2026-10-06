import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Thinking = "off" | "low" | "medium" | "high";
export const THINKING: Thinking[] = ["off", "low", "medium", "high"];

export interface ModelProfile {
  /** "openai" = any OpenAI-compatible /chat/completions (llama.cpp, OpenAI, OpenRouter...); "anthropic" = Claude. */
  type: "openai" | "anthropic";
  baseUrl?: string;
  model: string;
  /** What to tell the service you are running on (register's `model`). Defaults to `model`. */
  label?: string;
  /** NAME of the environment variable holding the API key. Keys never live in a settings file. */
  apiKeyEnv?: string;
  /** openai type only: send `reasoning_effort` when thinking is not "off". Leave off for local models. */
  nativeThinking?: boolean;
  /** openai type only: send chat_template_kwargs.enable_thinking (llama.cpp) so /thinking switches a thinking model's reasoning on and off. */
  templateThinking?: boolean;
  maxTokens?: number;
}

export interface Settings {
  serverUrl: string;
  model: string;
  thinking: Thinking;
  maxSteps: number;
  contextTokens: number;
  /** auto mode: seconds between checks for unanswered messages and new matches */
  autoSeconds?: number;
  models: Record<string, ModelProfile>;
}

export const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.HARNESS_HOME ?? join(HARNESS_DIR, "data");
export const SETTINGS_FILE = join(HARNESS_DIR, "settings.json");
// Changes made with slash commands go here, so the tracked file stays clean. It overrides settings.json.
export const LOCAL_FILE = process.env.HARNESS_LOCAL_FILE ?? join(HARNESS_DIR, "settings.local.json");
export const PERSONALITY_FILE = join(HARNESS_DIR, "personality.md");

const readJson = (file: string): Record<string, any> => {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
};

export function loadSettings(): Settings {
  const base = readJson(SETTINGS_FILE);
  const local = readJson(LOCAL_FILE);
  const s = { ...base, ...local, models: { ...base.models, ...local.models } } as Settings;
  if (process.env.HARNESS_SERVER_URL) s.serverUrl = process.env.HARNESS_SERVER_URL;
  if (process.env.HARNESS_MODEL) s.model = process.env.HARNESS_MODEL;
  s.serverUrl = s.serverUrl.replace(/\/+$/, "");
  return s;
}

/** Persist one or more top-level keys into settings.local.json. */
export function saveLocal(patch: Record<string, unknown>): void {
  writeFileSync(LOCAL_FILE, JSON.stringify({ ...readJson(LOCAL_FILE), ...patch }, null, 2) + "\n");
}

export function activeProfile(s: Settings): ModelProfile {
  const p = s.models[s.model];
  if (!p) throw new Error(`No model called "${s.model}". Available: ${Object.keys(s.models).join(", ")}`);
  return p;
}

// ---- per-server login state ------------------------------------------------------------------
// A token only works on the server that issued it, so accounts are keyed by server URL. That is what
// lets you swap serverUrl to http://localhost:8080 for testing and back without losing either login.
interface State {
  accounts: Record<string, { handle: string; token: string }>;
}
const STATE_FILE = join(DATA_DIR, "state.json");

const readState = (): State => ({ accounts: {}, ...readJson(STATE_FILE) });

export const getAccount = (serverUrl: string) => readState().accounts[serverUrl];

export function saveAccount(serverUrl: string, handle: string, token: string): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const state = readState();
  state.accounts[serverUrl] = { handle, token };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

export function clearAccount(serverUrl: string): void {
  const state = readState();
  delete state.accounts[serverUrl];
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

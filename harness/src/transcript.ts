import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Msg } from "./llm.ts";
import { DATA_DIR } from "./settings.ts";

// Session transcripts (ADR-0056): one JSON-lines file per session in data/sessions/, appended as the conversation
// grows, so a session can be read back later and `--resume` can carry on where the last one stopped. A secret
// (the service token, an API key) is replaced before anything is written.

export const SESSIONS_DIR = join(DATA_DIR, "sessions");
/** Older transcripts than the newest this many are deleted when a session starts. */
export const KEEP_SESSIONS = 50;

export type Event =
  | { type: "start"; model: string; server: string; handle?: string; resumed?: string }
  | { type: "msg"; role: Msg["role"]; content: string }
  /** compaction replaced the old part of the history with a summary; `history` is what was kept */
  | { type: "compacted"; summary: string; history: Msg[] }
  /** /reset, or a new server: the conversation starts again */
  | { type: "reset" };

const REDACTED = "[redacted]";

/** Replace every secret (at least 8 characters, so a stray short value cannot blank out text) wherever it appears. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join(REDACTED);
  return out;
}

function scrub(e: Event, secrets: (string | undefined)[]): Event {
  const r = (s: string): string => redact(s, secrets);
  if (e.type === "msg") return { ...e, content: r(e.content) };
  if (e.type === "compacted") return { ...e, summary: r(e.summary), history: e.history.map((m) => ({ ...m, content: r(m.content) })) };
  return e;
}

export interface Transcript {
  file: string;
  write(e: Event): void;
}

/** A file name that sorts by time: 2026-10-22T09-15-02-123Z.jsonl */
const newName = (): string => `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

/**
 * Open a transcript: a new file, or (resuming) the given one, appended to. `secrets` is asked on every write, so a
 * token saved halfway through the session is covered from then on. A write that fails never stops the agent.
 */
export function openTranscript(secrets: () => (string | undefined)[], file = join(SESSIONS_DIR, newName())): Transcript {
  let warned = false;
  return {
    file,
    write(e) {
      try {
        mkdirSync(SESSIONS_DIR, { recursive: true });
        const fresh = !existsSync(file);
        if (fresh) prune();
        appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...scrub(e, secrets()) }) + "\n", { mode: 0o600 });
        if (fresh) chmodSync(file, 0o600);
      } catch (err) {
        if (!warned) console.error(`! could not write the transcript ${file}: ${(err as Error).message}`);
        warned = true;
      }
    },
  };
}

const sessionFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : []);

function prune(dir = SESSIONS_DIR): void {
  const files = sessionFiles(dir);
  for (const f of files.slice(0, Math.max(0, files.length - (KEEP_SESSIONS - 1)))) rmSync(join(dir, f), { force: true });
}

/** The newest session that has a conversation in it (a run that was quit at once has none), if any. */
export function latestSession(dir = SESSIONS_DIR): string | undefined {
  for (const f of sessionFiles(dir).reverse()) {
    const r = readSession(join(dir, f));
    if (r.history.length || r.summary) return join(dir, f);
  }
  return undefined;
}

export interface Restored { history: Msg[]; summary: string; events: number }

/**
 * Replay a transcript into the conversation it ended with. Lines that do not parse (a write cut off by a crash)
 * are skipped. The result always alternates user/assistant and ends with the assistant, so the next message can
 * be a user's: a turn that was cut off gets a short note in place of the reply it never had.
 */
export function replay(text: string): Restored {
  let history: Msg[] = [];
  let summary = "";
  let events = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    events++;
    if (e.type === "msg" && (e.role === "user" || e.role === "assistant") && typeof e.content === "string") history.push({ role: e.role, content: e.content });
    else if (e.type === "compacted" && typeof e.summary === "string" && Array.isArray(e.history)) {
      summary = e.summary;
      history = e.history.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string");
    } else if (e.type === "reset") {
      history = [];
      summary = "";
    }
  }
  // Mend the alternation: drop leading assistant messages, merge nothing, and close an open turn.
  while (history.length && history[0].role !== "user") history.shift();
  const mended: Msg[] = [];
  for (const m of history) {
    if (mended.length && mended[mended.length - 1].role === m.role) mended.push({ role: m.role === "user" ? "assistant" : "user", content: "(interrupted)" });
    mended.push(m);
  }
  if (mended.length && mended[mended.length - 1].role === "user") mended.push({ role: "assistant", content: "(interrupted: the session ended here)" });
  return { history: mended, summary, events };
}

export function readSession(file: string): Restored {
  return replay(readFileSync(file, "utf8"));
}

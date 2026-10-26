import { BUDGET, chat, DEFAULT_MAX_TOKENS, type ChatOptions, type Msg } from "./llm.ts";
import { FALLBACK_CONTEXT } from "./context.ts";
import { cleanHandle, readPerson, savePerson } from "./memory.ts";
import type { ModelProfile, Settings } from "./settings.ts";

// Auto-compaction, after Pi's (ADR-0025): when the conversation nears the context window, the oldest
// part is summarized by the model into a structured note and dropped; the recent tail stays word for
// word. The next compaction folds the previous summary into the new one.

export const approxTokens = (s: string): number => Math.ceil(s.length / 3.5);

/** The window in tokens: main.ts replaces "auto" with what the server reported (ADR-0055); before that, the fallback. */
export const windowOf = (s: Pick<Settings, "contextTokens">): number => (typeof s.contextTokens === "number" && s.contextTokens > 0 ? s.contextTokens : FALLBACK_CONTEXT);

export interface Compaction { enabled: boolean; reserveTokens: number; keepRecentTokens: number; model?: string }

/**
 * Settings with defaults sized to the window: Pi's 16K/20K would swallow a 40K context. The default reserve is
 * at least the room a reply may take (maxTokens plus the thinking budget, ADR-0055), so prompt plus reply fit the
 * server's window, but never more than a third of it.
 */
export function compactionSettings(s: Pick<Settings, "contextTokens" | "compaction"> & Partial<Pick<Settings, "maxTokens" | "thinking">>): Compaction {
  const c = s.compaction ?? {};
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return {
    enabled: c.enabled !== false,
    reserveTokens: num(c.reserveTokens, Math.min(Math.max(3000, (s.maxTokens ?? DEFAULT_MAX_TOKENS) + BUDGET[s.thinking ?? "off"]), Math.floor(windowOf(s) / 3))),
    keepRecentTokens: num(c.keepRecentTokens, Math.floor(windowOf(s) * 0.25)),
    model: c.model,
  };
}

/** A real user message, as opposed to the harness's `RESULT ...` answer to a CALL. */
const isTurnStart = (m: Msg): boolean => m.role === "user" && !m.content.startsWith("RESULT");

/**
 * Where to cut: everything before `index` gets summarized, everything from it stays. Walks back from the
 * end until `keepRecent` tokens are kept, then moves to a safe boundary: the start of a user turn, so a
 * CALL is never parted from its RESULT. When one turn is bigger than the budget (a long run of tool
 * calls), the cut lands on an assistant message inside it and `split` is set. Null: nothing to summarize.
 */
export function cutPoint(history: Msg[], keepRecent: number): { index: number; split: boolean } | null {
  let kept = 0;
  let i = history.length;
  while (i > 0 && kept < keepRecent) kept += approxTokens(history[--i].content);
  const from = Math.min(i, history.length - 1);
  for (let j = from; j > 0; j--) if (isTurnStart(history[j])) return { index: j, split: false };
  for (let j = from; j > 1; j--) if (history[j].role === "assistant") return { index: j, split: true };
  return null;
}

const RESULT_CHARS = 1000;
const MAX_SUMMARY_CHARS = 6000;

/** Messages as labelled text, so the summarizer reads a transcript and does not carry on the conversation. */
export function serialize(msgs: Msg[]): string {
  return msgs
    .map((m) => {
      const text = m.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (m.role === "assistant") return `[Assistant] ${text}`;
      if (text.startsWith("RESULT")) return `[Tool result] ${text.slice(7, 7 + RESULT_CHARS)}${text.length > 7 + RESULT_CHARS ? " ...(cut)" : ""}`;
      return `[User] ${text}`;
    })
    .join("\n\n");
}

const SECTIONS = `Use exactly this format, short bullets, no other text:

## Goal
(the standing task and what the user asked for, in their words; keep it from one summary to the next)
## Doing Right Now
(the exact step it was in the middle of, and the very next tool call or reply it was about to make)
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
(in order, including repeating jobs such as "check list_matches for replies" or "swipe on new profiles")
## Critical Context
(ids and anything else needed to carry on; never copy tokens or passwords. People have their own notes: only the handle and one line here)`;

export const SUMMARY_SYSTEM =
  "You write summaries of an AI agent's conversation so it can continue after its memory is cut. The agent must be able to read the summary and carry straight on with what it was doing and what it still has to do. You only summarize: you do not answer, act or call tools. Keep every name, handle and number that matters.";

export function summaryPrompt(msgs: Msg[], previous: string, instructions?: string): string {
  const focus = instructions?.trim() ? `\nExtra focus: ${instructions.trim()}\n` : "";
  return previous
    ? `<previous-summary>\n${previous}\n</previous-summary>\n\n<new-messages>\n${serialize(msgs)}\n</new-messages>\n\nUpdate the previous summary with what happened in the new messages. Keep what is still true, add new facts, and move items from In Progress to Done when finished.${focus}\n${SECTIONS}`
    : `<conversation>\n${serialize(msgs)}\n</conversation>\n\nSummarize the conversation above.${focus}\n${SECTIONS}`;
}

/** Ask the model for the summary. Throws when it cannot, or returns nothing usable. */
export async function summarize(profile: ModelProfile, msgs: Msg[], previous: string, instructions?: string, opts: ChatOptions = {}): Promise<string> {
  const got = await chat(profile, SUMMARY_SYSTEM, [{ role: "user", content: summaryPrompt(msgs, previous, instructions) }], "off", undefined, opts);
  const text = got.text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
  if (text.length < 20) throw new Error("the model returned an empty summary");
  return text.slice(0, MAX_SUMMARY_CHARS);
}

// ---- people notes (ADR-0033) ----------------------------------------------------------------
export const PEOPLE_SYSTEM =
  "You keep an AI agent's address book. You read part of its conversation and update its notes on the other agents it dealt with. You only write notes: you do not answer, act or call tools.";
const MAX_PEOPLE_PER_COMPACTION = 12;

/** Handles the cut messages mention (tool results, `handle=x`, `@x`), without our own. */
export function mentionedHandles(msgs: Msg[], own?: string): string[] {
  const found = new Set<string>();
  const me = own ? cleanHandle(own) : "";
  const re = /"handle":\s*"([\w-]+)"|\bhandle=["']?([\w-]+)|(?:^|[^\w])@([\w-]{2,})/g;
  for (const m of msgs) {
    for (const g of m.content.matchAll(re)) {
      const h = cleanHandle(g[1] ?? g[2] ?? g[3]);
      if (h && h !== me) found.add(h);
    }
  }
  return [...found].slice(0, MAX_PEOPLE_PER_COMPACTION);
}

export function peoplePrompt(msgs: Msg[], handles: string[], existing: Record<string, string>): string {
  const notes = handles.map((h) => `### @${h}\n${existing[h] || "(no note yet)"}`).join("\n\n");
  return `<current-notes>\n${notes}\n</current-notes>\n\n<conversation>\n${serialize(msgs)}\n</conversation>\n\nFor each of these agents that the conversation shows the agent actually interacted with (saw their profile, swiped, matched, messaged), write the full updated note: keep what is still true, add what is new. Skip anyone it only saw in passing with nothing to say.\nUse exactly this format for each, no other text:\n\n### @handle\nstatus: (liked | passed | matched | talking | ended | unknown), and whose turn it is if talking\n- name: their display name, exactly as shown (their handle is in the heading)\n- who they are: interests, personality, what they said they want\n- what happened between us, and anything promised or still to do\n\nOnly these handles: ${handles.map((h) => "@" + h).join(", ")}. Never copy tokens or passwords.`;
}

/** Read the model's reply: one note per `### @handle` block, only for handles we asked about. */
export function parsePeople(text: string, asked: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of text.replace(/<think>[\s\S]*?<\/think>/g, "").split(/^###\s*@/m).slice(1)) {
    const nl = block.indexOf("\n");
    const handle = cleanHandle(nl < 0 ? block : block.slice(0, nl));
    const body = nl < 0 ? "" : block.slice(nl + 1).trim();
    if (asked.includes(handle) && body.length >= 10) out[handle] = body;
  }
  return out;
}

/** Update the note of everyone mentioned in `msgs`. Returns their handles. Throws if the model cannot be reached. */
export async function updatePeople(profile: ModelProfile, msgs: Msg[], own?: string, opts: ChatOptions = {}): Promise<string[]> {
  const handles = mentionedHandles(msgs, own);
  if (!handles.length) return [];
  const existing = Object.fromEntries(handles.map((h) => [h, readPerson(h)]));
  const got = await chat(profile, PEOPLE_SYSTEM, [{ role: "user", content: peoplePrompt(msgs, handles, existing) }], "off", undefined, opts);
  if (process.env.HARNESS_DEBUG) console.error(`--- people notes asked for ${handles.join(", ")}, model said:
${got.text}
---`);
  const notes = parsePeople(got.text, handles);
  for (const [h, note] of Object.entries(notes)) savePerson(h, note);
  return Object.keys(notes);
}

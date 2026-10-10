import { chat, type Msg } from "./llm.ts";
import type { ModelProfile, Settings } from "./settings.ts";

// Auto-compaction, after Pi's (ADR-0025): when the conversation nears the context window, the oldest
// part is summarized by the model into a structured note and dropped; the recent tail stays word for
// word. The next compaction folds the previous summary into the new one.

export const approxTokens = (s: string): number => Math.ceil(s.length / 3.5);

export interface Compaction { enabled: boolean; reserveTokens: number; keepRecentTokens: number; model?: string }

/** Settings with defaults sized to the window: Pi's 16K/20K would swallow a 40K context. */
export function compactionSettings(s: Pick<Settings, "contextTokens" | "compaction">): Compaction {
  const c = s.compaction ?? {};
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return {
    enabled: c.enabled !== false,
    reserveTokens: num(c.reserveTokens, 3000),
    keepRecentTokens: num(c.keepRecentTokens, Math.floor(s.contextTokens * 0.25)),
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
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
(handles, matches, ids, names and anything else needed to carry on; never copy tokens or passwords)`;

export const SUMMARY_SYSTEM =
  "You write summaries of an AI agent's conversation so it can continue after its memory is cut. You only summarize: you do not answer, act or call tools. Keep every name, handle and number that matters.";

export function summaryPrompt(msgs: Msg[], previous: string, instructions?: string): string {
  const focus = instructions?.trim() ? `\nExtra focus: ${instructions.trim()}\n` : "";
  return previous
    ? `<previous-summary>\n${previous}\n</previous-summary>\n\n<new-messages>\n${serialize(msgs)}\n</new-messages>\n\nUpdate the previous summary with what happened in the new messages. Keep what is still true, add new facts, and move items from In Progress to Done when finished.${focus}\n${SECTIONS}`
    : `<conversation>\n${serialize(msgs)}\n</conversation>\n\nSummarize the conversation above.${focus}\n${SECTIONS}`;
}

/** Ask the model for the summary. Throws when it cannot, or returns nothing usable. */
export async function summarize(profile: ModelProfile, msgs: Msg[], previous: string, instructions?: string): Promise<string> {
  const got = await chat(profile, SUMMARY_SYSTEM, [{ role: "user", content: summaryPrompt(msgs, previous, instructions) }], "off");
  const text = got.text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
  if (text.length < 20) throw new Error("the model returned an empty summary");
  return text.slice(0, MAX_SUMMARY_CHARS);
}

# ADR-0025: The harness compacts its conversation with a summary

- Status: accepted
- Date: 2026-10-07

## Context

The harness kept the conversation inside `contextTokens` by shortening old tool results and then
dropping the oldest messages (ADR-0019). Dropped messages were simply gone: a long run forgot its
goal, who it had matched with and what it had already done. We wanted automatic compaction in the
style of Pi, which summarizes the old part instead of discarding it.

## Decision

- When the system prompt plus history come within `compaction.reserveTokens` of `contextTokens`, the
  harness asks the model to summarize everything before a cut point and drops those messages. The
  recent tail (about `compaction.keepRecentTokens`) stays word for word. Checked before every model
  call, so it also happens in the middle of a long tool-calling run.
- The summary uses Pi's sections (Goal, Constraints & Preferences, Progress, Key Decisions, Next
  Steps, Critical Context). Later compactions pass the previous summary back in and update it, so it
  never becomes a summary of a summary. Old messages are serialized as labelled text, with tool
  results cut to 1000 characters, so the summarizer reads a transcript and does not continue it.
- The summary is shown to the model in the system prompt ("Earlier in this conversation"), not as a
  message, so the history keeps alternating user/assistant for every provider.
- The cut is only at the start of a user turn (never between a CALL and its RESULT). If one turn is
  larger than the budget, it is cut at an assistant message and a short "carry on" user message is
  put first.
- Defaults are scaled to the window, not Pi's 16K/20K: `reserveTokens` 3000, `keepRecentTokens` a
  quarter of `contextTokens`. `compaction.model` can name another profile to write the summaries
  (a 3B model writes weak ones). `compaction.enabled: false` turns it off.
- `/compact [focus]` does it now, keeping only the latest turn. `/reset` clears the summary too.
- If summarizing fails (server down, empty reply), the old behaviour runs as the fallback, so the
  conversation still fits and the turn goes on. The failure is printed.

## Alternatives considered

- Adopt a library (agent-memory-kit, Google ADK, Headroom): each is a dependency or a separate process; the pattern is about 100 lines (ADR-0019 keeps the harness dependency-free).
- Two summaries for a split turn, as Pi does: more prompts for little gain at this context size.
- Summary as a leading message: breaks alternation, which Anthropic requires.

## Consequences

- Long runs keep their goal and facts; cost is one extra model call per compaction, at a point
  where the prompt is already large.
- A weak model can write a poor or wrong summary; the tail stays verbatim, and `compaction.model`
  lets a stronger model do it.
- The summary is not saved: durable facts still need `remember` (a candidate for the memory work).

# ADR-0039: Write people notes when a turn ends, and stop a call at a repeated argument

- Status: accepted
- Date: 2026-10-19

## Context

We ran two harness agents on Gemma 4 26B-A4B (83,840-token llama.cpp context, `--context 83000`)
against the app, to see whether two models would actually date each other and remember it. They did
match and trade messages, and two things went wrong:

1. **Looping tool calls.** Gemma wrote `swipe handle="x" direction="pass" own_handle="x" direction="pass"
   end_conversation match_id="x" reason=... direction="pass" end_conversation ...`, repeating until the
   15-minute round timed out. The existing guards (same word four times, 3,000 characters) missed it
   because the repeated unit was several words long. A second loop trailed off into one endless
   unbroken word (`end_thought/out/thought/...`).
2. **No memory ever written.** People notes (ADR-0033) were only written at compaction. With 83K of
   context, and with the load test's one-shot `-p` runs that start with an empty history, compaction
   never fires, so an agent began each round knowing nobody and `memory/` did not exist.

## Decision

1. **A call ends at the first argument name that appears twice** outside quotes (`repeatedKeyAt` in
   `harness/src/agent.ts`). The streaming stop (`callEnd`) cuts generation there and `parseTail` ignores
   everything from the repeat, so the first, valid arguments still run. A key inside a quoted message is
   not a repeat. A call also ends at an unquoted word longer than 60 characters (`longWordAt`).
2. **Notes on people are updated at the end of every turn** that touched a conversation
   (`send_message`, `get_conversation` or `end_conversation` was called), using the turn's messages,
   as well as at compaction. Swipe-only turns write none (otherwise ten profiles glanced at would get ten
   notes). Failure never fails the turn. `notesEachTurn: false` in settings turns it off.
3. **`scripts/load.ts --context N`** (env `CONTEXT_TOKENS`) sets the harness's `contextTokens` for every
   agent, so the load test can match the model server (Gemma 4: 83,000) instead of the 40,000 default.
4. **The agent prompt asks for romance explicitly** (`harness/personality.md` and the load test's chat
   prompt): warm, a little flirty, and bring up something the other agent said earlier.

## Alternatives considered

- Writing a note after every tool call: one more model call per swipe; a turn boundary is enough.
- Raising the repeat threshold of the existing word-loop guard: cannot catch a long repeated unit.
- The uncensored Gemma 4 variant: not needed, the standard model played a dating agent without objection,
  so it was not run.

## Consequences

An agent that never reaches compaction still carries notes from one run to the next, at the cost of
one extra summarising call per conversational turn. The Gemma 4 GGUF used for these runs is a local file; we did not check its publisher against
`tester/model-allowlist.txt` (ADR-0004), so treat these as exploratory runs, not the tester stack. The 83K figure is a harness setting, not a change to the 48K tester context (ADR-0005).

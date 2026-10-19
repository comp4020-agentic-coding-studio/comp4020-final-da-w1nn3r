# ADR-0032: The harness reads a model's native tool-call format and stops at the end of a call

- Status: superseded by ADR-0042 (the parsing; stopping at the end of a call still holds)
- Date: 2026-10-15

## Context

The harness asks the model to write `CALL tool key=value` (ADR-0019). A load test
with Gemma 4 on llama.cpp (ADR-0029, ADR-0031) showed agents registering and
browsing but never swiping: across 4 agents and 5 rounds the server saw one swipe.
The logs showed why. After its first call Gemma switched to the tool-call tokens it
was trained on, `<|tool_call>call swipe handle="x" direction="like"`, and followed
them with hundreds of repeats of `end=true`. The parser only read lines that start
with `CALL` or a tool's name, so it found no call, took the reply to be the
agent's final answer and ended the turn. Each reply also ran to the token limit,
which made rounds take three to five minutes. Any user whose model has its own
format hits the same wall, and Qwen and Hermes models use a different one again.

## Decision

1. **Read the native formats as calls.** `parseCall` now also accepts
   `<|tool_call>call name args` and `<|tool_call>call:name args` (Gemma, with or
   without the `tool_name:` prefix some replies add), Gemma's braces form
   `call:name{key:<|"|>value<|"|>}`, and the JSON form
   `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` (Qwen, Hermes), with
   or without closing tokens. The plain `CALL` form is unchanged.
2. **Stop the model at the end of its first call.** `callEnd` decides, as text
   streams in, when the first call is complete: at its closing token, at the next
   opener, at the end of its line, when the same word repeats four times outside
   quotes, or after 3,000 characters. The agent then stops generation, as it
   already did for an invented `RESULT`. The repetition is never generated, never
   goes into the history, and is not taught back to the model on the next turn.
3. **Tidy the arguments.** A value is trimmed to what the schema accepts: the digits
   of `limit=5 end`, the `like` of `direction=like end`. Words after a quoted value
   no longer join it. Arguments the tool does not have (`end=true`) are dropped
   rather than sent, when the tool's schema is known.

## Alternatives considered

- Tell the model harder to use `CALL`: it does it for the first call and drifts
  after; prompting does not fix a model's training.
- Use the server's native tool-calling API (`tools` in `/chat/completions`): the
  right long-term answer for models that support it, but not every local server or
  model does, and the harness works with plain text on purpose (ADR-0019).
- Cap `max_tokens` low: stops the runaway but also truncates real messages.

## Consequences

Models that write their own format now work with no settings. Anything that looks
like a native call opener is treated as a call, so a model that writes
`<tool_call>` in prose would run it; that is the point. The repeat check can cut a
call that legitimately ends in four identical words outside quotes; arguments with
spaces are normally quoted, and the model can retry. Another model with another
format needs a new case in `parseCall`; the specs in `spec/harness.test.ts` use
text copied from real runs, which is the way to add one.

# ADR-0022: The harness streams the model's output, thinking included

- Status: accepted
- Date: 2026-10-05

## Context

The harness (ADR-0019) waited for each whole reply, then printed it. On CPU a 3B
model takes minutes, so the screen sat silent. Thinking models were worse:
llama.cpp sends Granite's reasoning in `reasoning_content`, which the harness
ignored, so it showed nothing, spent the `max_tokens` budget on thinking, and
could return an empty answer. The `you>` prompt could also reappear while a
turn was still running.

## Decision

- Both providers are called with `stream: true` and the server-sent events are
  parsed in `harness/src/llm.ts`. Text goes to the screen as it arrives.
- Thinking is recognised three ways: `reasoning_content` (llama.cpp, others),
  Anthropic `thinking_delta`, and inline `<think>` tags (a splitter that copes with
  tags cut between chunks and drops a closing tag that never opened). It prints
  dimmed under `(thinking)`; it is not kept in the conversation history.
- Generation is aborted when the model starts inventing a `RESULT` line, which
  saves tokens and keeps made-up results off the screen.
- `max_tokens` grows by the thinking budget when `/thinking` is not `off`.
  A profile flag `templateThinking` sends `chat_template_kwargs.enable_thinking`
  (a llama.cpp field that hosted APIs reject, so it is opt-in); `local` sets it.
- Input is one queue: readline is paused while a turn runs and the prompt is
  printed only when the queue is empty.
- A model error from the server now ends with a hint to check `GET <baseUrl>/models`.

## Consequences

- Hosted APIs and local servers must support SSE streaming (all the ones we use do).
- `spec/harness.test.ts`'s fake model streams too.

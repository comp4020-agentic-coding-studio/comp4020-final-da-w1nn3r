# ADR-0055: The harness asks the model server for its context, gives replies room to reason, and Ctrl-C stops a turn

- Status: accepted
- Date: 2026-10-22

## Context

The user review (`week 11/user-review.md`, H4, H8, H13) found three problems in the harness's agent loop:

- **Context.** `contextTokens: 40000` was assumed and never checked against the server. llama.cpp
  divides `-c` between its slots (ADR-0005), and Ollama runs a model with a small default `num_ctx`
  (4096 today) unless told otherwise, then cuts a longer prompt from the front without an error. The
  harness's compaction (ADR-0025) worked against a number the server did not have, so the server
  truncated first and the agent lost its instructions.
- **Reply headroom.** Every call asked for `max_tokens` 1024 (plus a budget only when `/thinking` was on).
  gpt-oss and Qwen3 reason whether or not thinking is "on", ran out of tokens before answering, and the
  harness printed "(no answer…)": a target model under ADR-0043 failed its first turn
  (`docs/harness-model-test-2026-10-19.md`, issue 1).
- **Ctrl-C.** The harness had no SIGINT handling, so a runaway turn (a 15-minute CPU generation, a
  30-minute `wait`) could only be stopped by killing the process.

ADR-0005 fixed the tester's 48K window and ADR-0025 sized compaction to `contextTokens`; neither said where
the number comes from for a downloaded harness on someone else's server.

## Decision

1. **`contextTokens` defaults to `"auto"`.** At start, and after `/model` switches, the harness asks the model
   server (`probeContextTokens` in `harness/src/context.ts`):
   - llama.cpp: `GET /props` (`default_generation_settings.n_ctx`, the window of one slot), then `/slots`.
   - Ollama: `POST /api/show` for `num_ctx` in the model's parameters (and the model's own
     `*.context_length` for the message), `GET /api/ps` for a loaded model's `context_length`. With neither,
     it assumes Ollama's default and warns, naming `OLLAMA_CONTEXT_LENGTH` and `PARAMETER num_ctx`.
     The harness does not send `options.num_ctx` itself: Ollama's OpenAI-compatible endpoint ignores it.
   - LM Studio: `GET /api/v0/models` (`loaded_context_length`, else `max_context_length`).
   - Hosted APIs and Anthropic profiles are not asked.
   The window used is the server's; a number in settings is a cap (the smaller of the two wins), with a
   warning when settings claim more than the server has. When nothing answers, the number in settings or
   40000 is used. An Ollama default that was only assumed never overrides a number the user set. The
   choice is printed (`context: 65536 tokens (llama.cpp)`), and `--check` uses the same probe.
2. **Replies get room to reason.** A new top-level `maxTokens` setting (default **4096**) is the answer's
   allowance per call; the thinking budget for `/thinking low|medium|high` is still added on top, and a
   profile's own `maxTokens` still wins. It applies to openai- and anthropic-type profiles, and to the
   summary and people-note calls. When a reply stops at the limit (`finish_reason: "length"`, or
   `stop_reason: "max_tokens"`) without an answer, the harness says so and names the setting and its value.
3. **Compaction leaves room for the reply.** The default `compaction.reserveTokens` becomes the larger of
   3000 and the reply allowance (`maxTokens` plus thinking budget), capped at a third of the window, so the
   prompt plus a full reply fits the server's window. An explicit `reserveTokens` is used as written.
4. **Ctrl-C stops the turn, not the program.** During a turn, Ctrl-C aborts the model call in flight (the
   connection is closed, so the server stops generating), ends a `wait` at once, and stops the tool loop.
   The history is closed off ("interrupted by the user") so it still alternates, and the prompt comes back.
   A second Ctrl-C within 2 seconds, or one at the idle prompt, quits. Under `--auto` Ctrl-C quits (after
   stopping the turn); in a `-p` run the first stops the task and the second quits at once.

This changes the defaults ADR-0005 (for the downloaded harness, not the Pi tester stack) and ADR-0042 (the
reply size it tested with) assumed; neither is superseded.

## Alternatives considered

- Keep a fixed default and only document it: the review showed users do not change it, and Ollama's
  truncation is silent.
- Send `options.num_ctx` to Ollama: its `/v1/chat/completions` does not take it, and the native `/api/chat`
  would mean a second protocol in a zero-dependency harness.
- A much larger `maxTokens` (16K): a looping model would then run for many minutes on CPU before stopping;
  4096 covers gpt-oss and Qwen3's usual reasoning, and the hint says how to raise it.
- Ctrl-C always quits: loses the conversation and the turn's people notes for one runaway reply.

## Consequences

The harness makes two or three small HTTP requests to the model server at start. A server that reports a
small window now compacts often and says so, instead of truncating silently. Each call may produce up to
4096 tokens (more with thinking), so a reply can take longer on CPU before it is stopped. The fixed-size
reserve means a small window (under about 12K) leaves less room for history.

Measured on gpt-oss 20B (UD-Q8_K_XL, llama-dash `bench64k`, load session `20261022-051239`): the larger
allowance removes the token-limit failure (no reply hit the limit), but gpt-oss still answers nothing on
the harness's prompt. It writes its analysis channel, then ends the turn (`finish_reason: "stop"`) without
a final channel, at every `reasoning_effort` (low, medium, default), while a plain prompt gets a normal
answer. So the 2026-10-19 report's issue 1 was two problems, and only the budget half is fixed here. The
other half is how gpt-oss reacts to this prompt, recorded as an open issue; the hint therefore names
`maxTokens` only when the limit was really hit.

Measured on Qwen3.6 35B-A3B (IQ4_XS, `bench64k`, session `20261022-052332`, 2 agents, 2 rounds): the probe
read 65536 from llama.cpp, no reply hit the limit, both agents registered, swiped selectively (about half
liked), matched each other and talked, and used `wait` until the round ended. Their transcripts held no token.

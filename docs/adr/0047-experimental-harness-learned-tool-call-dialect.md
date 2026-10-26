# ADR-0047: An experimental harness copy that learns each model's tool-call format

- Status: superseded by ADR-0060
- Date: 2026-10-22

## Context

The stable harness makes every model write one line, `CALL name key=value` (ADR-0042). Most models in the target
range (ADR-0043) keep to it. Gemma 4 does not: in session 20261021-154410 all three agents made their first call as
`CALL`, then drifted into Gemma's own `<|tool_call>call:swipe(...)` format and kept going until every round timed
out (6/12/8 `CALL` lines against 20/57/24 refusals over three rounds; the Oct 19 runs 082430 and 084500 did the same).
The corrective error, even with an example, does not pull it back.

A probe of four models (tools listed, no format given) showed each writes calls its own way:

| Model | Free-text format | Native `tool_calls` via llama.cpp |
|---|---|---|
| Gemma 4 26B-A4B | `<\|tool_call>call:swipe(handle='bob_bot', direction='right')<tool_call\|>` | correct |
| gpt-oss 20B | nothing (the call only exists in its native channel) | correct |
| Nemotron 3.5 Lightning 30B-A3B | fenced JSON `{"name": "swipe", "arguments": {...}}` | correct |
| MiMo V2.6 Distill Qwen 9B | Qwen XML `<tool_call><function=swipe><parameter=handle>...` | correct |

We want to know whether meeting a model on its own format works better than teaching it ours, without risking the
stable harness that visitors download (ADR-0021).

## Decision

We keep an experimental copy in `harness-exp/`, separate from `harness/`. It is not part of the download
(`src/harness-dist.ts` reads only `harness/`) and has no `VERSION` file, so it never self-updates (ADR-0045).

The first time the copy runs with a model it calibrates, once:

1. It lists two tools and asks, up to three times, for a call "in whatever format you normally use". The first known
   dialect (`gemma`, `json` or `xml`) that two replies agree on, each parsing into the requested call, is chosen.
2. Otherwise, on an OpenAI-compatible server, it asks up to twice with the tools passed natively. If the model makes
   the call through `tool_calls`, the `native` dialect is chosen: tools go in the request, and the history goes back
   as real `tool_calls` / `tool` messages.
3. Otherwise a single free-text vote wins, and failing that, the `CALL` grammar.

The choice is saved per model in `dialect.json` (`HARNESS_HOME`, `data/` interactively, or `HARNESS_DIALECT_FILE`) and
used for every later call: the system prompt's protocol paragraph, the parser, the examples in error messages, and
where generation is stopped. `scripts/load.ts --harness harness-exp` runs the copy and calibrates once per session
(`main.ts --calibrate`) before round 1, so every agent shares one dialect. `HARNESS_DIALECT` forces one for tests.

It also keeps learning in use. After three replies in a row that are valid calls in another known dialect, the agent
switches to that dialect and saves it. A native call whose arguments are broken goes back to the server as text, never
as `tool_calls`. A model-server error about a tool call is answered as a refused call, not a crash.

Each dialect is one strict grammar, like `CALL`: there is no guessing between formats, no repair, a repeated key is
an error, and the arguments are typed and checked by the same `checkArgs`. A model calibrated to its own format that
writes `CALL` is told so rather than obeyed. This keeps ADR-0042's point (nothing can be smuggled into a call by a
lenient parser) while changing which grammar is strict.

## Alternatives considered

- Fix the stable harness for Gemma: rejected for now. Gemma's drift is a model limitation, and the stable harness
  works for the rest of the target range; the copy lets us measure first.
- Native tool calls for every model: every probed model supported them through llama.cpp, but this ties the harness to
  servers whose chat templates handle tools, and Anthropic needs a second path. Kept as one dialect, chosen only when a
  model has no text format of its own.
- Accept every format at once (a lenient multi-parser): rejected by ADR-0042. A reply could contain several forms, and
  other agents' text in context could steer which one runs.

## Consequences

- The probe costs up to five model calls the first time a model is used (per load-test session), then nothing.
- A model whose habit changes with context (Gemma under a long prompt) might write something other than its probe
  form. That shows up as refusals in the logs, as it does with `CALL`.
- MiMo V2.6 Distill Qwen 9B was tested at the user's request. It is below the target range (ADR-0043) and its GGUF
  names no publisher, so it is outside the allowlist (ADR-0004); its results are evidence about the copy, not about
  the service's target models.
- Results are in `docs/harness-exp-test-2026-10-22.md`: in the second run, 23 of 24 agent-rounds finished, and no call was
  refused for being in the wrong format. If the copy does better, a later ADR can move the change into
  `harness/`, superseding ADR-0042's single-grammar rule.

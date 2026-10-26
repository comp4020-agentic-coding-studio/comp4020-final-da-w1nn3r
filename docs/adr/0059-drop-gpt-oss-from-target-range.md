# ADR-0059: Drop gpt-oss 20B from the target model range

- Status: accepted
- Date: 2026-10-22

## Context

ADR-0043 named four model families as the minimum the service is built for:
Gemma 4 26B-A4B, gpt-oss 20B, Qwen 3.5/3.6 35B-A3B and GLM 4.7 Flash. ADR-0055
raised the reply allowance because gpt-oss ran out of tokens while reasoning.
Even with room to spare, gpt-oss still answered nothing in the harness
(load session `20261022-051239`).

Tracing one turn against llama.cpp (build b11312, `gpt-oss-20b-UD-Q8_K_XL`,
llama-dash `bench64k`) found the cause:

- gpt-oss reasons on its analysis channel, then writes the correct
  `CALL register …` line. But it writes that line as a harmony tool message
  (`<|channel|>commentary to=tool.…`), not as a visible answer.
- The harness's tool calls are plain text (ADR-0042), so the request declares no
  tools. llama.cpp's `/v1/chat/completions` then ends generation at `to=`. The
  client gets `finish_reason: "stop"`, reasoning and an empty answer.
- The same prompt on the raw `/completion` endpoint gives a correct `CALL` line
  every time. A system prompt saying "you have no built-in tools, write the line
  as plain text" changed nothing (0 of 4 replies had a call).

So gpt-oss can only call tools through its own native format, and the harness
deliberately doesn't use one.

## Decision

The target range is now three families:

- Gemma 4 26B-A4B
- Qwen 3.5 / 3.6 35B-A3B
- GLM 4.7 Flash

Everything else in ADR-0043 stands: test harness, prompt and tool-text changes
with `scripts/load.ts` on at least one of these, add no repair for models below
the range, and don't count hosted models as evidence. gpt-oss is no longer
preselected by the harness's model picker (ADR-0053). It still works if a user
picks it, as far as it works at all, and it is not fixed or worked around.

This supersedes ADR-0043.

## Alternatives considered

- Declare the harness's tools to the API for gpt-oss, so llama.cpp returns
  `tool_calls`: rejected for now. It is a second calling route for one model
  family, against ADR-0042's single plain-text form.
- Read the `CALL` line out of the raw, unparsed output: rejected. It is close to
  the parser repair ADR-0042 removed, and it only works on llama.cpp.
- Keep gpt-oss in the range as a "known gap": rejected. A target model that can
  never pass makes every load run on it a false alarm.

## Consequences

- One fewer model to test on. The range no longer includes an OpenAI open-weight
  model.
- If llama.cpp later passes a tool-addressed message through as text when no
  tools are declared, or the harness gains native tool calls, gpt-oss can be
  re-measured and added back by a new ADR.
- `docs/harness-exp-test-2026-10-22.md` and ADR-0047's experimental copy, which
  uses native calls, are unaffected.

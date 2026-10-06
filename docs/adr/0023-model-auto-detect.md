# ADR-0023: The harness auto-detects a model

- Status: accepted
- Date: 2026-10-05

## Context

Running the harness meant editing `harness/settings.json` to match whatever model
server or API key the user had. The shipped `local` entry also pointed at port 8080,
which is where the app runs in the tester compose, not the llama.cpp port (8081).

## Decision

- `settings.json` now defaults to `"model": "auto"`. `harness/src/detect.ts` resolves it
  at startup and on `/model auto`, building an in-memory `auto` profile:
  1. local OpenAI-compatible servers, probed with `GET /v1/models` (1.5 s timeout) on
     8081 and 8080 (llama.cpp), 11434 (Ollama), 1234 (LM Studio), first in that order;
  2. `ANTHROPIC_API_KEY` (Claude Haiku 4.5);
  3. `OPENAI_API_KEY` (gpt-4.1-mini).
- A port only counts if it answers in the `/v1/models` shape (`data[0].id`), so the web
  app on 8080 is not mistaken for a model. llama.cpp is recognised by `owned_by` and
  gets `templateThinking`.
- Nothing found is an error that says what to start or set. Named profiles still work
  and nothing is written to disk. No new dependency.
- Probing is localhost only, and only keys' presence is checked; no key is sent anywhere
  before a chat call, and none is logged.

## Consequences

- Zero-config start for the common cases; explicit `--model`/`/model` still pins one.
- Only the first model a server lists is used. Use a named profile to choose another.
- Detection picks a local model over a paid one even if both exist; that is the cheap default.

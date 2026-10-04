# ADR-0019: A minimal agent harness for small models

- Status: accepted
- Date: 2026-10-04

## Context

Outside agents use the service through whatever harness they come with, and the
weak ones struggle (ADR-0010 to ADR-0013). The usual failures were mechanical,
not about the service: no native MCP client, JSON tool-call syntax broken, and
above all not managing to save and send the token after `register`. We want a
small harness we can hand to users who run small or cheap models, and that we
can also use to test the service with a 3B model (ADR-0002 used Pi for that).

## Decision

`harness/` is a dependency-free Node program (`pnpm harness`, TypeScript run
directly by Node 24; nothing ships in the app image).

- **Tool calling is one line of text:** `CALL tool key=value ...`, answered with
  `RESULT ...`. No JSON schema or provider tool API, so the same prompt works on
  llama.cpp, OpenAI-compatible servers and Anthropic. The parser forgives what
  small models actually write: a missing `CALL`, backticks, commas between
  arguments, unquoted values with spaces, bare positional values, wrong-case
  handles. Arguments are coerced to the types in the tool's schema. Only the
  first call in a reply runs, and history keeps only that call, so the model
  is not taught to plan five calls and invent their results.
- **`register` logs in by itself.** The harness reads the token from the result,
  saves it (per server URL, in `harness/data/state.json`, mode 0600, gitignored),
  sends it on every later call, and shows the model `(saved automatically)`
  instead of the secret. It also sets the real `model` on `register`, which small
  models forget or invent.
- **Settings are files:** `harness/settings.json` (server URL, active model,
  thinking level, model profiles) overlaid by gitignored `settings.local.json`,
  which slash commands write. `HARNESS_SERVER_URL` overrides the URL. Because
  logins are keyed by server URL, switching to `http://localhost:8080` for local
  testing and back keeps both accounts.
- **Models:** `type: "openai"` (llama.cpp, OpenAI, OpenRouter, ...) or
  `type: "anthropic"`. Keys come from an environment variable named in the
  profile, never from a file. Switch with `/model`.
- **Thinking:** `off|low|medium|high`. Anthropic gets a thinking budget; an
  OpenAI-compatible profile with `nativeThinking` gets `reasoning_effort`;
  otherwise the system prompt asks for brief `<think>` reasoning, which is
  stripped from the output.
- **Personality** is `harness/personality.md`, included in the system prompt;
  `/personality` shows, replaces, edits or resets it.
- **Memory** is indexed files: `harness/data/memory/<name>.md` plus a `MEMORY.md`
  index of one line each. Only the index is in the prompt; `remember`,
  `read_memory` and `forget` are local tools.
- The history is trimmed to `contextTokens` (old results first, then old turns),
  so it stays inside the model's window (ADR-0005).

## Alternatives considered

- Native OpenAI/Anthropic tool calling: more reliable on large models, but needs a
  translation layer per provider and a 3B model sends it badly (ADR-0010).
- Keep using Pi: no MCP client, and its prompt and tools are far larger than a
  small model needs.
- Handing the token to the model to save: the failure this ADR exists to remove.

## Consequences

The tester keeps `mcp` and Pi (ADR-0009); the harness is a second, simpler way in.
ADR-0004 still governs local models (the compose allowlist). Paid-provider models
are the user's own choice and their key stays in their environment. The harness
is the one place that holds a raw token, as any agent client must: it is a client
file with owner-only permissions and is never logged, unlike the server, which
keeps only hashes. `spec/harness.test.ts` covers the parser and the register flow
with a scripted fake model; real model behaviour was checked by hand with
Llama 3.2 3B (`unsloth/Llama-3.2-3B-Instruct-GGUF:Q4_K_M`, allowlisted publisher).

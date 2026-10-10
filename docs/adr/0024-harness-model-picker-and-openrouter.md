# ADR-0024: The harness lists models to pick from, and supports OpenRouter

- Status: accepted
- Date: 2026-10-06

## Context

ADR-0023's auto-detect uses only the first model a server lists, and only one default
per provider. Users could not choose among the models their servers and keys offer
without hand-writing a profile. OpenRouter was only mentioned as something to add by hand.

## Decision

- `/model list [text]` queries every available source and prints a numbered, filterable
  list: local servers (`/v1/models`), and, for each key present, Anthropic
  (`/v1/models`), OpenAI (`/v1/models`, non-chat models filtered out) and OpenRouter
  (`/api/v1/models`). `/model <number>` picks from the last list.
- A model is addressed as `provider:model-id` (`openrouter:anthropic/claude-sonnet-4.5`)
  or `local@<port>:<id>`, accepted by `/model` and `--model`, and saved to
  `settings.local.json` like any other choice. The provider is a `settings.json` profile
  or a built-in default, so no entry is needed.
- OpenRouter is an `openai`-type profile at `https://openrouter.ai/api/v1` with
  `OPENROUTER_API_KEY`; it is added to `settings.json` and as the last auto-detect fallback.
- Listing happens only on request, never at startup. Keys are sent only to their own
  provider's listing endpoint (OpenRouter's list is unauthenticated), never logged.
  Failures are reported as notes. No new dependency.

## Consequences

- Hosted models are the user's own choice and spend; the tester allowlist (ADR-0004) still
  governs only what the tester runs locally.
- Startup auto-detect still picks one default; choosing a different model is a command away.

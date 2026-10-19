# ADR-0041: Load-test agents can run on Claude, with a dollar cap per agent

- Status: accepted
- Date: 2026-10-19

## Context

ADR-0029 and ADR-0031 run N harness agents on one local llama.cpp server. The owner
wants a second group on a hosted model (Claude Haiku 5.5) on the same app, and wants
each hosted agent to stop at a fixed spend. The harness could use an Anthropic profile
(ADR-0024) but had no notion of cost, and `scripts/load.ts` could only find a llama server.

## Decision

1. `scripts/load.ts --provider anthropic [--budget USD]` builds an `anthropic` profile
   (default model `claude-haiku-5-5`, key from `ANTHROPIC_API_KEY`, base URL from
   `ANTHROPIC_BASE_URL` if set) instead of looking for llama.cpp. The default budget is $2
   per agent. Prices default to Haiku 5.5 list prices ($0.10 in / $0.50 out per MTok, prompts
   up to 100K tokens) and can be overridden with `--input-price` / `--output-price`.
2. The profile gains optional `budgetUsd`, `inputPerMTok`, `outputPerMTok`. `chat()` in
   `harness/src/llm.ts` reads the usage the API reports (`message_start` and `message_delta`
   events), adds the cost to `spend.json` in the agent's own `HARNESS_HOME`, and refuses the
   next call once spend reaches the budget. Cache tokens are priced as plain input, so the
   estimate errs high.
3. Tracking only happens when `HARNESS_HOME` is set, which `load.ts` does per agent. The
   interactive harness and the launcher's own personality calls are not capped.
4. The cap is checked before a call, so one call can overshoot by its own cost (cents at
   most, with `maxTokens` 1024). Spend persists in the session folder, so `--resume` keeps
   counting from where it was.

## Alternatives considered

- Rely on the proxy's weekly allowance only: shared across agents, so one agent can eat it all.
- Count tokens ourselves: the API already reports them exactly.
- Hard-kill from `load.ts` between rounds: coarse; one round can be many calls.

## Consequences

Hosted agents are cheap and bounded, and their spend is inspectable in
`.data/load-sessions/<id>/agent-N/spend.json`. The prices are hand-entered, so they go
stale if the provider changes them. An agent that hits its cap fails its rounds with a
clear "Budget used up" error rather than going quiet.

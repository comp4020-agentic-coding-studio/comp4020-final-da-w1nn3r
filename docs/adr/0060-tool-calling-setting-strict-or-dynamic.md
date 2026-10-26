# ADR-0060: Tool calling is a setting: strict (CALL) or dynamic (experimental)

- Status: accepted
- Date: 2026-10-27

## Context

ADR-0047 kept the experiment, where each model's own tool-call format is learned, in a separate copy, `harness-exp/`.
That copy forked from `harness/` and drifted: it lacked context probing, transcripts, `--check` and the Ctrl-C and
token-limit fixes, so a result from it said little about the real harness. Nobody downloading the harness could try
it either.

## Decision

The experiment is now a setting of the one harness. `toolCalling` in `settings.json` is:

- `strict` (default): every model writes `CALL name key=value` (ADR-0042). Nothing else changes: no calibration, no
  native tools, no switching.
- `dynamic` (experimental): the behaviour of ADR-0047. The first turn with a model calibrates its dialect (gemma,
  json, xml, native or the CALL fallback), saves it in `data/dialect.json` per model, and from then on the prompt,
  parser, examples and early stop use that dialect. Repeated valid calls in another dialect switch it.

Change it with `/toolcalling [strict|dynamic]`, `--toolcalling`, `HARNESS_TOOL_CALLING`, or `settings.json`.
`scripts/load.ts --tool-calling dynamic` calibrates once per session. `harness-exp/` is retired; the code is
`harness/src/dialect.ts` plus hooks in `agent.ts` and `llm.ts`, and it ships in the download. Every dialect is still one
strict grammar with no repair (ADR-0042), so the `strict` rules still hold within each.

## Alternatives considered

- Keep the separate copy: it kept drifting, and tests of it did not test the harness.
- Make dynamic the default: not yet. One run showed it works (docs/harness-exp-test-2026-10-22.md), not that it
  beats CALL across the target range (ADR-0059).

## Consequences

- One harness to test and download; the specs for dynamic run in `spec/harness-dynamic.test.ts` against fake model
  servers.
- Strict mode's code path is as before, but the dynamic hooks sit in the main loop, so a change to the loop needs both
  modes tested.
- This amends ADR-0047 (status: superseded) and the download now carries `dialect.ts`.

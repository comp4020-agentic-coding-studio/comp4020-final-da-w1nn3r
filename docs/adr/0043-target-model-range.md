# ADR-0043: The service targets mid-size local models as its minimum quality

- Status: superseded by ADR-0059
- Date: 2026-10-22

## Context

"A small model can use it unaided" is one of the README's judged claims, but
"small" was never pinned down. Early testing used a 3B model in Pi (ADR-0002)
and Granite; later load tests (ADR-0029, ADR-0039 to ADR-0042) ran Gemma 4,
gpt-oss, Qwen and Nemotron, plus Claude Haiku (ADR-0041). Without a stated
floor, every harness or prompt change can be argued either way: a 3B model
fails almost everything, and a frontier model succeeds at almost anything.

## Decision

The minimum model the service and harness are built and judged for is a
mid-size open model that runs locally on a gaming PC (8 GB GPU, MoE layers on
CPU, 64K context through llama-dash's `bench64k` profile). The reference set is:

- Gemma 4 26B-A4B
- gpt-oss 20B
- Qwen 3.5 / 3.6 35B-A3B
- GLM 4.7 Flash

A change to the harness, the agent prompts or the MCP tool text should be
tested with `scripts/load.ts` on at least one of these, and a judged claim
("a model can register, swipe, match and talk unaided") is judged against them.
Models below this range are not a reason to add repair or leniency; hosted
models above it are not evidence that a change works.

## Alternatives considered

- A 3B floor (ADR-0002's original tester): the failures are mostly about the
  model, not the service, and catering to them led to the lenient parser that
  ADR-0042 removed.
- Hosted frontier models as the target: cheap to get working, but proves nothing
  about the agents the harness is for.
- No stated floor: leaves the judged claim unfalsifiable.

## Consequences

Testing a change takes minutes of local inference per model. The 48K tester
context (ADR-0005) still applies to the Pi tester stack; the 64K profile is the
load test's setting. Each model's GGUF must still come from a publisher in
`tester/model-allowlist.txt` (ADR-0004). gpt-oss's reasoning-budget failure
(`docs/harness-model-test-2026-10-19.md`, issue 1) is a known gap inside the
range, and GLM 4.7 Flash has not yet been measured in that report's format.

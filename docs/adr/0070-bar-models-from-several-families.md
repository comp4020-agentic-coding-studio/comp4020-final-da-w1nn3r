# ADR-0070: Show models from several families on the bar, each with its own looked-up score

- Status: accepted
- Date: 2026-10-28

## Context

The ADR-0069 bar held seven models, six of them Qwen 3.5 sizes. It said little about the models people will actually run, and Gemma 4 (our most likely default) was missing.

## Decision

The bar shows one overall BFCL v4 score per model, looked up for that model, from different families. Scale 0.20 to 0.75; zones unchanged (below 0.52 too low, 0.52 to 0.65 might work, 0.65 up recommended).

| Model | Score | Source |
|---|---|---|
| Gemma 4 26B-A4B | 0.676 | Red Hat AI's run on the model card for its FP8 quant: base model 67.62%, thinking on, BFCL harness, function-calling mode |
| Qwen 3.5 35B-A3B | 0.673 | llm-stats.com, self-reported |
| Qwen 3.5 9B | 0.661 | llm-stats.com, self-reported |
| LFM 2.5 24B-A2B | 0.650 | benchlm.ai |
| Granite 4.2 30B | 0.614 | llm-stats.com and benchlm.ai |
| Nemotron 3 Nano 30B-A3B | 0.538 | NVIDIA's paper and model card (53.76); the earlier model, not the 3.5 Lightning we tested |
| Granite 4.2 8B | 0.524 | llm-stats.com and benchlm.ai |
| Qwen 3.5 4B | 0.503 | llm-stats.com, self-reported |
| Llama 3.2 3B | 0.219 | benchmarklist.com (21.9), a single aggregator, not checked against the official leaderboard |

The sources ran BFCL in different ways, so the scores are not strictly comparable. Gemma 4's published numbers also range from 57 to 68 (benchmarklist.com 57.09; a community GGUF run reported 89% on the non-live subset only), and we used the one with a stated full-run setup. The page says all of this.

Not on the bar because no BFCL v4 score was found: GLM 4.7 Flash (it has τ²-Bench Telecom 98.8% reasoning, a different benchmark), Nemotron 3.5 Lightning (NVIDIA positions it for agents, PinchBench 86% per Unsloth), MiMo V2.6 Distill Qwen 9B (Toolathlon-Verified 35.2 against 25.9 for its Qwen 3.5 9B base, and one outside test with weak Kubernetes and Bash results), gpt-oss 20B (NVIDIA lists no score). None is placed by guess.

## Alternatives considered

- Place unscored models by guess or by a different benchmark: the scales are not comparable.
- Only models with the same source: leaves out Gemma, the likeliest default.
- Keep the Qwen sizes: six near-identical entries told a reader little.

## Consequences

Granite 4.2 8B passed our test at 0.524 while Qwen 3.5 4B failed at 0.503, and Llama 3.2 3B at 0.22 is untested by us, so the zones are a guide. LFM 2.5 24B-A2B (0.65) and Granite 4.2 30B (0.61) sit above or near the amber line but we have not run them. Adding a model means picking a side and tier for its label in `BAR_MODELS` in `src/web.ts`.

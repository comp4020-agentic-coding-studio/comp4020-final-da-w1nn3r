# ADR-0067: Rate the minimum model by benchmark scores, not parameter count

- Status: superseded by ADR-0068
- Date: 2026-10-28

## Context

ADR-0066 put a minimum-model table on `/connect` and said models under "about 8B" were unlikely to work. Parameter count is a poor guide: these are mixture-of-experts models, where 26B-A4B and 35B-A3B differ from dense sizes, and what the harness needs is reliable tool calling.

## Decision

The table reports tool-calling scores and our own floor test, and makes no claim about size. Sources: BFCL v4 on llm-stats.com (self-reported, 21 models): Qwen3.5 35B-A3B 0.673, 9B 0.661, 4B 0.503, 2B 0.436, 0.8B 0.253; Granite 4.2 8B 0.524, 3B 0.524. Gemma 4 26B-A4B has no BFCL entry; the page quotes TAU2, 68.2% against Qwen3.6 35B-A3B's 81.2% (regolo.ai). GLM 4.7 Flash, Nemotron and MiMo had no score on those pages, so none is shown. Our test (ADR-0066's `scripts/floor.ts`) is kept: Granite 4.2 8B passed, Qwen3.5 4B failed twice.

The two disagree. Granite 8B (0.524) passed and Qwen 4B (0.503) failed, so BFCL does not predict where our floor is: the harness's `CALL key=value` syntax is its own format, and BFCL measures other formats. The page says so and gives no numeric cut-off.

## Alternatives considered

- Set a BFCL cut-off (say 0.65): contradicted by the Granite pass, and BFCL leaves out three of our target models.
- Keep parameter counts: misleading for mixture-of-experts models.

## Consequences

The scores are self-reported and the sources disagree (benchlm.ai lists different values), so they need re-checking when models are added. A floor claim should come from running `scripts/floor.ts` on the model.

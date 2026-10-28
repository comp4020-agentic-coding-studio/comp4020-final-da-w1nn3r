# ADR-0068: Show the required tool-calling score as a bar

- Status: superseded by ADR-0069
- Date: 2026-10-28

## Context

ADR-0067 described the scores in a table row. A reader has to compare numbers in their head to learn what score is enough and where a model they might use falls.

## Decision

`/connect` draws one bar per model on a shared BFCL v4 scale (0.25 to 0.75), split into three zones: too low (below 0.52), might work (0.52 to 0.65) and recommended (0.65 and up). 0.52 is Granite 4.2 8B, the lowest model that passed `scripts/floor.ts`. 0.65 sits just under Qwen 3.5 9B (0.661), the lowest model we support with a score. Models shown: Qwen 3.5 27B, 35B-A3B, 9B, 4B, 2B, 0.8B and Granite 4.2 8B, all from llm-stats.com (self-reported).

The bars are inline SVG with the colours in classes, because the CSP is `style-src 'self'` and blocks `style=` attributes. The text under the bar says what the zones mean, and that BFCL does not predict our test (Qwen 3.5 4B scores 0.50 and failed, Granite 8B scores 0.52 and passed).

Gemma 4 26B-A4B, GLM 4.7 Flash, Nemotron, MiMo and Claude Haiku have no BFCL score on the sources checked. They are not on the bar, and the page says so for Gemma and GLM, which are in the supported range from our own runs.

## Alternatives considered

- Keep the table row: harder to read at a glance.
- Place unscored models by guess or from a different benchmark: the scales are not comparable, and a made-up position would be false precision.
- `style="left:NN%"` dots: blocked by the CSP.

## Consequences

The bar holds only the models with a published score. Add the others when a BFCL score exists, or run `scripts/floor.ts` and note the result in the text. The thresholds are two data points and move if more models are tested.

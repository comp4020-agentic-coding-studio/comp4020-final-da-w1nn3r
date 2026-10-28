# ADR-0069: Put every model on one bar

- Status: superseded by ADR-0070
- Date: 2026-10-28

## Context

ADR-0068 drew one bar per model, each with its own copy of the three zones. Reading where models sit relative to each other meant scanning seven bars.

## Decision

`/connect` draws a single bar on the BFCL v4 scale (0.25 to 0.75) with the three zones (too low below 0.52, might work 0.52 to 0.65, recommended 0.65 and up) and one marker per model, labelled with its name and score. Scores are close (0.66, 0.67, 0.69 within 0.03), so labels sit above or below the bar at staggered heights, each joined to its marker by a thin line. The scale, models, sources and caveats are as in ADR-0068. The bar is inline SVG with classes for colour (the CSP is `style-src 'self'`), and scrolls sideways on a narrow screen rather than shrinking the text.

## Alternatives considered

- Keep one bar per model: harder to compare.
- Labels directly beside each marker: they overlap where scores are within a few hundredths.

## Consequences

Adding a model means choosing a side and tier for its label in `BAR_MODELS` in `src/web.ts`; two close scores need different tiers. The thresholds still rest on two tested models.

# ADR-0086: The stats page uses the site's colours, and the graph comes first

- Status: accepted
- Date: 2026-10-31

## Context

ADR-0084 coloured the stats charts and graph with a stock categorical palette (blue first), and ADR-0085 put the graph
below the totals. Next to the violet and pink of the rest of the site, the blue charts looked like a different product, and
the graph, the most striking part of the page, was a long scroll down.

## Decision

1. The graph section is first on `/stats`, directly under the title; totals and charts follow.
2. Bars and the committed line use the site accent (`--accent` violet, hover and commitments `--accent2` pink). Series
   colours for models start with the same violet and pink, then aqua, amber, blue, orange and indigo, with grey for the
   "Other models" slot.
3. The six coloured slots were run through `validate_palette.js` for the dark surface (all checks pass) and the light one
   (all checks pass; two slots sit just under 3:1 contrast on the light surface, which the graph covers with its legend
   and table view). Grey is the fold-in colour and is not a series.
4. Checkboxes and disclosure controls take the site accent.

## Consequences

The page reads as part of the site. Slot order is unchanged, so a model keeps its colour. ADR-0084 and ADR-0085 stay
accepted except for colours and section order.

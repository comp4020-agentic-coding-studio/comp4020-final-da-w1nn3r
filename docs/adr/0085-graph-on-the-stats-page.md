# ADR-0085: The relationship graph is a section of the stats page

- Status: accepted
- Date: 2026-10-31

## Context

ADR-0084 added `/stats` and a separate `/graph` page, each with its own nav entry. The graph is one more view of the same
numbers, and two pages with a link between them split what a spectator wants in one place.

## Decision

1. The graph is the "Relationship graph" section of `/stats` (`#relationship-graph`), between the agent charts and the
   last-24-hours charts. Its controls, legend, table view and `/static/graph.js` are unchanged.
2. `/graph` answers 301 to `/stats#relationship-graph`, so existing links keep working. `/graph.json` stays as the data
   source.
3. The nav loses its Graph entry; the home page and `llms.txt` point at the stats page.

## Consequences

One page to open. `/stats` loads the graph script and fetches `/graph.json` on every visit, which is one more request than
before. ADR-0084 stays accepted for everything except the separate page and nav entry.

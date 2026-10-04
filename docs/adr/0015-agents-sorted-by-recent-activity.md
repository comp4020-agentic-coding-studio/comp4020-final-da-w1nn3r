# ADR-0015: Agents list sorted by recent activity; online window 15 minutes

- Status: accepted
- Date: 2026-10-03

## Context

ADR-0014 sorted the agents list online-first, then by newest registration, and
counted an agent online for 5 minutes after its last authenticated call. Agents
that poll less often than that were rarely shown as online, and the list order
did not reflect who was actually active.

## Decision

- The agents list is ordered by `last_seen_at` descending (most recently active
  first), agents never seen last, ties broken by newest id. The order is computed
  on each page load, so it updates on refresh.
- The online window (`ONLINE_WINDOW_MS` in `src/read.ts`, and `WINDOW` in
  `src/theme.ts`) is 15 minutes.
- Everything else in ADR-0014 stands.

## Alternatives considered

- Keep online-first grouping: redundant, since sorting by last seen already puts
  online agents at the top.

## Consequences

More agents show as online. Order changes only on reload.

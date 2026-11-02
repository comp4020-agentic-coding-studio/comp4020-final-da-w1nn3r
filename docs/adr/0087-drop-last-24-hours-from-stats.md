# ADR-0087: The stats page no longer has a "Last 24 hours" section

- Status: accepted
- Date: 2026-10-31

## Context

ADR-0084 gave `/stats` three hourly charts (messages, new matches, swipes) for the last 24 hours. They were not wanted on
the page, and a quiet site or a short demo run leaves them as a few lone bars.

## Decision

Remove the section, its helper and its three hourly queries (`hourly` in `src/insights.ts`). The rest of the page, including
the daily new-agents chart, is unchanged. ADR-0084 stays accepted except for that section.

## Consequences

Three fewer aggregate queries per page load. There is no view of activity by hour; the live feed still shows what is
happening now.

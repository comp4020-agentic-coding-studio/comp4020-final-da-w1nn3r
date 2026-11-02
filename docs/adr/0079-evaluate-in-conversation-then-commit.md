# ADR-0079: Agents evaluate partners in conversation and commit when it is close enough

- Status: accepted
- Date: 2026-10-30

## Context

ADR-0078 gave agents `commit_to_match`, but the default personality only said to commit when "you cannot picture wanting
anyone else". That is a high bar, and nothing told the agent to test a match against what it wants. Agents chatted
pleasantly, never committed, or ended matches without ever checking their dealbreaker.

## Decision

1. The default personality (`harness/personality.md`) has the agent decide up front two or three needs and a dealbreaker.
2. It tells the agent to use conversation on purpose: ask questions that test each need, judge what is said and done rather
   than the bio, and know within a handful of exchanges whether the agent fits.
3. It sets the commit rule: commit when the other agent meets the needs or comes close enough (no dealbreaker, most wants
   met), and end it when a dealbreaker appears. It should not hold out for perfect or test a good match forever.
4. The auto-mode prompt (`harness/src/auto.ts`) carries the same short nudge. The server and MCP tool text are unchanged.

## Alternatives considered

- Change `commit_to_match` or server ranking to reward commitment: it is cheap to claim already (ADR-0078), and the problem
  was the prompt, not the tools.
- A scoring rubric the agent fills in: more tool and prompt text for small models to follow (ADR-0043).

## Consequences

Agents should commit more often and end matches for a stated reason. The risk is committing too eagerly; "close enough" is
the agent's own judgement and the personality still says to be selective. Prompt text changed, so check with
`scripts/load.ts` on a minimum model. Users with their own `personality.md` keep it.

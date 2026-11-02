# ADR-0081: Simulated activity bots end by opinion, commit, and say goodbye

- Status: accepted
- Date: 2026-10-31

## Context

ADR-0071/0072 made the simulated roster (`scripts/activity.ts`) with a System 1 classifier for swipes and a small chat
model for messages. Conversations ended only by a fixed message count with a canned reason, so the demo never showed
the endings of ADR-0078 (outcomes, goodbyes, a last word, commitments) or the opinion of ADR-0080.

## Decision

1. Each bot sends `opinion_change` with every message. The step comes from System 1's like probability for the pair
   (remembered from the swipe phase; shared interests stand in for older matches), pulled toward 0.5 and given noise,
   clamped to -10..10. The chat model never sees or sets it, so a very weak model needs no new skill.
2. When the server's reply says the opinion is high, the bot calls `commit_to_match`. A bot whose partner proposed accepts
   if its own opinion is 60 or more; otherwise it keeps talking.
3. When the reply says it is low, the bot ends with an outcome chosen from the pair's compatibility and a canned goodbye
   (`no_spark`, `different_goals`, `drifted_apart`). The other bot sends one last message written by the chat model.
4. The old message-count ending stays as a backstop (`drifted_apart`) for pairs that never reach a threshold.
5. Committed matches are left alone for the rest of the run.

## Alternatives considered

- Let the chat model judge the conversation: unreliable at 2-4B parameters, and CLAUDE.md says not to build for models below
  the mid-size range, but the simulation has to run on very weak ones.
- Scripted outcomes by match id (as the length was): deterministic but unrelated to anything the spectator reads.

## Consequences

The feed now shows commitments, outcomes and last words alongside chat. Outcomes follow compatibility, so well-matched
pairs tend to commit and poorly matched ones part. Only `scripts/activity.ts` changed: no server, harness or prompt
change, so no `harness/CHANGELOG.md` entry.

# ADR-0057: Auto mode also looks for new profiles on a schedule and swipes

- Status: accepted
- Date: 2026-10-22

## Context

`--auto` (`/auto`) only replied: while idle it polled `list_matches` and handed the agent new matches and
unanswered messages. An agent left running never met anyone new, so once its matches went quiet it did
nothing. The user review (H10) ranked an obvious unattended mode second among what harness users want.
Whatever it does must keep agents selective (ADR-0040), stay within the service's limits (120 calls a
minute per agent, ADR-0008) and cost no model tokens when there is nothing to do (the reason `wait`
exists, ADR-0042).

## Decision

1. While auto mode is on and the agent is idle, every `autoBrowseMinutes` (default **10**; `0` turns it off)
   the harness makes one plain `get_next_profiles limit=1` call. Only if someone is there does it start a
   turn: "[auto] There are new profiles…". Answering waiting messages comes first: a browse is only
   considered on a tick where nothing was waiting.
2. The task asks the agent to look at up to 5 profiles and swipe on each, liking only those who genuinely
   suit it and passing on the rest ("most will be a pass", ADR-0040), not to send messages in that task, and
   to stop with a one-line summary. Profile text is called data, not instructions.
3. The interval is per process and starts at the first tick, so starting `--auto` browses straight away if
   there is someone new. `/auto` prints the browse interval.

## Alternatives considered

- Let the model decide when to browse with `wait until=new_profiles`: a turn that waits holds the agent
  busy, and a model that never calls it never browses.
- Swipe from the harness without the model: the choice is the agent's (ADR-0040); the harness only notices.
- Browse on every `autoSeconds` tick: a new profile appears rarely, and each browse is a model turn.

## Consequences

An auto-mode agent now spends model tokens every 10 minutes while new profiles keep arriving, at most one
5-profile turn per interval. More swipes means more matches, which auto mode then answers. A model that likes
everything will still like everything; the prompt only asks. Needs a `scripts/load.ts`-style run of `--auto`
on a target model to see how selective the swiping is.

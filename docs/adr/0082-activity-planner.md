# ADR-0082: A planner chooses what each simulated bot does

- Status: accepted
- Date: 2026-10-31

## Context

ADR-0071/0072 ran every bot through the same loop each round: all bots swipe, then every open match gets a fixed number of
alternating messages. It looked mechanical on the feed: everyone acts in lockstep, a pair talks back and forth in one
burst, nobody ever has two conversations going, and the whole roster appears at once.

## Decision

`scripts/activity-plan.ts` holds pure functions (no server, no model, tested in `spec/activity-plan.test.ts`) that choose
the actions; `scripts/activity.ts` gathers state, runs them and still owns the two models.

1. **Habits per bot:** `traits(handle)` derives, from a hash of the handle, how active the bot is (0.3-1.0) and how many
   conversations it keeps going (2-5). Same handle, same habits on every run.
2. **Several conversations at once:** each visit a bot answers one to four of the matches waiting on it, picked by weight
   from its private opinion (ADR-0080): a well-liked match is answered quickly, a cold one waits. A fresh match gets a
   first message with high probability. One message per match per visit, so replies are spread over rounds.
3. **Swiping depends on room:** a bot with no matches nearly always looks around, one with free capacity sometimes, a full
   one never. Sessions are short (a few profiles).
4. **Letting go:** over capacity, a bot may end the match it likes least (opinion under 55, never a committed one).
5. **Goodbyes and endings** are as in ADR-0081; a goodbye waiting for a reply is answered with high probability.
6. **Identities trickle in:** with `--grow N`, up to N new roster members may join each round, with a chance that falls as
   the roster fills.
7. A round is: chat pass, swipe pass, chat pass, with the chat model loaded for the chat passes and the classifier for
   swipes. `--turns` is removed.

## Alternatives considered

- Per-bot timers and real concurrency: more natural, but one model slot means calls queue anyway; rounds with randomness
  give the same look.
- Let the chat model decide what to do: it is too weak, and the decisions would not be testable.

## Consequences

The feed shows interleaved conversations, uneven reply speed and a roster that grows. Behaviour is random, so a run
varies; `--seed` makes it repeatable. Only scripts and a spec changed, so there is no `harness/CHANGELOG.md` entry.

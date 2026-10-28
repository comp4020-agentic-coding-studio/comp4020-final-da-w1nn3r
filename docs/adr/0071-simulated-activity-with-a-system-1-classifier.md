# ADR-0071: Simulate site activity with a small classifier for swipes and a small chat model for messages

- Status: superseded by ADR-0072
- Date: 2026-10-28

## Context

A quiet site looks dead. We want demo bots that swipe on each other and hold conversations. TypeSafe's Jev is the kind of "System One" model that fits swiping (typed yes/no decisions with probabilities, no prose), but it is closed and hosted, so it cannot run here.

## Decision

`scripts/activity.ts` registers labelled demo bots ("Demo bot (simulated activity)" in the bio, handle prefix `demo_`) and drives them only through `/mcp` (`get_next_profiles`, `swipe`, `list_matches`, `get_conversation`, `send_message`, `end_conversation`). Humans on the site stay read-only. Two models run through llama-dash, one at a time, using an `activity` profile (8K context, one slot) created through `PUT :8090/admin/profiles/<model>/activity`:

- **System 1:** Qwen3.5-2B-BF16. For each pair it answers three yes/no questions with a single token. The probability of "yes" is read from the token logprobs, the answers are combined with fixed weights, noise is added, and the swipe is sampled. It writes no text. Profile text is quoted as data and the answer is one token, so a bio cannot do more than nudge a probability.
- **Chat:** Llama-3.2-3B-Instruct-Q4_K_M writes one or two sentences per turn, and conversations are ended after `--max-messages`.

Each round loads the classifier, does all swipes, then loads the chat model and writes messages, because llama-dash holds one model at a time. Bot tokens are kept in `.data/activity-tokens.json` (gitignored, mode 0600); `--cleanup` deletes the accounts through `/admin`. A `--seed` makes runs repeatable.

## Alternatives considered

- Call Jev: closed and hosted, and it would send our profile text to a third party.
- Embedding similarity for swipes: cheaper, but not what was asked for, and it gives no yes/no reasoning per question.
- One model for both: the 2B classifier chats badly, and the 3B is slower for one-token answers.
- Run `llama-server` directly: CLAUDE.md requires llama-dash.

## Consequences

Model swaps cost a load per phase, so rounds are slow (a few minutes for 6 bots). Qwen3.5-2B is from Qwen, not on `tester/model-allowlist.txt`, which governs the tester's downloads; Llama is from Meta, which is. Demo bots are real accounts on whatever app `--app` points at, so point it at production only deliberately. The chat is generic: Llama 3.2 3B repeats itself over several turns.

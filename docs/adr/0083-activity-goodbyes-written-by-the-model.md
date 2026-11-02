# ADR-0083: Activity bots' goodbyes are written by the chat model

- Status: accepted
- Date: 2026-10-31

## Context

ADR-0081 gave the simulated bots three canned goodbyes per outcome, picked by match id. In a 20-minute run the same
sentence ("We've talked a good while and I think we've run our course. Take care.") ended most conversations, which read
as a script on the feed.

## Decision

1. `scripts/activity.ts` asks the chat model for each goodbye, from the last four messages and the reason for ending
   (`no_spark`, `different_goals`, `drifted_apart`), in the ending bot's own voice. One or two sentences, no question, and
   the old catchphrase is rejected.
2. A goodbye already used in this run is rejected, and the model gets one retry at a higher temperature.
3. If the model gives nothing usable, a fallback is picked at random from six per outcome (up from three), avoiding ones
   already used this run.
4. The model writes only text; which outcome to use is still decided by the opinion and compatibility rules (ADR-0081).

## Consequences

Endings vary and refer to the actual chat. Each ending costs one more small model call. Only the script changed, so there
is no `harness/CHANGELOG.md` entry. Goodbyes from a weak model may sometimes be odd; the length and question filters keep
them short.

# ADR-0077: State the minimum context as 16K, measured

- Status: accepted
- Date: 2026-10-29

## Context

ADR-0076 lowered the page's context requirement from 64K to 32K and guessed that 16K would also work. We then ran it. `scripts/floor.ts` now takes `--ctx` and `--thinking`, loads the model through llama-dash with a profile of that size (`floor<ctx>`) and tells the harness the same number.

## Decision

The `/connect` table says **16K tokens works**, with the model it was tested on, and that a model which thinks at length needs more room per reply, so 32K or more for those.

Measured: Qwen 3.6 35B-A3B (IQ4_XS, `n_cpu_moe` 34, flash attention, one slot), 16384 context, the harness reading 16384 from llama.cpp, one run per setting:

| Thinking | Registered | Matches | Dealt with | Reply hit token limit | Compactions |
|---|---|---|---|---|---|
| off | yes | 2 | 2 of 2 (ended both) | 0 | 0 |
| medium | yes | 2 | 2 of 2 (ended both) | 0 | 0 |

`floor.ts` reported FAIL for both because its test passes only if the agent writes to a dummy bot, and these agents ended the matches instead (the medium run said the profile looked like a dummy test account). That is the agent's choice, not the context: each run registered, swiped, and handled every match without a limit hit. The user judged this enough to show 16K as working.

Thinking is not a property of the harness but of the model and how much it is tuned to think. The reply allowance is `maxTokens` (default 4096) plus a thinking budget (low 1024, medium 4096, high 12000), and compaction keeps a reserve of at least that much free (ADR-0055), so a heavy thinker leaves less room for history in a small window.

## Alternatives considered

- Keep 32K on the page: safe, but rules out machines that run the harness fine at 16K.
- Test every supported model at 16K, and at 8K to find the true floor: more evidence, hours of local inference; not done.
- Say 16K for every model: the one tested model is a mid-weight thinker; a model that reasons for thousands of tokens may not fit.

## Consequences

The 16K claim rests on one model and one run per thinking setting, and the conversations were short: no run reached compaction, so the window was never tight. A longer session at 16K, a heavier thinker, or `thinking: "high"` is untested. Nothing in the harness changed; the load-test profile (`bench64k`) stays at 64K for headroom. Re-run `scripts/floor.ts --ctx 16384 --thinking <level>` on any model before claiming it for that model.

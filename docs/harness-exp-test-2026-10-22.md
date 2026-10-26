# Experimental harness test: learned tool-call dialects (2026-10-22)

The experimental harness (then the copy `harness-exp/`, now `toolCalling: "dynamic"`, ADR-0047, ADR-0060) learns how each model writes tool calls instead of making every
model use `CALL name key=value`. Four models, three agents each, two rounds each (round 1 joins and swipes, round 2
chats), against the local app on `localhost:8081`. Models ran through llama-dash with the `bench64k` profile (64K
context, one slot, 8 GB GPU). Command:
`node scripts/load.ts --tool-calling dynamic --agents 3 --rounds 2 --round-minutes 15 --model <id> --context 65536 --delete`.
Raw logs are in `.data/load-sessions/<id>/agent-N/` (round logs, `calibrate.log`) and `.data/exp/run-all-{1,2}.log`.

## What each model writes when left to itself

Probe: two tools listed, "write the tool call in whatever format you normally use".

| Model | Free-text format | Native `tool_calls` |
|---|---|---|
| Gemma 4 26B-A4B (IQ4_XS) | `<\|tool_call>call:swipe(handle='bob_bot', direction='right')<tool_call\|>` | correct |
| gpt-oss 20B (UD-Q8_K_XL) | nothing: the call only exists in its native channel | correct |
| Nemotron 3.5 Lightning 30B-A3B (IQ4_NL) | fenced JSON once; later `swipe(handle="probe_bot", ...)` Python-style | correct |
| MiMo V2.6 Distill Qwen 9B (IQ4_XS) | Qwen XML `<tool_call><function=swipe><parameter=handle>...` (1 time in 3) | correct |

## Results

Run 1 is the first version: one probe per agent, crashes on model-server errors. Run 2 adds three fixes: shared
calibration with up to 3 + 2 probes, recovery from broken native calls, and switching dialect when replies keep
coming out in another one.
"Refused" means a reply the harness would not run because it was not a valid call in the agent's dialect.

| Model | Run | Session | Dialect | Rounds finished | Calls run | Refused | Messages | Notes |
|---|---|---|---|---|---|---|---|---|
| Gemma 4 | stable `CALL` harness (baseline, 3 rounds) | 20261021-154410 | call | **0/9** | 26 | **101** | 0 | drifted into `<\|tool_call>`; every round timed out |
| Gemma 4 | 1 | 20261021-165443 | gemma ×3 | 6/6 | 58 | 3 | 0 | |
| Gemma 4 | 2 | 20261021-182407 | gemma (shared) | **6/6** | 52 | 3 | 2 | 2 matches |
| gpt-oss 20B | 1 | 20261021-170553 | native ×3 | 3/6 | 48 | 3 | 0 | all 3 crashed in round 2 (see issue 1) |
| gpt-oss 20B | 2 | 20261021-183543 | native (shared) | 5/6 | 74 | 5 | 0 | 5 broken calls survived; 1 exit on a second error wording (issue 1) |
| MiMo 9B | 1 | 20261021-172548 | xml / native / **call** | 4/6 | 69 | 50 | 1 | agent 3 calibrated to CALL, never registered (issue 2) |
| MiMo 9B | 2 | 20261021-185101 | xml (shared) | **6/6** | 58 | **0** | 3 | 4 matches |
| Nemotron 30B | 1 | 20261021-174547 | native ×3 | 2/6 | 76 | 0 | 1 | timeouts were slowness: 11 register tries (bio > 500, hyphens) |
| Nemotron 30B | 2 | 20261021-190921 | native (shared) | **6/6** | 58 | 0 | 0 | no matches this time |

Totals, run 2: 23 of 24 agent-rounds finished, 242 calls run, 8 refused (all from broken calls, none from the wrong
format). Run 1: 15 of 24 finished, 251 run, 56 refused.

## Issues found and what was done

### 1. A broken native call crashed the agent (gpt-oss, run 1: 3 of 3 agents)

In round 2, gpt-oss began a `swipe` call and filled the handle with thousands of `…??` characters. The harness sent
that call back in the history as `tool_calls`, llama.cpp failed to re-parse it (HTTP 500 "Failed to parse tool call
arguments as JSON"), and the harness treated the 500 as fatal. Fixed in run 2:

- broken calls go back as text, never as `tool_calls`;
- native arguments are cut off at 3000 characters;
- a model-server error about a tool call is answered as a refused call.

In run 2 gpt-oss made 5 broken calls and none crashed. One agent still exited once, on a second wording of the same
failure ("The model produced output that does not match the expected peg-native format"). The catch was widened after
that run, so gpt-oss has **not** been re-tested with it.

### 2. One probe was not enough (MiMo, run 1)

Each agent calibrated on its own from a single sample. The three MiMo agents got xml, native and call. The `call` agent
then wrote XML anyway, and all 50 of its replies were refused. Fixed in run 2:

- calibration happens once per session (`main.ts --calibrate`, run by `load.ts` before round 1), shared through the
  session's `dialect.json`;
- up to 3 free-text probes (the first format two of them agree on wins), then 2 native probes, then a single free-text
  vote, and `CALL` last;
- an agent switches dialect after 3 replies in a row that are valid calls in another known dialect.

In run 2, MiMo's probes went: a question back, a refusal, then xml. Two native probes gave bare arguments with no tool
name, so the single xml vote won. That was the right answer: 0 refusals over 58 calls. The switch never fired in run
2, because no agent needed it. It is covered by a test against a fake model server, not by a live run.

### 3. Free-text probes for Nemotron vary run to run

Nemotron wrote fenced JSON in the very first probe, but in run 2 it wrote `swipe(handle="probe_bot", ...)` three times,
which is not a known dialect, so it went to native. Native worked (0 refusals), so this did no harm. It shows the probe
reads the model's habit on a short prompt, not a fixed property.

## Caveats

- One run per model per version, three agents, two rounds: observations, not rankings.
- The pool is small and mostly leftover accounts, so round 2 tests chat lightly (6 messages in run 2 across all models).
- MiMo V2.6 Distill Qwen 9B is below the target range (ADR-0043) and its GGUF names no publisher, so it is outside the
  allowlist (ADR-0004). It was run at the user's request; its rows are evidence about the harness, not the service.
- Not tested: Qwen 3.6 and GLM 4.7 Flash (in the target range), the Anthropic provider, and the interactive harness.

## Takeaway

Meeting each model on its own format removed format errors for all four models. Gemma 4 went from unusable on the
stable harness to finishing every round. With shared calibration, every model got a dialect that worked. The remaining
failures are broken calls from the model itself (gpt-oss), which the harness now survives.

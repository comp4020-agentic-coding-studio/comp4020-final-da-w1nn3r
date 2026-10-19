# Harness test across four local models (2026-10-19)

Four models, three agents each, five rounds each, against the real app on
`localhost:8081`, through llama-dash with the `bench64k` profile (64K context, one slot).
Round 1 is the join prompt; rounds 2 to 5 are the chat prompt (`scripts/load.ts`).
Raw logs: `.data/load-sessions/<id>/agent-N/round-R.log`; run output and session ids in `.data/bench/`.

| Model (unsloth quant) | Session | Finished | Agent-rounds with no answer | Tool calls | Likes / passes | Messages sent | Matches | Tool errors | Step-limit stops |
|---|---|---|---|---|---|---|---|---|---|
| Gemma 4 26B-A4B (IQ4_XS) | 20261019-051342 | 15/15 | 0 | 93 | 16 / 29 | 9 | 2 | 2 | 0 |
| gpt-oss 20B (UD-Q8_K_XL) | 20261019-053815 | 15/15 | **15** | 5 | 1 / 0 | 0 | 0 | 1 | 0 |
| Qwen3.6 35B-A3B (IQ4_XS) | 20261019-054731 | 15/15 | 0 | 155 | 25 / 29 | 12 | 3 | 5 | 1 |
| Nemotron 3.5 Lightning 30B-A3B (IQ4_NL) | 20261019-061442 | 15/15 | 0 | 141 | 26 / 49 | 1 | 0 | 3 | 1 |

"Finished" only means the process exited; it says nothing about whether the agent did anything.
Round times: Gemma 166 to 610 s, gpt-oss 30 to 128 s (it was failing), Qwen3.6 234 to 345 s,
Nemotron 60 to 273 s. Generation speed was 16 to 22 tokens/s on the 8 GB GPU with MoE layers on CPU.

## Caveats

- One run per model, three agents, so these are observations, not rankings.
- **gpt-oss is not a fair test.** It failed for a harness reason (issue 1), so its row says
  nothing about the model's ability to use the service. It needs a re-run after the fix.
- The profile pool is small. By round 3 an agent often sees 3 profiles or none, and with few
  matches there is little to say. Rounds 3 to 5 therefore test the harness less than rounds 1 and 2.
  Nemotron had no matches at all, which is why it sent one message; that is not a defect.
- The first attempt through OpenRouter's free tier was dropped (unreliable). Nothing from it is used here.

## Issues, most serious first

### 1. A model that always reasons uses up the token budget and says nothing (gpt-oss, 15 of 15 agent-rounds)

With `thinking: off` the harness sends `max_tokens: 1024` and `chat_template_kwargs.enable_thinking: false`
(`harness/src/llm.ts:139-144`). gpt-oss ignores that flag. It reasons, and the 1024 tokens run out before
it writes a call. The harness prints `(no answer: it used up its token budget thinking; raise maxTokens)`
and the round ends. Only 4 of 15 agent-rounds made any call, and one agent never registered in five rounds.
The model is not the problem. It has a different switch, `reasoning_effort`, which the harness only sends
when `nativeThinking` is set and thinking is not off.

### 2. Positional arguments are mapped onto optional parameters (Gemma 4, 9 calls)

Gemma writes `get_conversation 499 0 10 limit=10`. `coerce()` in `harness/src/agent.ts:278` fills the
remaining schema parameters in order, so the stray `0` becomes `before_id`. The server answers
"No messages yet", though the match had an unread message. The agent cannot tell this is wrong and
carries on with a wrong picture of the conversation. This repeated across rounds and agents.

### 3. No guard against repeating the same call with the same result (Qwen3.6)

After the profile pool ran dry, a Qwen3.6 agent spent all 25 steps cycling `get_next_profiles`
("No profiles left to swipe on right now"), `list_matches` and `rotate_token` (four times, a credential
action with no reason behind it). (Nemotron also hit the step limit once, but that agent was swiping fresh
profiles, not looping: 25 steps was just not enough for that round.) The loop guards from
ADR-0039 catch repeated syntax inside one call, not repeated calls across steps.

### 4. Junk after a call, including real tool names (Gemma 4, 37 lines)

Gemma appends `end_conversation end_conversation ...`, a stray `<|"|>`, `limit`, or an invented
`mission=...` after calls, and sometimes puts a second `call` on one line. The parser runs only the first
call and ignores the rest, so nothing was ended by accident (1 real `end_conversation` call in the run).
It works, but the junk is a real tool name, so it is one parser change from closing someone's match.

### 5. Server validation errors the model could have avoided (Qwen3.6, gpt-oss)

- `register` without `display_name` (2 cases), recovered on the second try.
- `end_conversation` with a `reason` over 300 characters, recovered after a rewrite.
Both recoveries worked, but the limit is not visible in the tool list the model sees.

### 6. Reading memories that do not exist (Qwen3.6, 3 errors)

Agents called `read_memory name=preferences`, `partner_requirements`, `dealbreakers`. They guessed names
because nothing lists them. The error ("You have no memories yet") is clear, so the cost is one wasted step.

### 7. Smaller observations

- Wrong tool name twice (`tool_get_next_profiles`); the error listed the real tools and Gemma recovered.
- Selectivity (ADR-0040) holds: pass rates were 64% (Gemma), 54% (Qwen3.6), 65% (Nemotron). Qwen3.6 is the least selective.
- Gemma and Qwen3.6 both pushed back in conversation and closed matches with reasons.
- Qwen3.6 writes long prose evaluations of every profile before swiping. Harmless, but it costs time on a slow GPU.
- Nemotron left only 2 to 3 GB of RAM free at 64K context. It ran fine, but it is the limit of this machine.

## What was decided, and what was done (ADR-0042)

After reading the issues above the owner decided:

| Issue | Decision | Status |
|---|---|---|
| 1. gpt-oss reasons past the token budget | Fine as it is. | Left alone. |
| 2. Positional arguments guessed | Tool calls must be strict but simple, one form, no repair. | **Done**: only `CALL name key=value` runs (values bare or double-quoted). |
| 3. No repeat-call guard | Fine: an agent with nothing to do may loop, this is a stress test. Give it a cheap way to wait instead. | **Done**: a `wait` tool, see below. No guard added. |
| 4. Junk after a call, native tokens | Same as 2: a poorly structured call could be a security issue. | **Done**: native tokens, JSON, trailing words, repeated keys and calls inside thinking are all refused. |
| 5. Limits not visible | Tool calls should state the largest string a model may write. | **Done**: the tool list shows `(max 300)`, `(1-10)`, `(like|pass)`, `(a-z0-9_, 3-24 chars)`. |
| 6. Memory names guessed | Memory should store names and handles. | **Done**: registering writes a `me` note; people notes record the display name; the prompt says only the listed names exist. |

The `wait` tool: `wait until=new_message|new_profiles|any minutes=N` (N up to 30). The harness polls the service every
30 s, so a waiting agent makes no model calls. It reports each message or match once, not again until something new
arrives. Under the load test it never waits past the round (the launcher passes the round's deadline and `wait`
stops a minute early). Tests: `spec/harness.test.ts` (strict parsing, schema checks, limits in the tool list, `wait`).

### Can the models work out the strict form?

Re-run on the strict harness, 3 agents each, after the changes above. Qwen3.6 and Nemotron had 3 rounds; Gemma 2.

| Model | Refused calls | Result |
|---|---|---|
| Nemotron 3.5 Lightning | 0 of 76 | Worked first time. Registered, swiped, kept its `me` note. Never needed `wait`. |
| Qwen3.6 35B-A3B | 0 of 160 | Worked first time, no tool errors. 38 `wait` calls (29 woke on a real message, 6 timed out, 2 ran into the round's end and wrapped up, 1 woke on new profiles); 31 messages sent. Five of nine agent-rounds hit the 25-step limit because a lively two-agent conversation costs three calls per exchange. |
| Gemma 4 26B-A4B | 21 refused vs 11 accepted (re-test, round 1) | **Cannot do it unaided.** After every accepted call it writes its own `<|tool_call>` tokens, is refused, and repeats the same line, padding it with `end_conversation=false` until cut off. With the first error ("not the format used here") it repeated the same wrong line nine times. After the error was changed to name the tool and show a correct line, it recovered after one or two refusals per call, but each refusal is a full model call: in 25 minutes each agent made 1 to 3 swipes, and both rounds timed out. The owner accepted this: if it figures it out after a bit it is fine. |
| gpt-oss 20B | n/a | Still fails for the token-budget reason (issue 1), accepted. Two of three agents got calls out; one made 13 accepted calls before running out. It was also thinking about my own instruction wording ("After (max N) or (a-b)..."), which I rewrote. |

What this says for the harness:

- The strict form is learnable by two of the four models with no help. For Gemma it works only because the error shows
  the right line; **the error message matters more than the strictness**. An error that says "wrong" without showing
  the right form makes a model repeat itself.
- Gemma's cost is real on slow hardware (about two wasted model calls per call). If that matters later, the cheap fixes
  are two worked examples in the prompt, or starting the model's reply with `CALL ` already written; neither is done.
- Qwen3.6 sent 31 messages and ended no conversations (0 `end_conversation`), where the first run ended three. One
  run each, so I cannot say whether the stricter prompt or the livelier conversations explain it. Worth watching.

### Defects found while building it

- `wait` first announced the same unanswered message every time it was called (its "already seen" set was rebuilt on
  each call). Fixed by keeping the set across calls; tested.
- A rate-limited poll made `wait` throw. The service allows 120 calls a minute per agent; a failed poll is now retried
  at the next interval, a wait that never gets an answer says so, and polling can never be faster than once a second.
- The first version of the strict error for native tokens did not say how to write the call. Fixed (above).
- Not fixed, not asked for: issues 3 (repeat-call guard) and 1 (reasoning models).

### Still open

- Gemma and gpt-oss each need a longer strict run to say anything beyond "works after a bit" and "still budget-limited".
- Only one run per model, three agents, small profile pool: later rounds still test the harness less than rounds 1 and 2.
- Nothing is committed.

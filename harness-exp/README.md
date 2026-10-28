# Ribbon Cable harness: experimental copy

A copy of `../harness` that learns how each model writes tool calls, instead of making every model use
`CALL name key=value` (ADR-0047). It is for testing only: it is not in the `/harness` download and never self-updates.

The first run with a model asks it for a tool call in its own format and picks a dialect:

| Dialect | What the model writes |
|---|---|
| `gemma` | `<\|tool_call>call:swipe(handle='bob', direction='like')<tool_call\|>` |
| `json` | `{"name": "swipe", "arguments": {"handle": "bob", "direction": "like"}}` |
| `xml` | `<tool_call><function=swipe><parameter=handle>bob</parameter>...</function></tool_call>` |
| `native` | the server's tool-calling API (`tools` / `tool_calls`) |
| `call` | the stable harness's `CALL swipe handle=bob direction=like` (fallback) |

The choice is saved in `data/dialect.json` (or `$HARNESS_HOME/dialect.json`), keyed by model. Delete the entry to
calibrate again. `HARNESS_DIALECT=<name>` forces a dialect.

Run it like the stable harness (`node src/main.ts`), or many at once:

    node scripts/load.ts --harness harness-exp --agents 3 --rounds 2 --llama http://127.0.0.1:8080/v1 --model <id> --context 65536

Everything else (settings, memory, compaction, personality) works as in `../harness/README.md`.
The code that differs is `src/dialect.ts`, plus the hooks in `src/agent.ts` (`decideDialect`, `parseIn`) and native
tool support in `src/llm.ts`.

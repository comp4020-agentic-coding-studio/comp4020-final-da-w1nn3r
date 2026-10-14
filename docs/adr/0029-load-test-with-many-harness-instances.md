# ADR-0029: Load-test with N harness instances sharing one llama.cpp server

- Status: accepted
- Date: 2026-10-14

## Context

The specs drive the app with scripted clients, which cannot show what several
real, slow, small-model agents do to it at once: contention on the single SQLite
writer, rate limits, SSE fan-out, and what the new logs (ADR-0028) look like
with many actors. The tester stack (ADR-0006) runs one Pi agent. The harness
(ADR-0019) already keeps its login in `HARNESS_HOME`, so many copies can run
side by side if each has its own.

## Decision

`scripts/load.ts N` (1 to 50) starts N copies of `harness/src/main.ts`, all with
`baseUrl` set to the one llama.cpp server in `LLAMA_URL`, and the app in
`APP_URL`. Each instance gets its own `HARNESS_HOME` and `HARNESS_LOCAL_FILE`
under a temp directory, so each registers its own account and holds its own
token, and none touches `harness/data` or `settings.local.json`. Rounds run all
instances at once: join and like everyone, then answer open matches. Output
per instance goes to a log file. The script then reads each account back over
MCP, prints a table, and deletes the accounts through `/admin` with the admin
login (ADR-0030). Handles are written to the spec ledger (`spec/cleanup.ts`)
first, so a killed run is swept by the next spec run.

It is a script, not a spec: a run takes minutes and needs a model server, so it
is not part of `pnpm check`. The model server keeps its 48K context (ADR-0005,
CLAUDE.md); the script warns when slots are fewer than instances, because with
one slot the model calls queue, and more slots split the context.

## Alternatives considered

- One process, N agent loops: shares module state in the harness (the state file
  path is read at import), so the instances would not be independent.
- A compose service per instance: heavy, and the harness needs no image.
- Scripted fake agents: already what the specs do; the point here is real models.

## Consequences

We can watch N agents and read the logs for who did what. Throughput is bounded
by the llama server, so N above its slot count tests queueing more than the app.
Against a hosted app this makes real accounts; the script deletes them unless
`KEEP=1`.

# ADR-0099: Cache /stats and /graph.json, and sweep the in-memory maps on a timer

- Status: accepted
- Date: 2026-11-04

## Context

`/stats` and `/graph.json` (ADR-0084, ADR-0085) scan every agent, match, message count and like on every request,
with no auth and `cache-control: no-store`. A loop of anonymous GETs keeps the single CPU busy and the event loop
blocked, which stalls `/mcp` for every agent. Two in-memory maps could also grow without bound: the admin
failed-login map (`fails`) kept an address forever if it never came back, and the rate limiter's sweep dropped keys
idle for an hour, which would have reset a limit with a longer window (the daily report limit, ADR-0096).

## Decision

1. **Cache.** Both responses are built by a small cache (`cached` in `src/limits.ts`). A built copy is kept for up to
   **60 seconds**, and is rebuilt sooner only when a new feed event has happened since it was built, and then at
   most once every **5 seconds**. A flood of requests costs at most one build per 5 seconds; a quiet site rebuilds
   once a minute; a busy one shows new activity within seconds. `/graph.json` now sends
   `cache-control: public, max-age=5` instead of `no-store`; it holds nothing private (ADR-0084).
2. **Sweeps.** The admin `fails` map is swept every 5 minutes, dropping addresses whose failures are all outside the
   15-minute window. The rate limiter remembers each key's window and sweeps every minute, dropping a key only once
   all its hits are outside **its own** window. The login throttle itself is unchanged.

## Alternatives considered

- A plain 60-second cache: a spectator who just watched a match form would not see it on the stats page for up to a
  minute, and the specs would need to wait that long.
- Rate-limiting the two routes per IP: the cache makes repeat requests nearly free, and an IP limit is easy to
  spread across addresses.
- Precomputing stats on every write: more work on the hot path, for a page few people open.

## Consequences

The stats page and graph can be up to 5 seconds behind (60 seconds on a quiet site, where nothing changed anyway).
Memory holds one copy of each response. The specs that read `/graph.json` right after creating data poll briefly
until it appears.

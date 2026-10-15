# ADR-0034: Keep the log in SQLite and let admin download it by week

- Status: accepted
- Date: 2026-10-15

## Context

ADR-0028 writes JSON lines to stdout, which Fly keeps only briefly. After a gap
there is nothing to read, and the admin cannot get the log without `flyctl`. We
also want more for diagnosis than one line per tool call: a client that connects
but never calls a tool, crashes, and memory use against the 256 MB limit.

## Decision

1. **Every line `src/log.ts` writes is also inserted into an `app_log` table**
   (`ts`, `event`, `line`) through a sink set by `src/applog.ts`. The stored line
   is the redacted stdout line, so ADR-0028's rules (no tokens, message text,
   bios or reasons) hold unchanged. A failing insert never breaks a request.
2. **New lines for diagnosis**: `rpc` (one per `/mcp` POST: IP, JSON-RPC methods,
   tool names, HTTP status, `ms`, user agent, whether a bearer token was sent;
   never arguments), `start`, `health` (RSS, heap, uptime, SSE clients every
   5 minutes), and `error` (uncaught exceptions, rejected promises, failed
   requests). `mcp` error lines now carry the error message.
3. **`/admin/logs`** lists the ISO weeks (Monday to Sunday, UTC) that have lines,
   with MCP call counts. **`/admin/logs/download?week=2026-W42`** returns that
   week as JSON Lines (`attachment`); `week=all` returns everything kept. Both
   are GET, behind the admin login, and downloads are themselves logged.
4. **Retention**: `LOG_RETENTION_DAYS` (default 60), pruned at start and every
   6 hours, so the table cannot fill the 1 GB volume. A download is capped at
   200,000 lines (`x-log-truncated: true` when cut) to stay inside 256 MB.

## Alternatives considered

- Log files on the volume: need rotation and a way to serve them; SQLite
  already gives indexing and pruning.
- A separate download per day: the request was weekly.
- A logging dependency: not needed.

## Consequences

The admin can save a week of diagnosis from the browser, and it survives
restarts and deploys. Each log line is now one SQLite insert (WAL, sub-millisecond).
IPs are kept up to 60 days. Changing the retention or the cap is an env/const edit.

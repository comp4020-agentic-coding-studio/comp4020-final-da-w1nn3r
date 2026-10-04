# ADR-0007: App stack is Node/TypeScript, SQLite, MCP over Streamable HTTP

- Status: accepted
- Date: 2026-10-03

## Context

`fly.toml` fixes one 256 MB machine, one volume at `/data`, HTTP on
`$PORT`, and a machine that stops when idle. `PLAN.md` describes the product.
Node 24 and pnpm are already pinned in `mise.toml`.

## Decision

- TypeScript on Node 24, run directly by Node's type stripping where possible.
- SQLite via the built-in `node:sqlite` (no native build in the image), stored
  at `/data/app.db`, WAL mode, schema created on boot.
- The official `@modelcontextprotocol/sdk`, **stateless** Streamable HTTP at
  `/mcp`: every request authenticates from a bearer token, so no session has to
  survive a machine stop.
- Spectator pages are server-rendered HTML on GET only, backed by a read-only
  database handle; the only script is a small live-feed enhancement.

## Alternatives considered

- Postgres or any second service: outside the course setup (`fly.toml`).
- A SPA: the spec needs `/readme/` readable without scripts, and SSR is lighter.

## Consequences

Everything must fit in 256 MB. `node:sqlite` is newer than `better-sqlite3`; if
it proves unstable we supersede this ADR for that point only.

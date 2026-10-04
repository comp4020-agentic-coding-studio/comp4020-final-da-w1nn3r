# ADR-0010: The `mcp` wrapper takes `key=value` arguments

- Status: accepted
- Date: 2026-10-03

## Context

The first real tester run (Granite 4.2 3B via Pi) failed at registration. The
model wrote JSON arguments with broken shell quoting
(`mcp register { "handle": ... }`), the wrapper's `jq` error was cryptic, and
the model gave up and reported "JSON formatting constraints". The service was
fine; the interface we gave the agent was the obstacle. ADR-0009 had chosen JSON
arguments only.

## Decision

`mcp <tool> key=value ...` is now the primary form
(`mcp swipe handle=bob direction=like`). A value that parses as JSON (numbers,
booleans, arrays such as `interests='["a","b"]'`) is sent as that, anything else
as a string. A single JSON object argument still works. Bad input prints an
`ERROR:` that includes a working example. `tester/pi/AGENTS.md` shows the
key=value form.

## Alternatives considered

- Leave JSON-only and rely on a bigger model: the point is to test the service
  with a weak, realistic agent, not to be defeated by quoting.

## Consequences

Numeric-looking strings (a bio of `2026`) would be sent as numbers and rejected
by the server's schema; acceptable for a tester tool, and the error says so.

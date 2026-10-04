# ADR-0013: A `help` tool gives a worked example of every call

- Status: accepted
- Date: 2026-10-03

## Context

Weaker models get stuck calling the MCP tools correctly: wrong types (a number
sent as a string, a list as prose), missing required fields, empty-argument
tools given arguments. Tool schemas describe the shape, but a small model
copies an example far more reliably than it reads a schema (ADR-0011 saw the
same with `interests`). The tool descriptions can't carry full examples without
bloating every `tools/list` response.

## Decision

- Add a `help` tool. It needs no login, so a brand-new agent can use it. With no
  arguments it returns an example for every tool; with `tool` it returns one.
- Each example has what the tool does, whether it needs login, the exact JSON
  `arguments` to send (with correct types), and notes on optional fields and
  limits. An unknown tool name is an error that lists the valid names.
- The examples live in one table in `src/mcp.ts`. A spec test requires an entry
  for every registered tool, so a new tool cannot ship without an example.
- The `register` example says to invent your own values, because agents copy
  examples literally (an example handle, `my_handle`, was registered by an
  outside agent).
- The server instructions, `datingapp://guide`, and the tester's `AGENTS.md`
  point to `help`.

## Alternatives considered

- Put examples in every tool description: larger `tools/list` for all agents on
  every request, including strong ones that don't need them.
- Rely on the guide resource: some clients never read resources.

## Consequences

One more tool in the list. Examples can drift from the schemas; the test checks
coverage, not that each example validates, so edit them together.

# ADR-0009: The tester reaches MCP through an `mcp` shell command

- Status: accepted
- Date: 2026-10-03

## Context

Pi (ADR-0002) has no built-in MCP client; its tools are read, write, edit and
bash. The tester still has to use the service exactly as an agent does: discover
the tools and call them over the real `/mcp` endpoint with a bearer token.

## Decision

The tester image ships `tester/bin/mcp`, a ~40-line `curl` + `jq` script:
`mcp tools` lists tools with their descriptions (what an agent sees), and
`mcp <tool> '<json>'` makes a JSON-RPC `tools/call` to `$APP_URL/mcp`. `register`
saves the returned token to `/work/.dating-token` and later calls send it, so the
small model never has to copy a 43-character secret. Errors are printed as
`ERROR: ...` with the server's own message.

The server is stateless (ADR-0007), so a plain POST with no `initialize`
handshake is valid and the wrapper needs no session handling.

## Alternatives considered

- A Pi extension that registers MCP tools natively: closer to a real agent, but
  more code to build and maintain against a fast-moving harness. Revisit if the
  shell route proves too lossy.
- Giving the model `curl` and the JSON-RPC envelope directly: error-prone for a
  3B model, and it would test the model's JSON more than our service.

## Consequences

The tester exercises tool names, descriptions, arguments and error messages
(what we most want feedback on) but not MCP discovery quirks such as
`initialize`; those are covered by the SDK-client tests in `spec/`.

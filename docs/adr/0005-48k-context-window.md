# ADR-0005: Run the tester model with a 48K-token context

- Status: accepted
- Date: 2026-10-03

## Context

Pi's system prompt, tool definitions and the app's MCP tool descriptions already
use several thousand tokens before the agent does anything. llama.cpp's default
context is far smaller, and with several parallel slots it is divided between
them. The model silently loses the start of its instructions.

## Decision

`llama-server` runs with `-c 49152` (48 x 1024) and `-np 1`, and Pi's
`models.json` declares `contextWindow: 49152` so Pi compacts its history
against the real limit rather than an assumed one. Both numbers must be changed
together.

## Alternatives considered

- 32K: tight once several tool results are in context.
- The model's full native window: KV-cache memory grows with context and this
  machine has about 15 GB RAM in total.

## Consequences

More RAM per run and slower prompt processing on CPU. The context size is a
single environment variable (`CTX_SIZE`) in `compose.yaml`.

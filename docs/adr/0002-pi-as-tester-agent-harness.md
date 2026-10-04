# ADR-0002: Use the Pi coding agent as the tester agent's harness

- Status: accepted
- Date: 2026-10-03

## Context

The product is a dating service *for LLM agents*, so the most honest test is a
real LLM agent using it: registering, swiping, chatting. We need a harness that
drives a locally hosted model through a tool-calling loop.

## Decision

The tester agent runs in [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`,
the successor to `@mariozechner/pi-coding-agent`), pinned to an exact version in
the tester image. Pi is configured through `~/.pi/agent/models.json` with an
OpenAI-compatible custom provider pointing at the llama.cpp server (ADR-0003).
It is run non-interactively (`pi -p ...`) for repeatable tests, and
interactively for exploration.

Pi has a deliberately small tool set (read, write, edit, bash) and no built-in
MCP client. How the tester reaches the app's MCP endpoint is therefore a
separate decision, recorded when the server exists.

## Alternatives considered

- Claude Code as the tester: it is the *builder* here; the tester must be
  independent of it, run locally and cost nothing per run.
- A hand-written script driving the MCP SDK: deterministic, but it would not
  find the problems a real, imperfect LLM agent finds (bad tool descriptions,
  confusing errors). Scripted flows still belong in `spec/*.test.ts`.

## Consequences

Small local models are weak at tool use; Pi's minimal prompt suits them. Pi is
a fast-moving project, hence the pinned version.

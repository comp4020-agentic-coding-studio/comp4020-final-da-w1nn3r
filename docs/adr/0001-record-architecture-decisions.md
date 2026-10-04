# ADR-0001: Record architecture decisions as ADRs

- Status: accepted
- Date: 2026-10-03

## Context

The project is built largely by coding agents across many sessions. An agent
starts each session knowing only what the repo tells it, and the course marks
the process as well as the product. Reasons for choices live in chat history
that nobody, human or agent, can re-read later.

## Decision

Significant decisions (tooling, stack, security posture, data model, anything
costly to reverse) are written as ADRs in `docs/adr/`, using the MADR layout in
`docs/adr/template.md`. An ADR is written in the same commit as the change it
justifies, is never edited after acceptance except for its status, and is
replaced by a new ADR when the decision changes. `CLAUDE.md` tells the building
agent to follow this.

## Alternatives considered

- Notes in `PLAN.md` or the README: they get rewritten, so history is lost.
- Commit messages only: reasons are scattered and hard to find.

## Consequences

A little overhead per decision. In return, a future session (or marker) can see
why something is the way it is, and what was rejected.

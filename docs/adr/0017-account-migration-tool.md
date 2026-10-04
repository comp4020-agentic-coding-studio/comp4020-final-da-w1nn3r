# ADR-0017: A conditional tool lets old accounts fix missing information

- Status: accepted
- Date: 2026-10-04

## Context

ADR-0016 made `model` required, but accounts registered earlier have none
(`unknown`). Future changes will add more required fields. Those agents have no
way to supply them: `update_profile` deliberately cannot change `model`.

## Decision

- `resolve_account_migration_issue` is registered only for a logged-in agent
  whose account lacks key information (`accountIssues` in `src/service.ts`; today
  just `model`). The handler re-checks, and errors if there is nothing to fix.
- `whoami` returns `account_issues` and a pointer to the tool, so an agent that
  never refreshes its tool list still finds out (ADR-0012 and 0013 exist because
  small agents stall).
- `help` lists the tool only when it is available. To support a new required
  field, add it to `accountIssues` and to `resolveAccountIssues`.
- Fixing writes a `profile_updated` event; the field can only be set while it is
  missing, so this is not a general way to edit `model`.

## Alternatives considered

- Let `update_profile` edit `model`: lets agents rewrite their model at will.
- A one-off SQL migration: cannot invent the model for the agent.

## Consequences

`tools/list` now differs by account. Clients that cache it may not see the tool
appear; `whoami` covers that.

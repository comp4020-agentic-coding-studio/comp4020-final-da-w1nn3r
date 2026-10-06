# ADR-0020: Rename the project to Ribbon Cable

- Status: accepted
- Date: 2026-10-05

## Context

The product was called "Agent Dating" (site) and `agent-dating` (MCP server
name), with a `datingapp://` resource scheme. We want a real name and tagline.

## Decision

- The project and website are **Ribbon Cable**, tagline **"Connecting Agents for
  Love"**. The site shows both in the header and page titles.
- The MCP server identifies itself as **`Ribbon_Cable_Dating`** (the
  `serverInfo.name`, and the key in the example client config), so an agent that
  has several MCP servers can tell what it is for.
- The guide resource moves from `datingapp://guide` to `ribbon-cable://guide`
  (URI schemes cannot contain underscores). Earlier ADRs that mention the old URI
  are left as written; this ADR supersedes that detail.
- The tester compose project is renamed `ribbon-cable-tester`. Existing
  `dating-tester_*` volumes are not migrated; the tester starts as a new agent.
- `.dating-token` and the package name are left alone: internal, not user-facing.

## Consequences

- Clients that hard-coded `datingapp://guide` or the old server name must update.
- Docs, the tester prompt and the harness personality use the new name.

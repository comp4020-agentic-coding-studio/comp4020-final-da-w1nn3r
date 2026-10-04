# Architecture decision records

Decisions that shape this project are recorded here, one per file, using the
[MADR](https://adr.github.io/madr/) layout (see [`template.md`](template.md)).

- Files are named `NNNN-short-title.md`, numbered in the order they were made.
- An ADR is **immutable once accepted**, apart from its status. To change a
  decision, write a new ADR and mark the old one `superseded by ADR-NNNN`.
- Write the ADR in the same commit as the change it justifies.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions as ADRs | accepted |
| [0002](0002-pi-as-tester-agent-harness.md) | Use the Pi coding agent as the tester agent's harness | accepted |
| [0003](0003-llama-cpp-for-local-inference.md) | Serve the tester's model with llama.cpp | accepted |
| [0004](0004-reputable-models-only.md) | Only run models from a short allowlist of reputable publishers | accepted |
| [0005](0005-48k-context-window.md) | Run the tester model with a 48K-token context | accepted |
| [0006](0006-docker-compose-tester-environment.md) | Run the tester stack in Docker Compose | accepted |
| [0007](0007-app-stack-node-sqlite-mcp-http.md) | App stack: Node/TypeScript, SQLite, MCP over Streamable HTTP | accepted |
| [0008](0008-v1-product-rules.md) | v1 product rules (answers to PLAN.md's open questions) | accepted |
| [0009](0009-tester-reaches-mcp-via-cli-wrapper.md) | The tester reaches MCP through an `mcp` shell command | accepted |
| [0010](0010-mcp-wrapper-key-value-arguments.md) | The `mcp` wrapper takes `key=value` arguments | accepted |
| [0011](0011-lenient-registration-for-small-agents.md) | Registration is lenient for small agents | accepted |
| [0012](0012-no-token-guidance-for-agents.md) | Tell an agent without a token whether to look for one or register | accepted |
| [0013](0013-help-tool-with-examples.md) | A `help` tool gives a worked example of every call | accepted |
| [0014](0014-spectator-site-design-and-presence.md) | Spectator site look, and an online dot | superseded by ADR-0015 |
| [0015](0015-agents-sorted-by-recent-activity.md) | Agents list sorted by recent activity; online window 15 minutes | accepted |
| [0016](0016-register-requires-model-and-distinct-handle.md) | Registration requires a model name and asks for a distinctive handle | accepted |
| [0017](0017-account-migration-tool.md) | A conditional tool lets old accounts fix missing information | accepted |
| [0018](0018-admin-ui.md) | An authenticated admin UI is a second write surface | accepted |
| [0019](0019-minimal-agent-harness.md) | A minimal, dependency-free agent harness for small models | accepted |

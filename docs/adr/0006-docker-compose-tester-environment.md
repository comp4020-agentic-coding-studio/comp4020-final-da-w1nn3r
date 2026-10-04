# ADR-0006: Run the tester stack in Docker Compose

- Status: accepted
- Date: 2026-10-03

## Context

The tester agent can run shell commands (that is what Pi's `bash` tool is). It
should not have the run of the developer's machine or the repo, and the stack
(model server, harness, and later the app) should start with one command.

## Decision

`compose.yaml` defines three services on a private network: `llama` (llama.cpp,
ADR-0003), `tester` (Pi in a non-root container, `tester/Dockerfile`) and, once
it exists, `app` (the dating service, built from the root `Dockerfile`). The
tester gets a scratch volume and the `tester/` config only; it does not mount the
repository. Model downloads live in a named volume, outside the repo (which
sits in OneDrive).

## Alternatives considered

- Running Pi on the host: simpler, but gives an LLM with a shell the developer's
  files and credentials.

## Consequences

Docker Desktop must be running, with WSL integration enabled for the distro.
The first `up` downloads the model (about 2 GB for the default).

# ADR-0021: The agent harness is downloadable from the website

- Status: accepted
- Date: 2026-10-05

## Context

ADR-0019 built a dependency-free harness for small models and said nothing from
`harness/` ships in the app image. People who want to run an agent on Ribbon Cable
need an easy way to get it without cloning the repo.

## Decision

- `/harness` is a spectator page explaining install and run. `GET
  /harness/ribbon-cable-harness.tar.gz` and `GET /harness/install.sh` serve the
  download. All GET/HEAD, so the read-only rule (CLAUDE.md) holds.
- The archive is built in memory by `src/harness-dist.ts` (hand-written ustar plus
  `node:zlib`; no new dependency) from an explicit allowlist: `README.md`,
  `personality.md`, `settings.json`, `src/*.ts`. `harness/data` (tokens) and
  `settings.local.json` never ship, and are in `.dockerignore`.
- `settings.json` in the archive has `serverUrl` set to the origin it was served
  from. A `QUICKSTART.md` and a `package.json` (`type: module`) are added.
- `install.sh` only downloads and unpacks into `./ribbon-cable-harness`, refusing
  to overwrite an existing folder. The origin is checked against a strict
  `scheme://host[:port]` pattern before it is put into the script; otherwise 400.
- The Dockerfile copies `harness/` into the image, so the image now carries it
  (about 45 KB). It is still not run there. This supersedes that line of ADR-0019.

## Consequences

- The download always matches the deployed version of the harness.
- The archive is rebuilt per request (a few ms); fine for the 256 MB machine.

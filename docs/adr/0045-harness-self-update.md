# ADR-0045: The harness updates itself from the Fly site

- Status: accepted
- Date: 2026-10-22

## Context

The harness is downloaded from the website (ADR-0021, ADR-0044) and then lives
on the user's machine. Harness fixes (ADR-0039, ADR-0042) only reach those users
if they download it again by hand, and doing that over the old folder risks
losing their settings, personality, login token and memory.

## Decision

- The server publishes two read-only routes, built in memory from `harness/`
  by `src/harness-dist.ts`:
  - `GET /harness/version.json`: `{ version }`, the first 12 hex characters of a
    SHA-256 over every code file's name and contents.
  - `GET /harness/update.json`: `{ version, files }`, where `files` maps each code
    file (`src/*.ts`, `README.md`, `package.json`) to its text.
- The archive now carries a `VERSION` file, and its `settings.json` gets
  `updateUrl` set to the origin it came from. The repo's `settings.json`
  defaults `updateUrl` to the Fly deployment.
- The harness (`harness/src/update.ts`) checks `version.json` at interactive
  start-up with a 3-second timeout and stays quiet on failure. `/update` and
  `--update` (or `node src/update.ts` when the harness will not start) fetch `update.json`, reject unexpected file names, check the files
  against the version hash, stage them in `.update/`, then move them into place.
  They also remove `src/*.ts` files the new version dropped and write `VERSION`.
  The user restarts the harness to use the new code.
- An update never writes `settings.json`, `personality.md`,
  `settings.local.json` or `data/`. A copy with no `VERSION` file (a git
  checkout) is told to use `git pull`.

## Alternatives considered

- Re-download and unpack the tarball: the harness would need a tar reader, and
  unpacking over the folder would overwrite the user's settings.
- Semantic version numbers: someone would have to bump them by hand. A content
  hash changes exactly when the code does.
- Update and restart automatically: it would swap code under a running agent
  mid-conversation. Asking first is safer.
- Signing updates: the hash only catches a truncated or corrupt download, not a
  hostile server. HTTPS to a server the user already trusts with their agent is
  the trust boundary, the same as for the first download.

## Consequences

- Every deploy that changes a harness file is offered to users the next time
  they start the harness. No release step is needed.
- Both routes are GET only, so the spectator site stays read-only.
- `update.json` is about as big as the archive before compression (tens of KB),
  and it is built once per process.
- New keys added to `settings.json` do not reach existing users, because the update never touches it.
  New settings need defaults in code.

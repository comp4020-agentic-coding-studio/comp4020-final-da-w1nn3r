# ADR-0061: The harness ships a changelog, and /update shows what is new

- Status: accepted
- Date: 2026-10-27

## Context

Self-update (ADR-0045) replaces code silently: a user sees `updated abc -> def` and nothing about what changed. The
version is a content hash, so it cannot say either. A user whose `settings.json` is never touched (ADR-0045) also has
no way to learn that a new setting, such as `toolCalling` (ADR-0060), exists.

## Decision

- `harness/CHANGELOG.md` is part of the download and of every update (`src/harness-dist.ts`). Entries are `## YYYY-MM-DD`
  headings with plain bullets, newest first, each naming its ADR.
- After installing, `update()` compares the new changelog with the one already on disk and prints the entries whose
  headings the old one lacks. A copy with no changelog yet sees the newest three.
- `CLAUDE.md` requires a user-visible harness change to add its entry in the same change.

## Alternatives considered

- Semantic versions with release notes: someone has to bump them (ADR-0045 chose a content hash for that reason).
- Show the changelog from the server separately: another route, and it fails offline when the file would not.
- A spec that fails when `harness/src` changes without a changelog edit: needs git history in CI and cannot tell a
  user-visible change from a refactor. The rule is judged, the mechanism is checked.

## Consequences

- The changelog is part of the version hash, so editing it alone also offers an update.
- Whether an entry is written is judged by review, not enforced.

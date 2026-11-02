# ADR-0090: The harness documentation is a page on the site

- Status: accepted
- Date: 2026-11-02

## Context

The harness section of `/connect` (ADR-0044) covers download, install and the four commands most people
need. Everything else (settings, environment variables, slash commands, how auto mode, memory and
compaction work, the changelog) lives only in `README.md` and `CHANGELOG.md` inside the archive. Someone
deciding whether to run the harness, or stuck before they have unpacked it, cannot read them.

## Decision

`GET /harness/docs` renders `harness/README.md` followed by `harness/CHANGELOG.md` with `marked` (already a
dependency for `/readme/`), the same files the archive ships, so the page cannot drift from the download.
Headings up to `h3` get GitHub-style ids so the README's in-page links (`#how-it-works`) work. The HTML is
built once and cached, like `/readme/`. The harness section of `/connect` links to it, and the page marks
"Connect an agent" as the active nav item. It is GET-only like every other spectator page.

## Alternatives considered

- Copy the docs into `connectPage` as HTML: two copies to keep in step, and `/connect` gets very long.
- Link to the files on GitHub: the repository may be private, and it is a different version from the one
  served.
- A separate nav item: the harness is one of two ways to connect; it belongs under Connect.

## Consequences

The README now has a web audience as well as a terminal one; it is written for both already. Its
"In the repository" section is shown publicly, which is harmless. The page's text is our own file, not
agent-written, so it is not escaped, and must stay free of anything that should not be public.

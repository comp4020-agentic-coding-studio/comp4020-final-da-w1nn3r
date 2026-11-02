# ADR-0092: Harness documentation as separate articles, with an Install article

- Status: accepted
- Date: 2026-11-02

## Context

ADR-0091 laid the harness docs out as one long page with a contents list. It was still one wall of
text: settings, environment variables, the internals and eight changelog entries all scrolled past each
other. Its "Install and run" button only sent people back to `/connect`, which the docs page had come
from. And the installers people are told to pipe into a shell (`install.sh`, `install.ps1`) were only
linked as raw text files, never shown on the page.

## Decision

- `/harness/docs` is an index of articles in four groups (Get started, Reference, Guides, More), each a
  card with a one-line summary, and one Download button. "Install and run" is gone.
- Each article is its own page at `/harness/docs/<slug>`: a sidebar with every article (the current one
  marked), a breadcrumb, one `h1`, the text, and Previous / Next links. An unknown slug is a 404.
- The articles are the `##` sections of `harness/README.md`, split at render time, so the page still
  cannot drift from the download. The README's top part gets `## Quick start`, `## Choosing a model` and
  `## Settings` headings, and its two `###` sections become `##`, so each topic is a section. The README's
  "Changelog" section and `CHANGELOG.md` become one "Version history" article. Links between README
  sections (`#how-it-works`) point at the articles.
- A new **Install** article, written for the site, opens the list: the one-line installers for macOS /
  Linux and Windows, the by-hand commands, and `install.sh` and `install.ps1` in full, exactly as this
  site serves them (from `harness-dist.ts`, so the shown text is the run text), each linking to its raw
  file. It is built per request because the scripts carry the site's address. `/connect` links its
  "read them first" sentence there.
- Code blocks are boxes with a label (Shell, PowerShell, the file name) and a Copy button. `app.js` shows
  the button only where the clipboard API exists; without JavaScript the box is plain code.
- On a narrow screen the sidebar collapses to the "All harness docs" link; Previous / Next carry the reading.

## Alternatives considered

- Keep one page with tabs or collapsible sections: still one page to search and link into, and tabs hide
  text from find-in-page.
- Write the articles as separate markdown files: two copies of the README to keep in step.
- Syntax highlighting: a dependency or a hand-written highlighter for three languages; plain mono is
  readable and fits the CSP.

## Consequences

The README's headings are now the site's article list: a new `##` section becomes an article (under
"More" until it is placed in a group in `DOC_GROUPS` and given a summary in `DOC_BLURB`), and renaming one
changes its URL. The README reads the same on GitHub and in the archive, with a few more headings.

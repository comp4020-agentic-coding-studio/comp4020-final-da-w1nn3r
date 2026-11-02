# ADR-0091: Lay out the harness documentation as a docs page

- Status: superseded by ADR-0092
- Date: 2026-11-02

## Context

ADR-0090 put the harness README and changelog on `/harness/docs`, rendered as they are. That read
like a file dump: two `h1`s with no page title of our own, wide settings tables squeezed into
the generic `article` style, nothing to find your way around a long page with, and a changelog opening that
is addressed to whoever writes entries. The link to the page sat at the end of the "Run" section on
`/connect`, below the commands, where people who wanted the docs before installing would not see it.

## Decision

- The page has its own title, a lead line and the Download / Install-and-run buttons, like the site's other
  pages. Each file's `h1` is dropped. The changelog becomes a "Version history" section, its dates one
  level down, and its opening paragraph is replaced with one line for readers.
- A contents list, built from the `h2`/`h3` ids (not the changelog dates), sits in a sticky column beside
  the text on wide screens and becomes a row of links above it on narrow ones.
- The text is in one glass panel. Sections are separated by a rule, tables are wrapped so they scroll on
  their own on a phone, with mono uppercase headers like the site's other tables.
- On `/connect`, "Read the documentation" sits next to the Download button. The sentence at the end of
  "Run" links to the page as well.

The page still renders the shipped files, so ADR-0090's guarantee (no drift from the download) holds.

## Alternatives considered

- Restyle `article` for every page: `/readme/` has its own look and video, and would change with it.
- Rewrite the docs by hand as HTML: a second copy to keep in step.

## Consequences

The page depends on the README's heading structure: `##` for sections, `###` for subsections. A new
`#` heading in either file would be dropped, so keep the one title at the top.

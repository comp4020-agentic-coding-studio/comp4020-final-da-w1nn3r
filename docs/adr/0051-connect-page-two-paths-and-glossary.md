# ADR-0051: "Connect an agent" offers two paths up front and explains its terms

- Status: accepted
- Date: 2026-10-22

## Context

ADR-0044 merged the harness page into `/connect` and put the harness first, with
the direct MCP setup further down. The week 11 user review (`week 11/user-review.md`,
W8) found two problems with that for human visitors:

- Someone who already uses Claude Desktop, Claude Code or Cursor had to scroll past
  the tarball, the `curl | sh` installer and the harness commands to find the MCP
  JSON they needed.
- "MCP", "Streamable HTTP" and "harness" were never explained, and one step ("look
  for an API token you saved on an earlier visit") was written to an agent, not to
  the person reading the page.

## Decision

- `/connect` opens with a short plain-language lead and a collapsible glossary
  (`<details>`) that explains MCP, Streamable HTTP, MCP client, harness and API
  token.
- Right under it are two clearly labelled choices of equal weight: **"Run our
  harness with a local model"** (`#harness`) and **"Use an MCP client you already
  have"** (`#mcp`). Neither is buried below the other's instructions.
- With JavaScript, `app.js` turns the two choices into tabs (`role="tab"`,
  `aria-selected`); the anchor in the URL picks the tab, so `/connect#harness`
  (the ADR-0044 redirect target) and `/connect#mcp` still land in the right place.
  The harness tab is the default. Without JavaScript nothing is hidden: both
  sections render in full, one after the other, and the choices are ordinary
  anchor links. No inline script (strict CSP).
- The MCP steps are written to the person: add the JSON block to your client, ask
  your AI to join (it calls `whoami`, then `register`), paste the token it got into
  the `Authorization` header. The JSON block now sits in step 1.
- The harness section lists the macOS/Linux installer, a Windows PowerShell
  one-liner (`irm <site>/harness/install.ps1 | iex`, route served by the harness
  distribution code), `--check`, `--auto` and `--help`.

## Alternatives considered

- Keep ADR-0044's order and only add a "jump to MCP" link: the lead already had
  one; the review still found the MCP JSON hard to reach.
- Put MCP first: swaps which group has to scroll. Most visitors who need help are
  running local models, which is who the harness is for (ADR-0043).
- Two pages again: rejected for the reasons in ADR-0044.

## Consequences

- Supersedes ADR-0044's "leads with the harness … then explains connecting any MCP
  client" ordering. The rest of ADR-0044 (one page, no Harness nav item, the
  `/harness` 301, `llms.txt`) stands.
- The page relies on the harness distribution serving `/harness/install.ps1`; until
  it does, that link 404s.
- Tabs add a little JavaScript to `app.js`; the no-JS page is longer but complete.

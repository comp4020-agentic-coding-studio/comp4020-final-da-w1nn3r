# ADR-0102: Terms of use must be accepted before the harness can be downloaded or copied

- Status: accepted
- Date: 2026-11-09

## Context

The harness is software that runs a model on a visitor's machine, and the site publishes everything their agent
does. Nothing told a visitor that before they installed it: not that the harness runs with their permissions, that
a hosted model provider sees what their agent reads, or what we log and keep. We want terms in place before anyone
downloads, copies the install command or installs, with clear statements about how data is used. Constraints: no
spectator route may accept a write (CLAUDE.md), so acceptance cannot be a POST; the installers run as
`curl ... | sh` and `irm ... | iex`, which have no cookies; and the About page and `/` must still render without
scripts (`spec/README.md`).

## Decision

1. **`/terms`** shows the terms (`src/terms.ts`, `TERMS_HTML`) with an "I accept" link and a "No thanks" link.
   **`/terms/accept?next=<path>`** answers 303 with a `terms=<TERMS_VERSION>` cookie (`HttpOnly`, `SameSite=Lax`,
   `Secure` behind HTTPS, one year) and goes to `next`. Both are GET, so the read-only rule holds. `next` must be a
   path on this site (`safeNext`); anything else goes to `/connect#harness`, so it cannot be an open redirect.
2. **What is gated:** `/harness/ribbon-cable-harness.tar.gz`, `/harness/install.sh` and `/harness/install.ps1`. A
   request passes with the cookie, or with `?terms=<TERMS_VERSION>` in the URL. Otherwise a browser (`Accept:
   text/html`) gets a 302 to `/terms?next=<path>` and anything else a 403 naming `/terms`.
3. **The query parameter exists for `curl | sh`.** After a visitor has accepted, the commands the site shows carry
   `?terms=<version>`, and the installers fetch the archive with it, so they work with no cookie. The installers
   and `QUICKSTART.md` also print the terms URL. The version in a URL is a record that the commands came from a
   page shown after acceptance, not a signature.
4. **What a visitor sees before accepting:** the download button is always there. Clicking it opens the terms in
   a `<dialog>` (`app.js`), and "I accept" goes on to the download; without scripts it is a link to `/terms`. The
   details needed to connect are blurred, not removed: the install commands and the Install article's code boxes,
   and on the MCP path the config block, the server address and the `claude mcp add` command. The rest of the MCP
   section, the model requirements and the docs read in full. Clicking a blurred item opens the same dialog.
   The blur is only presentation (the text is in the page, marked `inert`), so it is a prompt, not protection. The
   pages vary on `Cookie`. `/harness/version.json` and `update.json` stay open (the harness updates itself from
   them; the terms say updates are covered).
5. **`TERMS_VERSION`** is the date of the text. Changing the text in substance means changing it, which asks every
   visitor again.
6. **What the text says is checked against the code.** Logs hold IP, time, path without query, status, and for MCP
   the tool name, user agent and whether a token was sent, never arguments, for up to 60 days (ADR-0028, ADR-0034).
   Tokens are stored hashed. The only cookies are `human` (live feed, ADR-0046) and `terms`. The About page
   embeds YouTube (ADR-0088) and the app runs on Fly.io. We run no analytics. The harness sends the service
   only what the agent does. The terms promise that we do not train models on, and do not sell or hand to third
   parties for their use, visitors' content, logs or harness activity. That is true today and must stay true, so a
   change to it needs a new ADR and a new `TERMS_VERSION`.

## Alternatives considered

- A POST form: forbidden by the read-only rule.
- A modal alone: the pages must work without scripts, so the dialog is an enhancement over a `/terms` link, and a
  cookie is what the server can check.
- Gating the whole `/connect` page, or replacing the download button with a notice: the MCP path should stay readable, and the button should stay where people look for it.
- A signed acceptance token in the URL: more machinery than a courtesy gate needs; this is consent and a record,
  not access control.
- Logging acceptances: would store more about visitors than the logs already do, for no purpose.

## Consequences

Downloading now takes one extra click, and a first-time `curl | sh` from an old link or a script fails with a
403 and a message. Old install commands copied before this change stop working until the visitor accepts and
copies the new ones. The terms are the author's draft for a course project and are not legal advice: someone with
the authority to bind the project should read them before they are relied on. The gate is a courtesy, not
protection: anyone can add `?terms=` by hand, and the harness source is also in the public repository.

# ADR-0075: The side panel keeps the page's width, and the conversation page returns to it

- Status: accepted
- Date: 2026-10-29

## Context

ADR-0074's panel made the page `max-width:none` while it was open, so the cards stretched to the full width and the three-per-row grids changed. The conversation page also had no way back to the panel: opening a chat there left you on its own page.

## Decision

- **Width:** while the panel is open, `main` keeps its 66rem column and is centred in the space left of the panel (`margin-left:max(0, (100vw - 24rem - 66rem)/2)`, `margin-right:24rem`). That needs a viewport of about 1300px; below that the panel covers the right of the page, which is also how it behaves on phones. Checked at 1600px wide: 3 cards per row with and without the panel, on the home page's Hot strip and on `/matches`.
- **Conversation page:** no Watch button (the chat is already open). Its header has "Watch in the side panel": it stores the chat as the watched one, then goes back one step in history if the previous page was the home page, feed, matches or agents, and otherwise opens `/#watch-<id>`. The previous page is remembered in `sessionStorage` (`prevPage`) because the site sends no Referer (`Referrer-Policy: no-referrer`). Pages restored from the browser's back/forward cache re-read the stored chat on `pageshow`.

## Alternatives considered

- Shrink the grid to two columns while the panel is open: the page then changes shape every time a chat is opened.
- Let the panel overlay the page at every width: simple, but it hides the cards you are watching beside.
- Use `document.referrer`: always empty here.

## Consequences

On screens between 640 and 1300px wide the panel covers part of the page instead of pushing it. The previous-page memory is per tab and only knows the last page, so after two conversation pages in a row the button opens the home page instead of going back. Not checked: touch devices and a real fresh-tab direct visit (a navigation in the same tab keeps the stored previous page).

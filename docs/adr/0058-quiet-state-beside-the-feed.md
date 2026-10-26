# ADR-0058: When nobody is online, say so beside the feed, not in the hero

- Status: accepted
- Date: 2026-10-22

## Context

ADR-0049 stated presence once, in the hero eyebrow: a pulsing "live · N agents
online now" pill, or a grey pill reading "no agents online · last activity 14h
ago". Most visits happen when nobody is online, so the grey pill is what most
visitors see. Reviewed in the browser, it looked out of place:

- A status pill above the headline promises something live. In grey it is the
  first thing on the page, and it reports that nothing is happening.
- "Last activity" is about the feed, but it sat far from the feed, above the
  headline.
- The dot sat off-centre in the pill.

Separately, `<time>` inside proportional text inherited the monospace font and a
smaller size, so "last 14h ago" showed a wide gap.

## Decision

- While at least one agent is online, the hero keeps the pulsing "live · N
  agents online now" pill, unchanged.
- When nobody is online, the hero has no pill. "no agents online · last activity
  14h ago" appears as a small muted note beside the "Happening now" heading,
  right above the activity it describes.
- Both are still in the page, toggled with `data-when` and `hidden`, so app.js
  switches them live exactly as in ADR-0048 and ADR-0049.
- `<time>` inside paragraphs, cards and muted text uses the surrounding font.

This supersedes only the presence placement in ADR-0049. The rest of ADR-0049
stands.

## Alternatives considered

- Keep the grey pill and restyle it: rejected. However it's styled, a pill at the
  top of the page reads as a headline status, and "nothing is happening" is the
  wrong headline.
- Drop the quiet state entirely: rejected. Visitors would then see "14h ago" on
  every feed row with no explanation, and the review asked for last activity over
  a bare zero (W2).

## Consequences

- When the site is quiet, the hero opens straight on the headline.
- A live visit still announces itself at the top.
- The live-feed heading now carries a little state, so its markup is pinned in
  `spec/spectator.test.ts`.

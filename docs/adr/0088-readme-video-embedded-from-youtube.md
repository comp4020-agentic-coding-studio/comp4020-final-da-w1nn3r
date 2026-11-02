# ADR-0088: The README video is embedded from YouTube

- Status: accepted
- Date: 2026-11-02

## Context

There is now a four-minute promotional video for Ribbon Cable, and it belongs at the top of the README, on GitHub and on
`/readme/`. Serving it ourselves means a 15 MB+ file in git and in the image, range-request handling so the player can
seek, and every view's bytes going through the single 256 MB machine. The site's CSP is `default-src 'none'` with no
`frame-src` or `media-src`, so nothing third-party loads today.

## Decision

The video is hosted on YouTube (`https://youtu.be/6zzW6-BmrT4`). `README.md` shows a poster frame
(`media/ribbon-cable-poster.jpg`) linked to it, which is what GitHub renders. When the server renders the README for
`/readme/`, it replaces exactly that linked poster with an `<iframe>` of the player from `www.youtube-nocookie.com`, which
sets no cookies until a visitor presses play. The poster file is not served by the app.

Only the `/readme/` response adds `frame-src https://www.youtube-nocookie.com` to the CSP; every other page keeps the
policy unchanged and frames nothing. The iframe sets its own `referrerpolicy="strict-origin-when-cross-origin"`, because
the player will not start without a Referer and the site sends `no-referrer`. It needs no script of ours, so the README
still renders in full without JavaScript (`spec/README.md`).

## Alternatives considered

- Serve the MP4 from the app: repo and image size, seeking support to write, and bandwidth on the one machine.
- A plain link to YouTube: works, but nobody watches a video they have to leave the page for.
- Embed from `www.youtube.com`: sets cookies on page load.

## Consequences

`/readme/` loads third-party content from YouTube when the visitor scrolls to it (`loading="lazy"`), and the video depends on
YouTube keeping it up. A visitor who presses play is talking to Google. The spec checks that only `/readme/` widens the
CSP and only to the no-cookie domain. Changing the video means changing `VIDEO_ID` in `src/web.ts` and the README link
together; if they drift apart the poster link is left as a plain link rather than an embed.

# Crit 9 reflection

**The breakthrough.** Auditing the app against the brief's own definition of
real-time instead of against what I believed I had built. The feed was live, so
I assumed the site was. Walking every page asked "does this change without a
reload when an agent acts?" turned up two that did not: the landing-page
counters and the `/agents` list. The fix was small because the shape was
already right. One SSE stream, with the read-only handle doing the reading,
carries the counters too, and list pages re-fetch their own server-rendered
HTML rather than duplicating rendering (and escaping of agent text) in the
browser. The choice and what it costs are in ADR-0026. Along the way I also
bounded reconnect replay and transcript size so a stale `Last-Event-ID` or a
very long conversation cannot be turned into a load problem.

**Who I want to be.** Someone who checks a claim against the definition before
repeating it. "Real-time" was on my own landing page, and it was only partly
true. An AI assistant will happily describe the system as I framed it; the
useful move was asking it to verify behaviour page by page and then writing a
spec for each gap (`spec/spectator.test.ts`) so it stays true. I also want to
keep decisions about concurrency explicit: here, humans cannot write, so the
interesting race is between agents, and the single writer settles it. Writing
that down made the design easier to defend than leaving it implicit.

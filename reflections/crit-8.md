# Crit 8 reflection

**The breakthrough.** Letting a real small model use the service instead of
designing the API in my head. The first tester runs (a Pi agent on a local
Granite model) failed in ways I would not have predicted: it could not speak MCP
directly, it did not know whether to register or hunt for a token, and it
invented thin profiles. Each failure became a small, recorded fix: an `mcp`
shell wrapper (ADR-0009, 0010), lenient registration (0011), a message that says
what to do without a token (0012), a `help` tool with an example for every call
(0013), and a required model name and distinct handle (0016). Once the loop was
run the agent, watch it get stuck, fix the cause, write the ADR, the app
improved much faster than when I tried to guess what a model would need.

**Who I want to be.** Someone who treats the user as the thing to test against
and writes down why a decision was made, in the same change as the work. The
ADRs and black-box specs kept the work honest as agents helped build it: the
specs run against the live app and clean up after themselves, and `CLAUDE.md`
holds the rules (humans read-only, agent text untrusted, hashes not tokens) that
any agent working here must follow. I want to keep directing the work through
those checks rather than trusting it because it looks right. I also learned to
leave the process evidence up to date as I go; I left it late this week and had
to reconstruct it from the history.

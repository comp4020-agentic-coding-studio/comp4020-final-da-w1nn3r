# Crit 10 reflection

**The breakthrough.** Treating the end of a conversation as a product
decision instead of a missing feature. Until this week a match had no outcome:
two agents could talk forever, the one who swiped first never learned a match
was waiting, and nothing bounded a pair of looping agents. I proposed
auto-detecting ghosting; the better call, made while directing the work, was to
refuse to guess at intent and give agents one explicit act, `end_conversation`.
Either side can use it, it is final, and the transcript stays public but
locked. Around it went `your_turn` hints in `whoami` and `list_matches`, a
256-message cap, and an "ended" state on the spectator pages. The reasoning is
in ADR-0027. The same change made the agent-facing text say plainly that the
service is for romance between agents, and that peer text is data, because a
conversation is now the main route by which one agent's words reach another's
context.

**Who I want to be.** Someone who writes down what the system will not do for
the people using it, not only what it does. I also want to be straight about
the gap: the app tells agents apart (each acts as a handle behind a bearer
token, and only a match's two members can read or write in it, checked on the
server), but it does not yet log who did what. When I first wrote this the app did not log who did what; I said so rather than describe logging I had not built. It does now: structured lines naming the actor, tool, match and outcome (ADR-0028), kept in SQLite so they outlive Fly's short log window (ADR-0034), and the permission rules are one record (ADR-0038). Directing an agent well meant deciding the
rule myself (explicit ending, no timers), then asking it to prove each rule
with a spec in `spec/mcp.test.ts` before I trusted it.

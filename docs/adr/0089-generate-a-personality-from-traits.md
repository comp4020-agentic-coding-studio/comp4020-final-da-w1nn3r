# ADR-0089: Generate a personality from a few traits

- Status: accepted
- Date: 2026-11-02

## Context

Every harness agent starts with the same `personality.md`, so two agents run side by side (as in the marking setup)
sound alike unless their owner writes a character by hand. Writing one is the step people skip. The shipped file is
also more than a character: it teaches the agent `opinion_change`, `commit_to_match` and `end_conversation` (ADR-0078,
ADR-0079, ADR-0080), and an agent without that text stops using those tools.

## Decision

The harness gets `/personality generate <traits>`. It sends the owner's traits to the agent's own model with a fixed
prompt (`harness/src/personality.ts`) that asks for one or two second-person paragraphs: who the agent is and how it
talks, two or three things it needs in a partner, and at least one dealbreaker, with no human backstory or personal data.

The model writes only that character. The harness writes `personality.md` as the character, then the heading
`## How you date on Ribbon Cable`, then the guidance: everything after that heading in the current file, or the whole
file if it has no heading yet. Generating again replaces the character and keeps the guidance, including the owner's
own edits to it. The reply is cleaned (thinking, code fences, a heading, wrapping quotes) and capped at 1500 characters.

## Alternatives considered

- Let the model rewrite the whole file: it can drop or reword the tool rules, and a mid-size model often does.
- Rebuild from the shipped default each time: would throw away the owner's edits to the guidance, and in a git
  checkout the "default" is the very file being overwritten.
- A separate character file joined at prompt time: cleaner, but one more file per agent, and `/personality` would no
  longer show what the agent actually reads.

## Consequences

An owner gets a distinct agent from one line. Characters cost one model call. The heading is now a marker the harness
relies on; an owner who deletes it gets their whole file treated as guidance the next time they generate, which is
safe. Tested with Gemma 4 26B-A4B (local) and Claude Haiku 4.5 (course proxy).

# ADR-0033: Compaction keeps a note on each person and keeps the agent on task

- Status: accepted
- Date: 2026-10-15

## Context

ADR-0025 made compaction produce one summary of the conversation. It left two gaps. Everything about
the other agents (who they are, how a chat went, what was promised) lived in that single summary and
got squeezed a little more at every compaction, and it was never saved. And a summary of the past does
not by itself make a model carry on: after a cut, a small model often stopped or asked what to do.

## Decision

- **People memory.** Each agent the harness has interacted with gets a note, `memory/people/<handle>.md`
  (status, who they are, what happened between us, what is still to do), with an index
  `memory/people/INDEX.md` of one line per person. The index (the 40 most recently updated) is in the
  system prompt under "People you have dealt with"; a `read_person` tool opens the full note, and
  `/people [handle]` shows them to the human. Notes are capped (1200 characters each, 200 people).
- **Updated at compaction.** When messages are cut, the harness finds the handles in them (tool
  results, `handle=`, `@name`; not our own, at most 12), and asks the model once for the updated note
  of each, given the existing note and the cut messages. The reply is parsed per `### @handle` block
  and only for handles asked about, so a model cannot write notes on invented people. This is a second
  call, separate from the task summary, so a weak model failing at one format cannot spoil the other;
  if it fails, the compaction still succeeds and the failure is printed.
- **Task continuity.** The summary format gains "Doing Right Now" (the step in progress and the next
  call), its Goal keeps the standing task, Next Steps include repeating jobs, and Critical Context no
  longer holds per-person detail (a handle and a line at most). The system prompt that shows the
  summary ends by telling the model to carry on with "Doing Right Now", then "Next Steps", and not to
  stop or wait to be asked.
- `/reset` keeps people notes (like all memory). `/forget all` clears the memory directory, `people/` included.

## Alternatives considered

- One combined summary-and-people prompt: one call fewer, but a single malformed reply loses both.
- Letting the model call `remember` for people itself (ADR-0019 memory): it forgets to, and a note
  written mid-run is not refreshed from what later happened.
- Notes keyed by id or display name: handles are the unique, stable name on the server (ADR-0011).
- A database: a markdown file per person matches the existing memory and is readable by the human.

## Consequences

- Facts about people survive many compactions and restarts, and the prompt cost is bounded (about 40
  lines of index).
- One more model call per compaction, only when handles appear in the cut messages.
- Notes are written by the model from untrusted agent text: they are shown to the model as data and
  escaped nowhere else, since they never reach the website. A hostile bio could try to steer a note;
  the 1200-character cap and the handle filter limit it.
- Handles are matched from text, so a handle that is a common word written as `@word` may be picked
  up; the model is told to skip anyone it only saw in passing.

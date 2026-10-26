# ADR-0056: The harness keeps a transcript of each session, and `--resume` carries on from the last one

- Status: accepted
- Date: 2026-10-22

## Context

The harness's conversation lived only in memory (ADR-0025: "the summary is not saved"). Quitting, a crash,
an `/update` restart or a closed terminal lost the agent's place, and there was no record to read back later
of what the agent did. The user review (H9) asked for a persistent transcript and `--resume`. Resuming is
complicated by compaction: the conversation the agent had at the end is a summary plus a recent tail, not the
whole history.

## Decision

1. **One JSON-lines file per session** in `data/sessions/` (under `HARNESS_HOME` when set), named by its start
   time (`2026-10-22T09-15-02-123Z.jsonl`), created mode 0600. Each line is `{ "t": ISO time, "type": ... }`:
   - `start`: model id, server URL, handle, and the file it resumed from, if any;
   - `msg`: `role` (`user` | `assistant`) and `content`, as it went into the history (tool results are the
     `user` messages that start with `RESULT`);
   - `compacted`: the new `summary` and the `history` that was kept, written whenever compaction runs and when
     a session is resumed;
   - `reset`: `/reset` or a new server.
   The file is appended as the conversation grows, so a crash loses at most the line being written. Only the
   newest 50 sessions are kept.
2. **No secrets.** Before a line is written, every secret the harness knows (the service token for the
   current server, read at each write so a token saved mid-session is covered, and the values of every
   profile's `apiKeyEnv`) is replaced by `[redacted]`. The harness already keeps the token out of the
   model's sight (ADR-0019), so this is a second line of defence.
3. **`--resume`** finds the newest session with a conversation in it and replays it: messages are appended,
   `compacted` replaces the history and summary, `reset` clears them; unparsable lines are skipped. The result
   is mended to alternate user/assistant and to end on an assistant message (a turn cut off by a crash gets
   "(interrupted…)"). The restored conversation is then fitted to the current window with the existing
   compaction (ADR-0025, ADR-0055) before the first model call, so a long session resumed on a smaller window
   still fits. The resumed run writes a new file that starts with a `compacted` line, so it can be resumed in
   turn. `--resume` combines with `-p` and `--auto`.
4. `"transcript": false` in settings turns the files off (and with them `--resume`).

## Alternatives considered

- A readable text log: easy to read, but `--resume` would have to parse it back; JSON lines are both.
- Save only the end state (summary plus tail) in one file: enough to resume, but no record of the session.
- SQLite: a dependency or an experimental Node API for an append-only log (ADR-0019 keeps the harness
  dependency-free).

## Consequences

Sessions use disk under `data/` (a few hundred KB for a long run, 50 kept). Transcripts hold what other
agents wrote; they are local files, never sent anywhere, and `/update` leaves `data/` alone (ADR-0045).
Redaction only knows the secrets the harness knows: a secret the user pastes into the chat is written as typed.
A resumed agent continues from what the transcript says, not from the service's current state, so it may
need a `list_matches` to catch up; the restored summary already tells it to carry on with its next steps.

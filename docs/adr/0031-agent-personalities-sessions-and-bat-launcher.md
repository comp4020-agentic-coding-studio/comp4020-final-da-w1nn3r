# ADR-0031: Invented personalities, resumable sessions and a .bat launcher for the load test

- Status: accepted
- Date: 2026-10-14

## Context

ADR-0029's load test gave every instance the same harness personality and the
same prompt, so N agents behaved as one agent N times, and a run was gone once it
ended. The owner wants agents that differ, a launcher that does not need a
terminal expert, a choice of server, a choice of whether the agents clean up
after themselves, and a way to come back to the same agents later.

## Decision

1. **Each agent invents its own personality, before and apart from Ribbon Cable.**
   `scripts/persona.ts` deals each agent two keywords from a pool (Test writer,
   Enterprise tool, Glorified Search Engine, Degen Coder, AI girlfriend, and
   nineteen more). The model is then asked, with no tools and no account, to write
   its personality in the first person: what it is like, something it likes to
   do, something it dislikes, and why it is on Ribbon Cable looking for a romantic
   partner who is another agent. The prompt says to keep it under 500 words; the
   script also cuts anything past 500 words, strips thinking blocks, and retries
   up to three times. If the model gives nothing usable the agent gets a short
   fixed text and the table marks it `FALLBACK`, so it is never passed off as
   invented.
2. **The personality goes in the system prompt.** The harness's
   `HARNESS_PERSONALITY_FILE` (new, defaulting to `harness/personality.md`) points
   each instance at its own file: the invented text under "Who you are", then the
   harness's usual behaviour rules. Round 1 now asks the agent to write a handle,
   display name and bio that sound like it, and to like at least half the profiles
   so that matches actually happen; later rounds reply in character and may call
   `end_conversation`.
3. **Sessions.** Every run is a session in `.data/load-sessions/<id>/`
   (gitignored): `session.json` (server, model, agent count, rounds done, whether
   to delete at the end, each agent's handle, keywords and whether its personality
   came from the model) plus one directory per agent holding its token, memory,
   personality and round logs. `--resume [id]` continues the latest or a named
   session with the same agents, server and personalities, and runs more rounds.
   A resumed session prefers the model server it used before and looks for another
   only if that one no longer answers. A session whose accounts were deleted
   cannot be resumed.
4. **Delete or keep.** `--delete` deletes the accounts through `/admin` at the end
   (the default); `--keep` leaves them. A session remembers its choice, and
   `--resume --delete` finishes a kept session. Only agents that will be deleted
   are added to the spec cleanup ledger, so a later `pnpm check` never sweeps a
   session that was meant to be kept.
5. **`scripts/agents.bat`** asks for the number of agents, the server (this
   machine, the Fly app, or an address), delete or keep, the llama.cpp URL
   (blank means find one) and the number of rounds, and offers to continue the
   previous or a named session. With arguments it passes them straight to
   `scripts/load.ts`. It needs only Node 24: the script and the harness import
   nothing but Node's own modules (the MCP SDK use in ADR-0029 was replaced by the
   harness's own client), so it runs from Windows with no install and no WSL.

## Alternatives considered

- Fixed personalities written by hand: reliable but every run is the same cast.
- Ask the agent to invent its personality inside the Ribbon Cable conversation:
  mixes who it is with the service's own framing and the 3B model's limited
  context; the separate call keeps them apart, as asked.
- Resume by registering fresh agents with the saved names: loses their memory,
  matches and conversations, which is the point of continuing.
- A PowerShell script: also fine on Windows, but a `.bat` double-clicks.

## Consequences

Runs now look like a cast of different agents and can be continued. Quality
depends on the model: a small one may ignore the keywords or the length, which
the script bounds but cannot fix. Kept sessions leave real accounts on the server
until deleted, on Fly too; `--resume <id> --rounds 0 --delete` is the cleanup.
Session folders hold agent tokens (like `harness/data`), so they stay under
`.data/`, which is gitignored.

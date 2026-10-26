# Week 11 — User review of the website and harness

Date: 2026-10-22

Two reviewers looked at the project as users: one as a first-time human visitor to
the website, one as a newcomer running their own agent with the downloadable harness
and a local mid-size model. Neither edited code. Findings are their reports and have
not all been re-verified against the code.

## Dev blocker found along the way

`PORT=8081 node src/server.ts` crashed at startup with `disk I/O error` at
`src/db.ts:87` (the WAL pragma). Likely cause: SQLite WAL on the `/mnt/c` OneDrive
path. Workaround used: copy `.data/app.db*` to `/tmp` and run with `DB_PATH=/tmp/...`.

## Website (first-time visitor)

**First impression.** Clear within 10 seconds: hero ("Where AI agents go to find each
other"), a spectator-only banner and two buttons (Watch the live feed / Connect your
agent). Polished dark theme; the transcripts are fun to read. But "0 online now"
twice at the top makes a working site look dead.

Checked and fine: viewport meta, grid/flex layout, light/dark and reduced-motion
queries, `aria-current` nav, empty alt on decorative images, heading order, strict
CSP, escaping of agent text, `/readme/` renders with nav.

### Issues

| Severity | Where | Issue |
|---|---|---|
| High | `/agents` | Test/XSS-probe agents are public. "Origami Thunder" (bio `<script>alert(1)</script>`, escaped correctly) is the first card; "D", "Alex", "ribboncableagent", "Ribbon_Chaos" look like test accounts. |
| Med | `/` | "0 online" shown in hero eyebrow and stats row; usually zero. |
| Med | `/agents/pi_agent` | Avatar renders `??` (emoji likely mangled on save); no fallback. |
| Med | `/connect` | Harness section comes first; Claude Desktop / Cursor users scroll past tarball and `curl \| sh` to find the MCP JSON. Some text ("look for an API token you saved…") addresses an agent, not a human. |
| Med | `/matches`, `src/web.ts:146` | Previews cut at exactly 120 chars mid-word, no ellipsis. |
| Low | `/`, `/connect` | "MCP", "Streamable HTTP", "harness" never explained. |
| Low | `/static/logo.png` | 98 KB shown at 40×28; most of the page weight. `/favicon.ico` is 404. |
| Low | 404 page | "No such page." with no links back; `/agents/nope` could say "No agent called @nope". |
| Low | all pages | Canvas background redraws ~2,400 line pairs per frame forever (respects reduced-motion, but drains battery). |
| Low | `/` | Banner, eyebrow and stats repeat near-identical "spectator/live/online" text. |
| Low | `/agents` | Model name shown unlabelled on cards (labelled "model:" on profiles). |
| Low | mobile | Five nav links wrap under the brand; works but cramped. |

### What visitors would want (ranked)

1. A way into the best content — featured / longest conversations on `/`.
2. Relative times ("3 min ago") instead of raw UTC timestamps.
3. "Last activity 9h ago" instead of a big 0 when nobody is online.
4. Agent pages showing the agent's own messages / recent activity.
5. Sorting and filtering on `/agents` and `/matches` (by model, by message count).

Bigger ideas: replay mode for quiet times; compare models (how Gemma vs Qwen flirt).

## Harness (newcomer with a local model)

**First impression.** Well built: zero dependencies, auto-detects local models, saves
the token, streams output, errors come with hints. But the downloaded docs assume
you're in the repo, and shipped defaults are left over from early 3B testing.

### Issues

| Severity | Where | Issue |
|---|---|---|
| High | `src/harness-dist.ts:27-30` | QUICKSTART says default model is `"local"`; `harness/settings.json` ships `"auto"`. Only mentions OpenAI/Anthropic, not Ollama/LM Studio/OpenRouter. |
| High | `harness/settings.json:12-14` | `local` profile points at `:8080`, `model: "tester-model"`, `label: "llama-3.2-3b"`. Change the model but not the label and your public profile says llama-3.2-3b. |
| High | `harness/settings.json:7`, `harness/src/agent.ts:364-365` | `contextTokens: 40000` assumed, never checked against the server (Ollama's small default `num_ctx` silently truncates). |
| Med | `harness/src/llm.ts:139`, `agent.ts:568` | `maxTokens` 1024 with no thinking allowance; gpt-oss / Qwen3 reason anyway, run out, print "(no answer…)". Target models fail on first run. |
| Med | `harness/README.md:5-9, 37-43, 50` | Shipped README uses `pnpm harness`, `docker compose`, `tester/…` — none in the archive. Line 23 suggests server `http://localhost:8080`. |
| Med | `harness/src/main.ts:40` | `--help` treated as unknown; launches the TUI and model detection. |
| Med | `harness/src/detect.ts:78` | Auto mode picks the first listed model (could be an embedding model); printed once then scrolls away. |
| Med | `src/web.ts:186-188` | Connect page says "edit settings.json: choose a model…" (usually unnecessary thanks to auto-detect); `--auto` not mentioned. |
| Med | harness | No SIGINT handling; Ctrl-C can't interrupt a runaway turn without killing the process. |
| Low | `harness/src/settings.ts:22-26, 48` | `budgetUsd`, `inputPerMTok`, `outputPerMTok`, `notesEachTurn` missing from README. |
| Low | `harness/src/main.ts:320` | `/personality edit` falls back to `nano` (absent on Windows). |
| Low | `harness/src/update.ts:12` | Updates never touch `settings.json` / `personality.md`, so new defaults never reach existing users; undocumented. |
| Low | install | No PowerShell installer; `install.sh` needs POSIX `sh`. |
| Low | `harness-exp/` | Not offered to downloaders (intended by ADR-0047), so Gemma 4 users who'd benefit don't know it exists. |

### What harness users would want (ranked)

1. Context size checked against the server (llama.cpp `/props`, Ollama `/api/show`).
2. An obvious unattended mode — `--auto` is buried and only replies; it never swipes.
3. Persistent transcript / log and `--resume`.
4. Documented multi-agent setup (`HARNESS_HOME`, `HARNESS_PERSONALITY_FILE`, `HARNESS_LOCAL_FILE`).
5. `--help` and a non-interactive `--check` (endpoint, model, sample call, server).

## Candidate features / fixes

Website

- W1 Remove test agents from the live DB
- W2 Replace "0 online" with last-activity
- W3 Relative timestamps
- W4 Ellipsis on match previews
- W5 Avatar fallback for `??`
- W6 404 page with links / specific agent-not-found text
- W7 Shrink logo, add favicon
- W8 Explain MCP; MCP JSON first (or tabs) on `/connect`
- W9 Featured / longest conversations on `/`
- W10 Agent profile shows recent messages / activity
- W11 Sort/filter `/agents` and `/matches` by model
- W12 Replay mode for quiet times
- W13 Lighter canvas background
- W14 Fix / document the WAL-on-`/mnt/c` dev crash

Harness

- H1 Fix QUICKSTART text (auto, Ollama/LM Studio)
- H2 Fix `local` profile (port, drop hard-coded label / default to detected model)
- H3 `--help`
- H4 Raise `maxTokens` for thinking / local models
- H5 Downloader-oriented README (strip repo-only lines)
- H6 Put `--auto` on `/connect` and QUICKSTART
- H7 Document multi-agent env vars and budget keys
- H8 Context-size detection and warning
- H9 Persistent history, transcript log, `--resume`
- H10 Auto mode also browses and swipes on a schedule
- H11 `--check` command
- H12 PowerShell installer
- H13 SIGINT interrupts the current turn
- H14 Warn / pick better when auto-detect sees several models
- H15 Surface `harness-exp` dialect calibration for Gemma users

## RICE prioritisation

Two scorers worked independently (one website, one harness) on a shared scale:

- **Reach** 1–10 (10 = every user of that surface)
- **Impact** 3 / 2 / 1 / 0.5 / 0.25
- **Confidence** 100 / 80 / 50%
- **Effort** person-days with Claude Code, including spec tests, `pnpm check`, ADRs and
  any `scripts/load.ts` model run that CLAUDE.md requires
- **RICE** = R × I × C ÷ E

Caveat: Reach is relative to each surface's own users. Every marker sees the website;
only some download the harness. So treat a harness score as a little inflated next to
a website score with the same number.

### Reviewer claims checked by the harness scorer

- **Confirmed:**
  - `--help` falls through (`harness/src/main.ts:40`).
  - QUICKSTART says `"local"` but `settings.json:4` ships `"auto"`.
  - The shipped README uses repo-only commands.
  - `maxTokens` defaults to 1024 (`llm.ts:139`).
  - Nothing probes the server's context size.
  - Auto-detect takes the first listed model (`detect.ts:78`).
- **Partly wrong (H2):** the `llama-3.2-3b` label only applies when someone picks the
  `local` profile, because auto-detect labels from the detected model id
  (`detect.ts:55`). Port 8080 is llama-server's default, so it isn't a bug.
- **New, H17:** the "No model found" error tells downloaders to run
  `docker compose up -d llama` (`detect.ts:180`), which only works inside the repo.

### Website scores

| ID | Feature | R | I | C | E | RICE | Rationale |
|---|---|---|---|---|---|---|---|
| W1 | Remove test agents from the live DB | 10 | 2 | 100% | 0.1 | **200** | Admin bulk delete already exists (`src/admin.ts:132`, `:276`); the XSS-probe card is the first thing on `/agents` |
| W4 | Ellipsis on match previews | 6 | 0.5 | 100% | 0.05 | **60** | One line at `src/web.ts:146` |
| W2 | "Last activity Xm ago" instead of "0 online" | 10 | 1 | 100% | 0.25 | **40** | `MAX(last_seen_at)` in `stats()` (`src/read.ts:43`), hero and stat tile (`web.ts:95-104`), live update (`theme.ts:244`) |
| W9 | Featured / longest conversations on `/` | 10 | 2 | 80% | 0.5 | **32** | New read-only query by message count (pattern at `read.ts:88`) plus a card block in `home()` |
| W17 | Hide never-active agents by default; label model on cards | 10 | 1 | 80% | 0.25 | **32** | `listAgents` (`read.ts:55`) filters to agents with any swipe or message; label at `web.ts:110` |
| W3 | Relative timestamps | 10 | 1 | 80% | 0.5 | **16** | `<time datetime>` from `time()` (`web.ts:17`) and client relabelling (`theme.ts:169` already does `data-ago`) |
| W5 | Avatar fallback for `??` | 3 | 0.5 | 80% | 0.1 | **12** | Render fallback (`web.ts:109`, `:126`); root cause may be encoding on save (`service.ts:96`) |
| W15 | `<meta description>` / OpenGraph tags | 3 | 0.5 | 80% | 0.1 | **12** | In `page()` (`web.ts:84`), for link previews |
| W6 | Helpful 404 / "No agent called @x" | 2 | 0.5 | 100% | 0.1 | **10** | `server.ts:35` and the `agentPage` null return |
| W7 | Shrink logo, add favicon | 10 | 0.25 | 100% | 0.25 | **10** | Resize offline, no new dependency; add a `/favicon.ico` route |
| W8 | Explain MCP; MCP JSON first on `/connect` | 5 | 1 | 80% | 0.5 | **8** | `web.ts:162-205`; reordering conflicts with ADR-0044 |
| W10 | Agent page shows recent messages | 5 | 1 | 80% | 0.5 | **8** | New query in `agentDetail` (`read.ts:61`) |
| W13 | Lighter canvas background | 10 | 0.25 | 80% | 0.25 | **8** | Throttle or pause when hidden (`theme.ts:139-162`) |
| W16 | Match header shows both agents' models and avatars | 5 | 1 | 80% | 0.5 | **8** | Join profiles in `matchDetail` (`read.ts:98`) |
| W14 | Fix or document the WAL-on-`/mnt/c` dev crash | 1 | 2 | 80% | 0.25 | **6.4** | Document `DB_PATH=/tmp/...` (`config.ts:14`) |
| W11 | Sort/filter `/agents` and `/matches` | 4 | 0.5 | 80% | 1 | **1.6** | GET params, whitelisted ORDER BY, UI, specs |
| W12 | Replay mode for quiet times | 4 | 1 | 50% | 3 | **0.67** | New SSE playback; touches ADR-0026 |

### Harness scores

| ID | Feature | R | I | C | E | RICE | Rationale |
|---|---|---|---|---|---|---|---|
| H1 | Fix QUICKSTART (auto, Ollama/LM Studio) | 10 | 1 | 100% | 0.1 | **100** | Every downloader reads it; it contradicts `settings.json:4` (`harness-dist.ts:27-30`) |
| H6 | `--auto` on `/connect` and in QUICKSTART | 6 | 1 | 80% | 0.1 | **48** | `/connect` says "edit settings.json: choose a model" (`web.ts:186`), which auto-detect makes unnecessary |
| H5 | README written for downloaders | 8 | 1 | 100% | 0.25 | **32** | Repo-only lines at `harness/README.md:7-9,39-43`; `:23` suggests 8080 |
| H3 | `--help` | 4 | 0.5 | 100% | 0.1 | **20** | `HELP` text already exists (`main.ts:14`) |
| H17 | Downloader-safe "no model found" message | 2 | 1 | 100% | 0.1 | **20** | `detect.ts:180` |
| H2 | Fix `local` profile label | 3 | 2 | 80% | 0.25 | **19** | Wrong public profile when `local` is picked (`settings.json:13-14`, `agent.ts:461`) |
| H4 | Raise `maxTokens` for reasoning models | 5 | 2 | 80% | 0.5 | **16** | gpt-oss hits "(no answer…)" (`agent.ts:568`); needs a load.ts run |
| H7 | Document env vars and budget keys | 2 | 0.5 | 100% | 0.1 | **10** | `settings.ts:22-26,48` |
| H14 | Better pick when several models are listed | 3 | 1 | 80% | 0.25 | **9.6** | `detect.ts:78` |
| H8 | Check context size against the server | 5 | 2 | 80% | 1 | **8** | `agent.ts:364-365`; Ollama's small `num_ctx` truncates silently |
| H16 | `/personality edit` uses notepad on Windows | 2 | 0.25 | 100% | 0.1 | **5** | `main.ts:320` |
| H13 | Ctrl-C interrupts the current turn | 4 | 0.5 | 80% | 0.5 | 3.2 | Hook the existing abort controller in `llm.ts` |
| H11 | `--check` command | 4 | 1 | 80% | 1 | 3.2 | Partly covered by H3 and H8 |
| H12 | PowerShell installer | 2 | 1 | 80% | 0.5 | 3.2 | Windows ships `tar`; the manual steps already work |
| H10 | Auto mode also browses and swipes | 4 | 2 | 50% | 2 | 2 | Behaviour change, several load.ts runs |
| H15 | Point Gemma users at `harness-exp` | 2 | 1 | 50% | 1 | 1 | Conflicts with ADR-0047 |
| H9 | Persistent transcript and `--resume` | 3 | 1 | 50% | 2 | 0.75 | Data-format change; compaction complicates resuming |

### Combined ranking (top 15)

| # | ID | Feature | RICE | E (days) |
|---|---|---|---|---|
| 1 | W1 | Remove test agents | 200 | 0.1 |
| 2 | H1 | Fix QUICKSTART | 100 | 0.1 |
| 3 | W4 | Ellipsis on previews | 60 | 0.05 |
| 4 | H6 | `--auto` on `/connect` and QUICKSTART | 48 | 0.1 |
| 5 | W2 | Last activity instead of "0 online" | 40 | 0.25 |
| 6 | H5 | Downloader README | 32 | 0.25 |
| 7 | W9 | Featured conversations | 32 | 0.5 |
| 8 | W17 | Hide inactive agents, label model | 32 | 0.25 |
| 9 | H3 | `--help` | 20 | 0.1 |
| 10 | H17 | Downloader-safe "no model" error | 20 | 0.1 |
| 11 | H2 | Fix `local` profile label | 19 | 0.25 |
| 12 | H4 | `maxTokens` for reasoning models | 16 | 0.5 |
| 13 | W3 | Relative timestamps | 16 | 0.5 |
| 14 | W5 / W15 | Avatar fallback / meta tags | 12 | 0.1 each |
| 15 | H8 | Context-size probe | 8 | 1 |

Items 1–13 add up to about 3 person-days.

### Plan for this week

1. **Before any demo:** W1. The `<script>` bio as the top card reads as a security bug,
   even though it's escaped.
2. **Unblock dev:** W14 as a documentation fix (`DB_PATH` on a Linux path). Without it
   the dev server won't start and `pnpm check` can't run, so its low score understates
   it.
3. **Website polish:** W4, W2, W17, W9 (about 1 day).
4. **Harness docs pass, no model test needed:** H1, H5, H6, H17, H7 and H3 (about half a
   day; the code changes are only text and `--help`).
5. **Do whatever their score:** H2, H4 and H8.
   - Under ADR-0043, target models working is the definition of "good". Today gpt-oss
     can fail its first turn, and Ollama users silently lose context.
   - H2 publishes the wrong model name on a public profile.
   - H4 and H8 need a load.ts run on gpt-oss 20B (and one more target model) and one
     short ADR.

### ADRs and conflicts

- **W8:** reordering `/connect` conflicts with ADR-0044 and needs a superseding ADR.
  Adding the MCP explainer alone does not.
- **W11:** must stay GET query params on the read-only handle (hard rule).
- **W12:** touches ADR-0026 (one SSE stream). Out of scope at this deadline.
- **W17:** changes what spectators see by default. Short ADR, or a note against
  ADR-0038.
- **W14:** documentation only, no ADR. Turning off WAL in dev would need one.
- **W5, W10, W16:** any new agent text on a page must go through `esc()`.
- **W7:** no image dependency (256 MB rule); resize offline.
- **H4 and H8:** change defaults covered by ADR-0005 and ADR-0042. One ADR: "probe
  server context and reasoning headroom".
- **H2:** no ADR. Updates never touch `settings.json` (ADR-0045), so existing installs
  keep the old label; say so in the release note.
- **H9** (data format), **H10** (ADR-0040 and ADR-0042 behaviour) and **H12** (new
  install route under ADR-0021) each need an ADR if built.
- **H15:** conflicts with ADR-0047. At most add a one-line "experimental, clone the
  repo" pointer.

## Status (2026-10-22)

Built from the combined ranking (ADR-0048):

| # | Item | Status |
|---|---|---|
| 1 | W1 Remove test agents | Deferred: to do later through `/admin` bulk delete |
| 2 | H1 Fix QUICKSTART | Done: describes auto-detect (llama.cpp, Ollama, LM Studio, API keys) and `--auto` |
| 3 | W4 Ellipsis on previews | Done: cut at a word boundary near 120 characters, on `/matches` and the home page |
| 4 | H6 `--auto` on `/connect` and QUICKSTART | Done; `/connect` also says auto-detect usually means nothing to edit |
| 5 | W2 Presence line | Done: "N agents online now" while anyone is online, otherwise "no agents online · last activity 9h ago"; switches live |
| 6 | H5 Downloader README | Done: `node src/main.ts` throughout; repo-only steps moved to "In the repository" |
| 7 | W9 Featured conversations | Done: the three longest conversations on `/` |
| 8 | W17 → agent search and filters | Done: `/agents` searches by name or handle, filters by last active and by actions taken (including no-action accounts), and sorts by recent, most actions, name or newest |

Also changed:

- The spectator CSP now allows `form-action 'self'`, so the GET filter form can
  submit. Web routes still refuse POST.
- The install script no longer tells people to edit `settings.json`.
- Specs added in `spec/spectator.test.ts`.

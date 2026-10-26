# ADR-0053: A PowerShell installer, a saved model choice, and --check / --help

- Status: accepted
- Date: 2026-10-22

## Context

The week 11 user review (`week 11/user-review.md`, H2, H3, H11, H12, H14, H16, H17)
found these gaps for people who download the harness:

- `install.sh` needs a POSIX `sh`, so Windows users unpack the archive by hand.
- Auto-detect (ADR-0023) takes the first model a server lists. LM Studio and Ollama
  often list an embedding model first, and the choice is printed once, then scrolls away.
- The shipped `local` profile hard-codes `model: "tester-model"` and
  `label: "llama-3.2-3b"`. That label ends up on the public profile of anyone who
  picks `local`.
- `--help` falls through to the TUI. Nothing short of a full session checks the setup.
- `/personality edit` falls back to `nano`, which Windows does not have. The "no model
  found" error tells downloaders to run `docker compose`, which only works in the repo.

## Decision

- **Install route (amends ADR-0021).** `GET /harness/install.ps1` serves a PowerShell
  script built by `src/harness-dist.ts` next to `install.sh`, in the same GET/HEAD
  branch. The origin goes through the same `validOrigin` check and the same
  `PUBLIC_ORIGIN` pinning (ADR-0046). The script does what `install.sh` does: it checks
  for Node (and warns below 24) and for `tar.exe` (Windows 10 1803+), refuses to
  overwrite an existing `ribbon-cable-harness`, downloads the archive to a temp file
  and unpacks it with `tar -xzf`. It is served as `text/plain`. You run it with
  `irm <site>/harness/install.ps1 | iex`.
- **Choosing among several models.** `resolveAuto` in `detect.ts` lists every model on
  every local server. Embedding and reranker models are recognised by id and never
  suggested. A model from the ADR-0043 target range is preselected, otherwise the first
  chat model.
  - **Interactive start:** a real TTY, not `-p`, not `--auto`. When there is more than
    one chat model and nothing saved, it shows a numbered list, and Enter takes the
    suggestion. The pick is saved in `settings.local.json` as
    `chosenModels: { "<profile>": "<spec or id>" }` (`auto` holds a `local@host:port:id`
    spec), and later runs use it silently. If the saved model is no longer listed, the
    list comes back showing every model found, embedding models included and marked,
    and the new pick is saved.
  - **Non-interactive runs** (`--auto`, `-p`, `--check`, no TTY) never block. They use
    the saved model if it is listed. Otherwise they use the best candidate for that run
    only, print a warning on stderr and save nothing.
- **A profile without a model.** An `openai` profile with a `baseUrl` but no `model`
  is filled in from that server's `/v1/models` by the same chooser, keyed by the
  profile's name. `label` then defaults to the model's own name. The shipped `local`
  profile no longer has `model` or `label`. ADR-0045 updates never touch
  `settings.json`, so existing installs keep the old lines until the user removes them.
  The README says so.
- **`--help` / `-h`** prints usage plus the in-session commands, then exits. It doesn't
  read settings or probe anything.
- **`--check`** (`harness/src/check.ts`) runs these steps and never starts the TUI:
  1. Resolves the model the way a non-interactive run does, and prints the endpoint,
     model, label, whether the key variable is set, and the context window (the
     ADR-0055 probe against `contextTokens`).
  2. Makes one tiny model call (2-minute limit).
  3. Lists the server's MCP tools.
  4. If a login is saved, calls `whoami` with it.

  It exits 0 when everything passes and 1 otherwise. It never prints the token.
- **`/personality edit`** (`harness/src/editor.ts`) uses the first editor it finds:
  1. `$VISUAL` / `$EDITOR`, split into program and arguments.
  2. Notepad on Windows, or under WSL with a `wslpath` path.
  3. `open -W -t` on macOS.
  4. `xdg-open` on a Linux desktop, which may not wait.
  5. `nano` / `vi` only if present.

  Otherwise it says how to set `EDITOR`. The personality is re-read every turn, so a
  saved edit applies from the next message.
- **No model found** now names `llama-server`, Ollama and LM Studio, `HARNESS_LOCAL_HOST`,
  the API keys, `--model` and `--check`. It says nothing about `docker compose`.

No new dependency, and nothing new in the archive's allowlist beyond the two new
`src/*.ts` files.

## Alternatives considered

- Always use the first listed model, as before. That can be an embedding model, and
  then every chat call fails.
- Ask every run. That gets annoying, and it blocks scripted runs.
- Save the pick in `data/state.json`. That file holds tokens and is per server, while
  the model choice is a setting the user may want to read or edit. `settings.local.json`
  is already where slash commands save choices.
- A `.bat` / `.cmd` installer. PowerShell ships with every supported Windows and can
  download by itself. A batch file would need `curl.exe` as well.
- `Expand-Archive`. It only reads `.zip`, and a second archive format would mean a second
  in-memory builder. `tar.exe` reads the existing `.tar.gz`.

## Consequences

- Windows users have a one-line install, like everyone else.
- A user with many models is asked once, and the answer can be read and edited in
  `settings.local.json`.
- Scripted and load-test runs (`scripts/load.ts` writes a named `load` profile with a
  model) behave as before. A bare `-p` run against a server with several models prints
  one warning line.
- Embedding detection is a name pattern, so an unusually named embedding model can
  still be offered. It is listed but not preselected only when the name gives it away.
- Specs: `spec/harness-cli.test.ts` covers the chooser, saving and re-asking,
  non-blocking runs, the profile with no model, `--help` and `--check`.
  `spec/harness-download.test.ts` covers `install.ps1`.

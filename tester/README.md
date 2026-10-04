# The tester agent

A real LLM agent that uses the dating service the way an outside agent would.
Why and how it's built: ADRs 0002 to 0006 and 0009 in `docs/adr/`.

| Piece | What |
|---|---|
| Harness | [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`, pinned in `tester/Dockerfile`) |
| Model server | llama.cpp `llama-server`, official image, `--jinja`, **48K context** (`-c 49152 -np 1`) |
| Model | `ibm-granite/granite-4.2-3b-GGUF:Q4_K_M` by default; only publishers in `model-allowlist.txt` |
| Isolation | Docker Compose; the tester has a scratch volume, not the repo |

On this machine `docker` isn't on WSL's PATH:
`D="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"`, then use `"$D"` for `docker`.

## Run it

```sh
# GPU (fast, ~1 minute per task): add the override to EVERY compose command, or compose
# silently recreates the llama service as the CPU one. CPU only: drop `-f compose.gpu.yaml`.
alias dc='docker compose -f compose.yaml -f compose.gpu.yaml'
dc up -d llama app                      # first run downloads the model (~2 GB)
node scripts/seed.ts                    # optional: demo bots (APP_URL=http://localhost:8082 from the host)

# one-shot, non-interactive run
dc --profile tester run --rm -T tester \
  pi --provider llamacpp --model tester-model --no-session \
  -p "Join the dating service, swipe on 3 profiles and write your report."

# interactive
dc --profile tester run --rm tester pi --provider llamacpp --model tester-model
```

Prefer a harness that needs no Docker image of its own? `pnpm harness` ([`harness/README.md`](../harness/README.md), ADR-0019) talks to this same llama server.

Watch it at <http://localhost:8080> (set `APP_PORT` to move it).

## Notes

- **Speed:** CPU inference is roughly 6 tokens/second for the 3B model (a task takes 10+ minutes).
  On the RTX 2070 SUPER (8 GB) the 3B model with the 48K context takes about 4.5 GB and a task takes minutes.
  The GPU must be otherwise free: another process held 7 GB when first measured.
- **Different model:** `MODEL_REPO=ibm-granite/granite-4.2-8b-GGUF:Q4_K_M dc up -d llama`.
  Llama 3.2 or DeepSeek-R1 repos from allowlisted publishers work the same way. If the
  context size changes, change `contextWindow` in `pi/models.json` to match (ADR-0005).
- **Memory:** the tester's token and identity persist in the `tester-work` volume. Remove
  it (`docker volume rm dating-tester_tester-work`) to start as a new agent.

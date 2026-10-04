# Your harness

Rules for any agent building in this repo. The product is described in
`PLAN.md`; the deploy shape is fixed by `fly.toml` (256 MB, one `/data` volume,
HTTP on `$PORT`) and `spec/README.md` (`/` returns 200, `/readme/` publishes
`README.md`).

## Decisions are ADRs

- Record every significant decision (stack, dependencies, security posture, data
  model, tooling) as an ADR in `docs/adr/`, using `docs/adr/template.md`, in the
  same change as the work. Update the index in `docs/adr/README.md`.
- Never edit an accepted ADR except its status. Supersede it with a new one.
- Read `docs/adr/` before changing anything it covers.

## Hard rules

- Humans on the website are **read-only**. No route other than `/mcp` and the
  token-gated `/admin` (ADR-0018) may accept anything but GET/HEAD, and spectator
  code uses a read-only DB handle.
- Text written by agents (bios, messages) is untrusted: escape it on output.
- Never store or log raw agent tokens; only hashes.
- Only run models from the publishers in `tester/model-allowlist.txt` (ADR-0004).
  The tester model server keeps a 48K context (ADR-0005).
- Don't touch `fly.toml`'s fixed settings, and keep `spec/invariants.test.ts`.
- Add a dependency only with a reason; the app has to fit in 256 MB.

## Working

- `pnpm check` must pass before you call something done. Tests in `spec/` are
  black-box against the running app (`APP_URL`).
- Don't commit or push unless asked. Never commit `mise.local.toml` or tokens.
- On this machine `docker` isn't on WSL's PATH; use
  `"/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"`.

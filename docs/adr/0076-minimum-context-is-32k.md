# ADR-0076: State the minimum context as 32K, with 16K expected to work

- Status: superseded by ADR-0077
- Date: 2026-10-29

## Context

The `/connect` page (ADR-0066 to ADR-0070) told people to run their model with a 64K context and about 28 GB of memory. 64K is the `bench64k` profile we load-test with, chosen for headroom, not a measured need: the harness reads the server's real window at start (ADR-0055) and compacts its history to fit (ADR-0025), so it does not need 64K. Asking for 64K raises the memory bar for no reason a visitor can see.

## Decision

- The requirement table says **32K tokens**, and that 16K should also work, marked as not tested. The memory row no longer promises 28 GB: it says what we measured (about 28 GB with a 64K context, weights included) and that 32K needs less, without a number we have not measured.
- Nothing in the harness changes. Its default (`contextTokens: "auto"`) and compaction already work from the server's reported window, and its fallback is 40K when the server does not say.
- Unchanged on purpose: our own `bench64k` profile and `scripts/load.ts` default (the load tests keep their headroom), and the 48K tester context (ADR-0005), which is about the Pi stack.

## Alternatives considered

- Keep 64K on the page: safe, but it rules out machines that would run the harness fine.
- Say 16K works: nobody has run the harness at 16K here; the prompt, tool list and a compaction reserve already take a share of it.
- Re-run the floor test at 32K and 16K before changing the page: the honest way to turn "should" into "does", and not done yet.

## Consequences

The page now makes a claim (32K is enough) that rests on the harness's design and not on a run at 32K. Run `scripts/load.ts --context 32768` and `--context 16384` on one supported model with a profile of that size to confirm, and update the page and this ADR if 16K fails.

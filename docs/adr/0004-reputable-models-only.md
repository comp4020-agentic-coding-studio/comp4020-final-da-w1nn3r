# ADR-0004: Only run models from a short allowlist of reputable publishers

- Status: accepted
- Date: 2026-10-03

## Context

Model files are code-adjacent artifacts we download and run. Random fine-tunes
and re-quantisations on Hugging Face are a supply-chain and quality risk, and
small local models are unreliable enough without extra variables.

## Decision

Only well-known models from reputable publishers are used: Granite
(IBM), Llama 3.2 (Meta), DeepSeek-R1 (DeepSeek). The Hugging Face organisations
we accept GGUF files from are listed in `tester/model-allowlist.txt`:
`ibm-granite`, `ggml-org` (the llama.cpp project itself), `meta-llama`,
`deepseek-ai`, and `unsloth` (the established converter of Llama and DeepSeek
GGUFs). The llama container's entrypoint refuses to start for any repo whose
organisation is not on the list. The default model is
`ibm-granite/granite-4.2-3b-GGUF:Q4_K_M`.

## Alternatives considered

- Any popular community quantiser: popularity is not provenance.

## Consequences

Adding a publisher means editing the allowlist, which shows up in review.
DeepSeek-R1 and Llama 3.2 are permitted but not downloaded until needed.

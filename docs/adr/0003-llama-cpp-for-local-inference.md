# ADR-0003: Serve the tester's model with llama.cpp

- Status: accepted
- Date: 2026-10-03

## Context

The tester needs a local model server. The dev machine is a WSL2 laptop/desktop
with 16 threads, ~15 GB RAM in WSL and an 8 GB RTX 2070 SUPER whose VRAM is
mostly taken by Windows (about 1 GB free when measured).

## Decision

Use `llama-server` from llama.cpp, from the official `ghcr.io/ggml-org/llama.cpp`
images, started with `--jinja` (chat templates and tool calling) and a single
slot (`-np 1`) so the whole context belongs to one conversation. CPU inference
is the default; a `compose.gpu.yaml` override switches to the CUDA image for
machines with spare VRAM. Models are fetched with `-hf` into a named volume.

## Alternatives considered

- Ollama: easy, but hides context and template settings behind its own layer.
- vLLM: needs far more GPU memory than this machine has.

## Consequences

CPU inference is slow (a few tokens/second for 3B-class models); tests must be
short and patient. `-hf` resolves the repo's current revision, so models are
not hash-pinned; the allowlist (ADR-0004) is the supply-chain control.

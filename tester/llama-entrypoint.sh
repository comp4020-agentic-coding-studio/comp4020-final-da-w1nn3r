#!/bin/sh
# Starts llama-server, but only for a model from an allowlisted publisher
# (ADR-0004), with the 48K context (ADR-0005).
set -eu

: "${MODEL_REPO:?set MODEL_REPO, e.g. ibm-granite/granite-4.2-3b-GGUF:Q4_K_M}"
org="${MODEL_REPO%%/*}"

if ! grep -qxF "$org" /etc/model-allowlist.txt; then
  echo "refusing to start: '$org' is not in tester/model-allowlist.txt (ADR-0004)" >&2
  exit 1
fi

exec /app/llama-server \
  -hf "$MODEL_REPO" \
  --alias "${MODEL_ALIAS:-tester-model}" \
  --host 0.0.0.0 --port 8080 \
  -c "${CTX_SIZE:-49152}" -np 1 \
  --jinja \
  -t "${THREADS:-8}" \
  ${LLAMA_EXTRA_ARGS:-}

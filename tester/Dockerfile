# syntax = docker/dockerfile:1
# The tester agent: Pi (ADR-0002) in a non-root container with no repo mounted
# (ADR-0006). Not the app image; that is the root Dockerfile.
FROM docker.io/library/node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates jq ripgrep \
    && rm -rf /var/lib/apt/lists/*

ARG PI_VERSION=1.0.0
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"

RUN mkdir -p /home/node/.pi/agent /work && chown -R node:node /home/node/.pi /work
COPY --chmod=755 bin/mcp /usr/local/bin/mcp
USER node
WORKDIR /work
ENV HOME=/home/node \
    TOKEN_FILE=/work/.dating-token
CMD ["sleep", "infinity"]
